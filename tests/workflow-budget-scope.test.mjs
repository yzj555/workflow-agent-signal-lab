import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowTextController, resolveRunBudgetScope, CONFIRM_LABEL } from '../lib/workflow-control.js'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { childClock, flushChild } from './helpers/workflow-child-clock.mjs'

const rootId = 'controller-root'
const scopeConfig = { runBudgetEnabled: true, runBudgetScope: [rootId] }
const cloneController = (h, config, clock) => {
  const controller = new WorkflowTextController(h.journal, h.artifacts, h.driver, undefined, {}, clock, {}, config)
  controller.bindRoot(h.root)
  return controller
}

test('budget scope defaults to no new enrollment; all is a separate explicit choice', () => {
  assert.deepEqual(resolveRunBudgetScope(), [])
  assert.deepEqual(resolveRunBudgetScope({ runBudgetEnabled: true }), [])
  assert.deepEqual(resolveRunBudgetScope({ runBudgetScope: [] }), [])
  assert.equal(resolveRunBudgetScope({ runBudgetScope: 'all' }), 'all')
  assert.deepEqual(resolveRunBudgetScope({ runBudgetScope: ['all'] }), ['all'])
})

test('malformed, duplicate and pattern scope fails validation instead of broadening', () => {
  const invalid = [null, true, 1, 'controller-root', 'ALL', '*', {}, { ids: [rootId] },
    [''], [' '], [` ${rootId}`], [`${rootId} `], ['a\nb'], ['a\0b'], ['a\u007fb'],
    ['*'], ['root-*'], ['root?'], ['[root]'], [1], [null], [rootId, rootId],
    ['x'.repeat(257)], Array.from({ length: 129 }, (_, i) => `root-${i}`)]
  for (const runBudgetScope of invalid) {
    assert.throws(() => resolveRunBudgetScope({ runBudgetEnabled: false, runBudgetScope }), JSON.stringify(runBudgetScope))
  }
})

test('validated scope is a frozen copy, not a live config alias', () => {
  const ids = [rootId], resolved = resolveRunBudgetScope({ runBudgetScope: ids })
  ids.push('unrelated'); ids[0] = 'changed'
  assert.deepEqual(resolved, [rootId])
  assert.equal(Object.isFrozen(resolved), true)
  assert.throws(() => resolved.push('other'))
})

test('omitted and empty scope never create new accounts despite the old enable switch', async t => {
  for (const runBudgetScope of [undefined, []]) {
    const h = await controllerFixture(t, { runBudgetConfig: { runBudgetScope, runTimeBudgetEnabled: true } })
    await h.setup()
    assert.equal(h.snapshot().run.budget, undefined)
    assert.equal('budgetRevision' in h.snapshot(), false, 'do not fabricate accounting even at revision zero')
  }
})

test('exact root Session ID enrolls both request and time budgets atomically', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig,
    runTimeBudgetEnabled: true, runActiveMs: 1000, runModelRequests: 2, runCommands: 1 } })
  await h.controller.propose(h.root, proposal(0), signal)
  assert.equal(h.snapshot().budgetRevision, 1)
  assert.deepEqual(h.snapshot().run.budget.limits, { modelRequests: 2, commands: 1, activeMs: 1000 })
  assert.equal(h.snapshot().run.budget.time.observedMs, 0)
  assert.equal(h.snapshot().run.budget.runId, h.snapshot().run.runId)
  assert.equal(h.snapshot().run.gates.length, 0, 'budget enrollment itself never approves a requirement')
})

test('prefixes, suffixes, case variants and task titles cannot select a root', async t => {
  for (const id of ['controller', 'controller-root-child', 'Controller-root', proposal(0).title]) {
    const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig, runBudgetScope: [id] } })
    await h.setup()
    assert.equal(h.snapshot().run.budget, undefined, id)
  }
})

test('the feature switch is still required even for a selected root or explicit all scope', async t => {
  for (const runBudgetScope of [[rootId], 'all']) {
    const h = await controllerFixture(t, { runBudgetConfig: { runBudgetEnabled: false, runBudgetScope,
      runTimeBudgetEnabled: true } })
    await h.setup()
    assert.equal(h.snapshot().run.budget, undefined)
  }
})

test('out-of-scope request/command/time admission leaves the old row byte-for-byte unchanged', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig,
    runBudgetScope: ['selected-other-root'], runModelRequests: 1, runCommands: 1, runTimeBudgetEnabled: true } })
  await h.setup()
  const before = JSON.stringify(h.table.get(rootId)), runId = h.snapshot().run.runId
  for (let i = 0; i < 3; i++) {
    await h.controller.admitModelRequest(h.root)
    await h.journal.consumeRunBudget(rootId, runId, 'command')
  }
  h.controller.observeBudgetTurn(h.root, { type: 'turn/end' })
  await h.controller.runTime.flush(rootId)
  assert.equal(JSON.stringify(h.table.get(rootId)), before)
})

test('mutating original Host config cannot widen the live controller scope', async t => {
  const ids = ['other-root'], config = { ...scopeConfig, runBudgetScope: ids }
  const h = await controllerFixture(t, { runBudgetConfig: config })
  ids.push(rootId); config.runBudgetScope = 'all'
  await h.setup()
  assert.equal(h.snapshot().run.budget, undefined)
  assert.deepEqual(h.controller.runBudgetScope, ['other-root'])
})

