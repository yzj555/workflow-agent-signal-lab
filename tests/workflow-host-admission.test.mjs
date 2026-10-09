import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowHostAdmission, HostAdmissionFull, collectHostRoleClaims, resolveHostAdmissionConfig,
  WorkflowTextController } from '../lib/workflow-control.js'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { memoryTable } from './helpers/workflow-fixture.mjs'

const enabled = { hostAdmissionEnabled: true, hostMaxActiveRoots: 2, hostMaxRoleExecutions: 3 }
const entry = (key, rootSessionId, state = 'running') => ({ key, rootSessionId, state })
const scope = (root, id, status = 'running', issue) => ({ runId: id, created: { rootSessionId: root }, commands: {},
  assignments: { role: { assignmentId: 'role', taskVersion: 1, status, ...(issue ? { runtimeIssue: { status: issue } } : {}) } } })

test('Host admission knobs are opt-in, finite and valid even while disabled', () => {
  assert.deepEqual(resolveHostAdmissionConfig(), { hostAdmissionEnabled: false, hostMaxActiveRoots: 2, hostMaxRoleExecutions: 4 })
  assert.deepEqual(resolveHostAdmissionConfig(enabled), enabled)
  for (const config of [{ hostAdmissionEnabled: 'true' }, { hostMaxActiveRoots: 0 }, { hostMaxActiveRoots: 9 },
    { hostMaxActiveRoots: NaN }, { hostMaxRoleExecutions: 1 }, { hostMaxRoleExecutions: 17 }, { hostMaxRoleExecutions: 2.5 }]) {
    assert.throws(() => resolveHostAdmissionConfig(config))
  }
})

test('whole-wave reservations are synchronous, atomic, deduplicated with durable rows and never queued', () => {
  const durable = [], admission = new WorkflowHostAdmission(enabled, () => durable)
  const first = admission.reserveRoles('a', ['a1'])
  const second = admission.reserveRoles('b', ['b1', 'b2'])
  assert.equal(admission.view().roleExecutions, 3)
  const before = admission.view()
  assert.throws(() => admission.reserveRoles('a', ['a2', 'a3']), e => e instanceof HostAdmissionFull && e.dimension === 'roles')
  assert.throws(() => admission.reserveRoles('c', ['c1']), e => e.dimension === 'roots')
  assert.throws(() => admission.reserveRoles('a', ['a1']), /重复派发/)
  assert.deepEqual(admission.view(), before)
  durable.push(entry('a1', 'a')); first()
  assert.equal(admission.view().roleExecutions, 3, 'durable row takes over the same occupied slot')
  second(); second()
  assert.equal(admission.view().roleExecutions, 1)
  assert.equal(admission.view().activeRoots, 1)
  assert.equal(durable.length, 1, 'releasing a reservation cannot alter history or launch anything')
})

test('root-model streams share the root limit and old release callbacks cannot release a new stream', async () => {
  const admission = new WorkflowHostAdmission(enabled, () => [])
  const first = admission.beginRootModel('a'), second = admission.beginRootModel('b')
  assert.throws(() => admission.beginRootModel('c'), HostAdmissionFull)
  assert.throws(() => admission.beginRootModel('a'), HostAdmissionFull)
  first()
  const replacement = admission.beginRootModel('a'); first()
  assert.equal(admission.view().rootModelRequests, 2)
  admission.close()
  assert.throws(() => admission.beginRootModel('c'), /关闭/)
  let idle = false
  const completed = admission.whenModelsIdle().then(() => { idle = true })
  await Promise.resolve(); assert.equal(idle, false)
  second(); replacement(); await completed
  assert.equal(admission.view().rootModelRequests, 0)
})

test('unfinished and unknown native ranges occupy slots across cold reads; outcome alone cannot clear them', () => {
  const state = scope('a', 'run')
  const result = collectHostRoleClaims([state])
  assert.equal(result.length, 1); assert.equal(result[0].state, 'running')
  state.assignments.role.runtimeIssue = { status: 'unknown' }
  state.outcome = { outcome: 'FAIL' }
  assert.equal(collectHostRoleClaims([state])[0].state, 'unconfirmed')
  state.assignments.role.runtimeIssue.status = 'stopping'
  assert.equal(collectHostRoleClaims([state])[0].state, 'unconfirmed')
  state.assignments.role.runtimeIssue.status = 'stopped'
  assert.equal(collectHostRoleClaims([state]).length, 0)
  state.commands.command = { commandId: 'command', assignmentId: 'role', status: 'unknown' }
  assert.equal(collectHostRoleClaims([state])[0].state, 'unconfirmed', 'Agent exit cannot settle an unknown command')
  state.manualClose = { gateId: 'explicit-native-decision' }
  assert.deepEqual(collectHostRoleClaims([state]), [])
  assert.equal(state.commands.command.status, 'unknown', 'administrative release does not invent exit proof')
})

