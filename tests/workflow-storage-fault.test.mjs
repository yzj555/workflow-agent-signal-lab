import assert from 'node:assert/strict'
import test from 'node:test'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { recoveryPair } from './helpers/workflow-capacity-fixture.mjs'
import { childClock, flushChild } from './helpers/workflow-child-clock.mjs'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { workflowReadHandler } from '../lib/workflow-runtime.js'
import { WorkflowSnapshotSource } from '../lib/workflow-source.js'
import { displayWorkflowState } from '../lib/workflow-display.js'

const fault = () => Object.assign(new Error('isolated EIO: C:/private/secret-token-key'), { code: 'EIO' })
const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const tick = () => new Promise(resolve => setImmediate(resolve))

test('storage failure immediately revokes the already-admitted child, without waiting for another tool or model call', async t => {
  const errors = [], cancelled = []
  const h = await controllerFixture(t, { runBudgetConfig: { runBudgetEnabled: false }, reportError: error => errors.push(error) })
  h.driver.cancelRoot = root => cancelled.push(root.id)
  await h.setup(); await h.advance()
  const child = h.child('author'), before = h.snapshot()
  h.table.put = async () => { throw fault() }
  await assert.rejects(h.journal.commit({ rootSessionId: h.root.id, expectedRevision: before.revision,
    events: recoveryPair(before) }), error => error.code === 'recovery-required')
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(h.live.has(child.id), false, 'storage failure must not leave the existing child running')
  assert.deepEqual(cancelled, [h.root.id])
  assert.equal(h.table.get(h.root.id).revision, before.revision, 'failed write cannot manufacture a stop record')
})

test('storage failure is a distinct, sanitized native projection, not a generic connection wait or a false stopped state', async t => {
  const h = await controllerFixture(t)
  await h.setup()
  const before = h.snapshot()
  h.table.put = async () => { throw fault() }
  await assert.rejects(h.journal.commit({ rootSessionId: h.root.id, expectedRevision: before.revision,
    events: recoveryPair(before) }))
  const handler = workflowReadHandler(h.journal)
  const envelope = await handler('snapshot', { schemaVersion: 1, rootSessionId: h.root.id }, signal)
  assert.equal(envelope.ok, false)
  assert.doesNotMatch(JSON.stringify(envelope), /private|secret-token-key|EIO/)
  const source = new WorkflowSnapshotSource({ call: async () => envelope }, { pollMs: 10000 })
  t.after(() => source.dispose())
  source.subscribe(h.root.id, () => {})
  for (let i = 0; i < 5; i++) await tick()
  const view = displayWorkflowState(source.getSnapshot(h.root.id), [], stages)
  assert.equal(view.badge, '存储待恢复')
  assert.equal(view.needsUser, true)
  assert.match(view.attentionDetail, /不能|未确认/)
  assert.doesNotMatch(view.live, /已停止|已取消|验收失败/)
})

test('one failing shared Journal seals every bound workflow root but not another Journal or an unbound Agent', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { runBudgetEnabled: false } })
  const other = { id: 'other-bound-root' }, outsider = { id: 'not-this-preset' }, cancelled = []
  h.driver.isRoot = root => [h.root, other, outsider].includes(root)
  h.driver.cancelRoot = root => cancelled.push(root.id)
  h.live.set(other.id, other); h.controller.bindRoot(other)
  await h.setup(); await h.advance()
  await h.controller.propose(other, proposal(0), signal)
  await h.controller.confirm(other, { expectedRevision: h.journal.readSnapshot(other.id).revision }, signal)
  await h.controller.advance(other, { expectedRevision: h.journal.readSnapshot(other.id).revision }, signal)
  const childIds = [...h.snapshot().run.agents, ...h.journal.readSnapshot(other.id).run.agents].map(a => a.agentSessionId)
  const before = h.snapshot()
  h.table.put = async () => { throw fault() }
  await assert.rejects(h.journal.commit({ rootSessionId: h.root.id, expectedRevision: before.revision, events: recoveryPair(before) }))
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual(cancelled.sort(), [h.root.id, other.id].sort())
  for (const id of childIds) assert.equal(h.live.has(id), false)
  const independent = new WorkflowJournal(memoryTable()), f = fixture('separate-store')
  try {
    await independent.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
    assert.equal(independent.readFault(), undefined)
  } finally { await independent.close() }
})