test('existing metered runs remain enforced after scope removal, switch-off and larger defaults', async t => {
  const clock = childClock()
  const h = await controllerFixture(t, { childClock: clock, runBudgetConfig: { ...scopeConfig,
    runModelRequests: 1, runCommands: 1, runTimeBudgetEnabled: true, runActiveMs: 1000 } })
  await h.setup(); await h.controller.admitModelRequest(h.root)
  clock.advance(50); h.controller.observeBudgetTurn(h.root, { type: 'turn/end' })
  await h.controller.runTime.flush(rootId)
  const next = cloneController(h, { runBudgetEnabled: false, runBudgetScope: [],
    runModelRequests: 999, runCommands: 999, runTimeBudgetEnabled: false, runActiveMs: 99_000 }, clock)
  try {
    await next.recoverOrphanedLeases()
    await assert.rejects(next.admitModelRequest(h.root), /预算/)
    const account = h.snapshot().run.budget
    assert.deepEqual(account.limits, { modelRequests: 1, commands: 1, activeMs: 1000 })
    assert.equal(account.time.observedMs, 50)
    assert.equal(account.blocked.resource, 'root-model')
    assert.equal(h.snapshot().run.outcome, null)
  } finally { await next.close() }
})

test('expanding scope does not retrofit an existing unmetered draft; only its next run can enroll', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig, runBudgetScope: [] } })
  await h.controller.propose(h.root, proposal(0), signal)
  const oldRunId = h.snapshot().run.runId, next = cloneController(h, scopeConfig)
  try {
    const before = JSON.stringify(h.table.get(rootId))
    await next.recoverOrphanedLeases()
    await next.admitModelRequest(h.root)
    assert.equal(JSON.stringify(h.table.get(rootId)), before)
    await next.propose(h.root, proposal(h.snapshot().revision), signal)
    assert.equal(h.snapshot().run.runId, oldRunId)
    assert.equal(h.snapshot().run.budget, undefined)
    await next.stop(h.root)
    await next.propose(h.root, proposal(h.snapshot().revision), signal)
    assert.notEqual(h.snapshot().run.runId, oldRunId)
    assert.ok(h.snapshot().run.budget)
    assert.equal(h.journal.readRunBudget(rootId, oldRunId), undefined)
  } finally { await next.close() }
})

test('children share their selected root account without matching their own generated IDs', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig, runModelRequests: 3 } })
  await h.setup(); await h.advance()
  const child = h.child('author')
  assert.notEqual(child.id, rootId)
  assert.deepEqual(h.controller.runBudgetScope, [rootId])
  await h.controller.admitModelRequest(child)
  await h.controller.admitModelRequest(h.root)
  assert.deepEqual(h.snapshot().run.budget.used, { rootModel: 1, childModel: 1, commands: 0 })
})

test('model input and forged same-ID Agent cannot change enrollment scope', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig, runBudgetScope: [] } })
  for (const field of ['runBudgetScope', 'rootSessionId', 'runBudgetEnabled']) {
    await assert.rejects(h.controller.propose(h.root, { ...proposal(0), [field]: 'all' }, signal))
  }
  await assert.rejects(h.controller.propose({ id: rootId }, proposal(0), signal), /Agent|模式|会话/)
  assert.equal(h.snapshot().revision, 0)
})

test('scope removal preserves the native topup gate and cumulative use on an enrolled account', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig, runModelRequests: 1 },
    ask: (_agent, question) => ({ answers: [{ id: question.id, selected: [question.intent?.approve ?? CONFIRM_LABEL] }] }) })
  await h.setup(); await h.controller.admitModelRequest(h.root)
  await assert.rejects(h.controller.admitModelRequest(h.root), /预算/)
  const next = cloneController(h, { runBudgetEnabled: false, runBudgetScope: [] })
  try {
    const result = await next.budgetRecovery(h.root, { expectedRevision: h.snapshot().revision,
      action: 'topup', reason: '核对剩余工作后申请', add: { modelRequests: 1, commands: 0 } }, signal)
    assert.equal(result.applied, true)
    assert.equal(h.snapshot().run.budget.used.rootModel, 1)
    assert.equal(h.snapshot().run.budget.limits.modelRequests, 2)
    assert.equal(h.snapshot().run.budget.recovery.awaitingResume, true)
    await assert.rejects(next.admitModelRequest(h.root), /等待用户/)
  } finally { await next.close() }
})

test('cold recovery of enrolled time remains conservative even when no new sessions are selected', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { ...scopeConfig, runTimeBudgetEnabled: true, runActiveMs: 100 } })
  await h.setup()
  await h.journal.updateRunTime(rootId, h.snapshot().run.runId, 'old-clock-owner', { elapsedMs: 0, reserveMs: 100 })
  const next = cloneController(h, { runBudgetEnabled: false, runBudgetScope: [] })
  try {
    await next.recoverOrphanedLeases(); await flushChild()
    assert.equal(h.snapshot().run.budget.time.uncertainMs, 100)
    assert.equal(h.snapshot().run.budget.blocked.resource, 'active-time')
    assert.equal(h.snapshot().run.outcome, null)
    const before = JSON.stringify(h.table.get(rootId))
    await next.recoverOrphanedLeases()
    assert.equal(JSON.stringify(h.table.get(rootId)), before)
  } finally { await next.close() }
})