test('historical overcapacity blocks new work but retains bounded control access to occupying roots', () => {
  const claims = ['a', 'b', 'c', 'd'].map(id => entry(id, id, 'unconfirmed'))
  const admission = new WorkflowHostAdmission(enabled, () => claims)
  assert.equal(admission.view().activeRoots, 4)
  assert.throws(() => admission.reserveRoles('a', ['a2']), HostAdmissionFull)
  assert.throws(() => admission.beginRootModel('new-root'), HostAdmissionFull)
  const a = admission.beginRootModel('a'), b = admission.beginRootModel('b')
  assert.throws(() => admission.beginRootModel('c'), e => e.dimension === 'root-models')
  a(); b()
  assert.equal(admission.view().unconfirmedRoles, 4)
})

test('resource views are defensive; disabled policy observes without claiming enforcement', () => {
  const claims = [entry('a1', 'a')], admission = new WorkflowHostAdmission({}, () => claims)
  const view = admission.view(); view.roles[0].state = 'unconfirmed'; view.roots.push('forged')
  assert.equal(admission.view().unconfirmedRoles, 0)
  assert.deepEqual(admission.view().roots, ['a'])
  const finish = admission.reserveRoles('b', ['x', 'y', 'z', 'w', 'v'])
  admission.beginRootModel('c')(); finish()
  assert.equal(admission.view().enabled, false)
  assert.equal(admission.view().activeRoots, 1)
})

test('durable read faults reject admission and cannot leak a new reservation or revoke an existing stream', () => {
  let unreadable = false
  const admission = new WorkflowHostAdmission(enabled, () => { if (unreadable) throw new Error('storage unavailable'); return [] })
  const release = admission.beginRootModel('a')
  unreadable = true
  assert.throws(() => admission.beginRootModel('b'), /storage unavailable/)
  assert.throws(() => admission.reserveRoles('b', ['b1', 'b2']), /storage unavailable/)
  // Finally must release an owned stream without trying to read failed storage.
  release(); unreadable = false
  assert.equal(admission.view().roleExecutions, 0)
  assert.equal(admission.view().rootModelRequests, 0)
})

test('confirmed idle waiting and settled roles do not occupy execution slots', () => {
  const completed = scope('a', 'run', 'idle'), admission = new WorkflowHostAdmission(enabled, () => collectHostRoleClaims([completed]))
  assert.equal(admission.view().activeRoots, 0)
  const release = admission.beginRootModel('a')
  assert.equal(admission.view().activeRoots, 1)
  release()
  assert.equal(admission.view().activeRoots, 0)
})

function another(h, id = 'other-root') {
  const previous = h.driver.isRoot, agent = { id }
  h.live.set(id, agent)
  h.driver.isRoot = value => value === agent && h.live.get(id) === agent || previous(value)
  h.controller.bindRoot(agent)
  return agent
}
async function setup(h, root) {
  await h.controller.propose(root, proposal(0), signal)
  await h.controller.confirm(root, { expectedRevision: h.journal.readSnapshot(root.id).revision }, signal)
}
const advance = (h, root) => h.controller.advance(root, { expectedRevision: h.journal.readSnapshot(root.id).revision }, signal)

test('controller rejects a competing root before task/assignment mutation and requires a fresh explicit advance', async t => {
  const h = await controllerFixture(t, { hostAdmissionConfig: { ...enabled, hostMaxActiveRoots: 1 } })
  const other = another(h)
  await h.setup(); await setup(h, other); await h.advance()
  const before = h.journal.readSnapshot(other.id), starts = h.calls.filter(call => call.operation === 'start').length
  await assert.rejects(advance(h, other), HostAdmissionFull)
  assert.deepEqual(h.journal.readSnapshot(other.id), before)
  assert.equal(h.calls.filter(call => call.operation === 'start').length, starts)
  assert.throws(() => h.controller.beginHostModel(other), /并发不足暂停/)
  await h.controller.stop(h.root)
  assert.equal(h.controller.hostAdmission.view().roleExecutions, 0)
  assert.equal(h.calls.filter(call => call.operation === 'start').length, starts, 'no automatic queue')
  await assert.rejects(advance(h, other), /并发不足暂停/)
  h.controller.observeBudgetTurn(other, { type: 'turn/start' })
  h.controller.observeBudgetTurn(other, { type: 'user/message', data: { source: { kind: 'plugin' } } })
  await assert.rejects(advance(h, other), /并发不足暂停/)
  h.controller.observeBudgetTurn(other, { type: 'user/message', data: { source: { kind: 'user' } } })
  await advance(h, other)
  assert.equal(h.controller.hostAdmission.view().roleExecutions, 1)
})