test('uncertain post-write acknowledgement never emits an approved view or stop event; cold read preserves what actually persisted', async () => {
  for (const didWrite of [false, true]) {
    const table = memoryTable(), journal = new WorkflowJournal(table), f = fixture(`uncertain-${didWrite}`)
    await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
    let snapshots = 0, faults = 0
    journal.subscribe(() => snapshots++)
    journal.onFault(() => { faults++; assert.throws(() => journal.readSnapshot(f.rootSessionId), /reopen/); throw new Error('observer cannot suppress the next observer') })
    let second = 0
    journal.onFault(async () => { second++ })
    table.put = async (key, value) => { if (didWrite) table.rows.set(key, value); throw fault() }
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 6, events: [f.approve()] }))
    journal.sealTimeAccounting(new Error('secondary failure must not replace original kind'))
    assert.equal(snapshots, 0); assert.equal(faults, 1); assert.equal(second, 1)
    const diagnostic = journal.readFault(); diagnostic.kind = 'time-accounting'
    assert.equal(journal.readFault().kind, 'storage-write')
    let late = 0; journal.onFault(() => late++)
    assert.equal(late, 1)
    await journal.close()
    const cold = new WorkflowJournal(table)
    try {
      assert.equal(cold.readFault(), undefined)
      assert.equal(cold.readSnapshot(f.rootSessionId).run.gates[0].status, didWrite ? 'approved' : 'waiting')
      assert.equal(cold.readSnapshot(f.rootSessionId).run.outcome, null)
    } finally { await cold.close() }
  }
})

test('unconfirmed drain stays unconfirmed after storage failure; no false cancellation is appended', async t => {
  const drain = Promise.withResolvers(), clock = childClock(), errors = []
  const h = await controllerFixture(t, { childClock: clock, childConfig: { childCancelGraceMs: 1000 },
    drain: () => drain.promise, reportError: error => errors.push(error), runBudgetConfig: { runBudgetEnabled: false } })
  await h.setup(); await h.advance()
  const before = h.snapshot(), child = h.child('author')
  h.table.put = async () => { throw fault() }
  await assert.rejects(h.journal.commit({ rootSessionId: h.root.id, expectedRevision: before.revision, events: recoveryPair(before) }))
  clock.advance(1000); await flushChild()
  assert.equal(h.live.has(child.id), true)
  assert.ok(errors.some(error => /未确认回收/.test(error.message)))
  assert.equal(h.table.get(h.root.id).revision, before.revision)
  assert.match(h.controller.guard(child, 'workflow_report'), /reopen/)
  drain.resolve(); await flushChild()
})

test('time-accounting failure notifies the same scoped revocation without relabeling it normal budget exhaustion', async t => {
  const clock = childClock(), cancelled = []
  const h = await controllerFixture(t, { childClock: clock, runBudgetConfig: { runTimeBudgetEnabled: true, runActiveMs: 20000 } })
  h.driver.cancelRoot = (root, reason) => cancelled.push([root.id, reason])
  await h.setup(); await h.controller.admitModelRequest(h.root)
  h.journal.sealTimeAccounting(new Error('unreliable timing grant'))
  await flushChild()
  assert.equal(h.journal.readFault().kind, 'time-accounting')
  assert.deepEqual(cancelled, [[h.root.id, 'storage-unavailable']])
  assert.throws(() => h.snapshot(), /reopen/)
  assert.equal(h.table.get(h.root.id).budgets.accounts[0].blocked, null)
})

test('a late native approval cannot survive storage failure; cancellation does not fabricate a replacement outcome', async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers()
  const h = await controllerFixture(t, { ask: (_root, question) => { entered.resolve(question); return answer.promise } })
  await h.controller.propose(h.root, proposal(0), signal)
  const pending = h.controller.confirm(h.root, h.revision(), signal)
  const rejection = assert.rejects(pending)
  const question = await entered.promise, before = h.snapshot()
  h.table.put = async () => { throw fault() }
  await assert.rejects(h.journal.commit({ rootSessionId: h.root.id, expectedRevision: before.revision, events: recoveryPair(before) }))
  answer.resolve({ answers: [{ id: question.id, selected: [question.intent.approve] }] })
  await rejection
  assert.equal(h.table.get(h.root.id).revision, before.revision)
  assert.equal(h.table.get(h.root.id).events.some(item => item.data.name === 'gate/decided' && item.data.payload.decision === 'approved'), false)
  assert.equal(h.calls.some(call => call.operation === 'start'), false)
})

test('foreign or malformed fault details cannot appear as a trusted storage incident; raw error text is not displayed', async t => {
  for (const details of [
    { workflowFault: { schemaVersion: 1, rootSessionId: 'foreign-root', kind: 'storage-write' } },
    { workflowFault: { schemaVersion: 1, rootSessionId: 'test-root', kind: 'made-up', secret: 'raw-secret' } },
    {},
  ]) {
    const source = new WorkflowSnapshotSource({ call: async () => ({ ok: false, error: { code: 'internal', message: 'raw-secret', details } }) })
    t.after(() => source.dispose())
    source.subscribe('test-root', () => {})
    for (let i = 0; i < 5; i++) await tick()
    const state = source.getSnapshot('test-root')
    assert.equal(state.status, 'unavailable'); assert.equal(state.fault, undefined)
    assert.doesNotMatch(JSON.stringify(displayWorkflowState(state, [], stages)), /raw-secret|存储待恢复/)
  }
})