test('failed cancellation and a cold no-op drain retain slots until a proven owned drain settles', async t => {
  const h = await controllerFixture(t, { hostAdmissionConfig: { ...enabled, hostMaxActiveRoots: 1 } })
  await h.setup(); await h.advance()
  const original = h.driver.drain
  h.driver.drain = async () => { throw new Error('injected failed drain') }
  await h.controller.stop(h.root)
  assert.equal(h.controller.hostAdmission.view().unconfirmedRoles, 1)
  const cold = new WorkflowTextController(h.journal, h.artifacts, { ...h.driver, drain: async () => {} }, undefined, {}, undefined, {}, {}, enabled)
  try {
    cold.bindRoot(h.root); await cold.recoverOrphanedLeases()
    await cold.stop(h.root)
    assert.equal(cold.hostAdmission.view().unconfirmedRoles, 1)
    h.driver.drain = original
    await h.controller.stop(h.root)
    assert.equal(cold.hostAdmission.view().roleExecutions, 0)
  } finally { h.driver.drain = original; await cold.close() }
})

test('native resource-command handler is read-only by default and stop cannot target another root', async t => {
  const h = await controllerFixture(t, { hostAdmissionConfig: enabled }), other = another(h)
  await h.setup(); await setup(h, other); await h.advance(); await advance(h, other)
  const before = h.journal.readSnapshot(other.id), own = h.snapshot()
  assert.match(await h.controller.resourcesCommand(h.root, '', signal), /活动范围 2\/2/)
  assert.deepEqual(h.snapshot(), own); assert.deepEqual(h.journal.readSnapshot(other.id), before)
  await assert.rejects(h.controller.resourcesCommand(h.root, 'stop other-root', signal), /用法/)
  await h.controller.resourcesCommand(h.root, 'stop', signal)
  assert.deepEqual(h.journal.readSnapshot(other.id), before)
  assert.deepEqual(h.controller.hostAdmission.view().roots, [other.id])
})

test('capacity refusal cannot resume in the old turn or on a plugin notification after slots become free', async t => {
  const h = await controllerFixture(t, { hostAdmissionConfig: enabled })
  const other = another(h, 'held-root'), paused = another(h, 'paused-root')
  const first = h.controller.beginHostModel(h.root), second = h.controller.beginHostModel(other)
  try {
    h.controller.observeBudgetTurn(paused, { type: 'turn/start' })
    h.controller.observeBudgetTurn(paused, { type: 'user/message', data: { source: { kind: 'user' } } })
    assert.throws(() => h.controller.beginHostModel(paused), HostAdmissionFull)
    first()
    h.controller.observeBudgetTurn(paused, { type: 'user/message', data: { source: { kind: 'user' } } })
    assert.throws(() => h.controller.beginHostModel(paused), /并发不足暂停/)
    h.controller.observeBudgetTurn(paused, { type: 'turn/start' })
    h.controller.observeBudgetTurn(paused, { type: 'user/message', data: { source: { kind: 'plugin' } } })
    assert.throws(() => h.controller.beginHostModel(paused), /并发不足暂停/)
    h.controller.observeBudgetTurn(paused, { type: 'turn/start' })
    h.controller.observeBudgetTurn(paused, { type: 'user/message', data: { source: { kind: 'user' } } })
    const completed = h.controller.beginHostModel(paused)
    completed()
  } finally { first(); second() }
})

test('unload continues revocation after a cancel callback error and waits for real stream settlement', async () => {
  const journal = new WorkflowJournal(memoryTable()), root = { id: 'close-root' }, errors = []
  const controller = new WorkflowTextController(journal, {}, {
    isRoot: value => value === root, isLive: value => value === root,
    cancelRoot: () => { throw new Error('injected cancel callback error') },
    drain: async () => {},
  }, error => errors.push(error), { childCancelGraceMs: 1000 }, undefined, {}, {}, enabled)
  controller.bindRoot(root)
  const release = controller.beginHostModel(root)
  let finished = false
  const closing = controller.close().then(() => { finished = true })
  try {
    await Promise.resolve(); await Promise.resolve()
    assert.equal(finished, false)
    assert.equal(errors.length, 1)
    assert.equal(controller.hostAdmission.view().rootModelRequests, 1)
    release(); await closing
    assert.equal(controller.hostAdmission.view().rootModelRequests, 0)
  } finally { release(); await closing; await journal.close() }
})
