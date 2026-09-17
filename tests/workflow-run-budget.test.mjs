import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { openWorkflowStorage } from '../lib/workflow-runtime.js'
import { resolveRunBudgetEnabled, resolveRunBudgetLimits, WorkflowTextController } from '../lib/workflow-control.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'

async function setup(t, limits = { modelRequests: 3, commands: 2 }) {
  const table = memoryTable(), f = fixture(), journal = new WorkflowJournal(table)
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial(), runBudgetLimits: limits })
  t.after(() => journal.close())
  return { table, f, journal, snapshot: () => journal.readSnapshot(f.rootSessionId),
    consume: resource => journal.consumeRunBudget(f.rootSessionId, f.runId, resource) }
}

test('whole-run limits validate at Host startup and are not model fields', () => {
  assert.equal(resolveRunBudgetEnabled(), false)
  assert.equal(resolveRunBudgetEnabled({ runBudgetEnabled: true }), true)
  assert.throws(() => resolveRunBudgetEnabled({ runBudgetEnabled: 'true' }))
  assert.deepEqual(resolveRunBudgetLimits(), { modelRequests: 240, commands: 40 })
  for (const input of [{ runModelRequests: 0 }, { runCommands: -1 }, { runCommands: 0.5 }, { runModelRequests: Infinity }]) {
    assert.throws(() => resolveRunBudgetLimits(input))
  }
})

test('the unfinished policy is opt-in and does not fabricate accounting for an unmetered run', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { runBudgetEnabled: false } })
  await h.setup()
  assert.equal(h.snapshot().run.budget, undefined)
  const before = JSON.stringify(h.table.get(h.root.id))
  await h.controller.admitModelRequest(h.root)
  assert.equal(JSON.stringify(h.table.get(h.root.id)), before)
})

test('turning off the new-run switch or increasing Host defaults cannot refill an already frozen account', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { runModelRequests: 1 } })
  await h.setup(); await h.controller.admitModelRequest(h.root)
  const next = new WorkflowTextController(h.journal, h.artifacts, h.driver, undefined, {}, undefined, {},
    { runBudgetEnabled: false, runModelRequests: 999 })
  try {
    next.bindRoot(h.root)
    await assert.rejects(next.admitModelRequest(h.root), /预算/)
    assert.equal(h.snapshot().run.budget.limits.modelRequests, 1)
    assert.equal(h.snapshot().run.budget.used.rootModel, 1)
  } finally { await next.close() }
})

test('accounting revisions do not stale a waiting confirmation and workflow commits preserve counters', async t => {
  const h = await setup(t), before = h.snapshot()
  await h.consume('root-model')
  await h.consume('child-model')
  assert.equal(h.snapshot().revision, before.revision)
  assert.equal(h.snapshot().budgetRevision, 3)
  assert.deepEqual(h.snapshot().run.gates, before.run.gates)
  await h.journal.commit({ rootSessionId: h.f.rootSessionId, expectedRevision: before.revision, events: [h.f.approve()] })
  assert.equal(h.snapshot().run.gates[0].status, 'approved')
  assert.deepEqual(h.snapshot().run.budget.used, { rootModel: 1, childModel: 1, commands: 0 })
})

test('parallel root and children share exactly one last admission; denial is durable and idempotent', async t => {
  const h = await setup(t, { modelRequests: 1, commands: 1 })
  const outcomes = await Promise.allSettled([h.consume('root-model'), h.consume('child-model'), h.consume('child-model')])
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(h.snapshot().budgetRevision, 3)
  assert.equal(h.snapshot().run.budget.used.rootModel + h.snapshot().run.budget.used.childModel, 1)
  assert.equal(h.snapshot().run.needsUser, true)
  const sealed = JSON.stringify(h.table.get(h.f.rootSessionId))
  await assert.rejects(h.consume('command'), /预算/)
  assert.equal(JSON.stringify(h.table.get(h.f.rootSessionId)), sealed)
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.snapshot().run.ledger.fail, 0)
})

test('model and command reservations are independent until one cap closes the entire run', async t => {
  const h = await setup(t)
  await h.consume('command'); await h.consume('command'); await h.consume('root-model')
  await assert.rejects(h.consume('command'), /预算/)
  await assert.rejects(h.consume('child-model'), /预算/)
  assert.equal(h.snapshot().run.budget.blocked.resource, 'command')
  assert.deepEqual(h.snapshot().run.budget.used, { rootModel: 1, childModel: 0, commands: 2 })
})

test('a reservation is visible only after durable put and blocks dispatch when put fails', async t => {
  const h = await setup(t), write = h.table.put, entered = Promise.withResolvers(), finish = Promise.withResolvers()
  h.table.put = async (...args) => { entered.resolve(); await finish.promise; return write(...args) }
  let dispatched = 0
  const work = h.consume('root-model').then(() => { dispatched++ })
  await entered.promise
  assert.equal(h.snapshot().run.budget.used.rootModel, 0)
  assert.equal(dispatched, 0)
  finish.resolve(); await work
  assert.equal(dispatched, 1)
  h.table.put = async () => { throw new Error('disk full fixture') }
  await assert.rejects(h.consume('command').then(() => { dispatched++ }), /reopen storage/)
  assert.equal(dispatched, 1)
  assert.throws(() => h.snapshot(), /storage failed/)
})

test('cold SQLite reopen keeps reservations without inventing actual cost or exit evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-run-budget-'))
  const f = fixture(), first = await openWorkflowStorage(directory)
  await first.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial(),
    runBudgetLimits: { modelRequests: 1, commands: 1 } })
  await first.journal.consumeRunBudget(f.rootSessionId, f.runId, 'child-model')
  const before = first.journal.readSnapshot(f.rootSessionId)
  await first.close()
  const second = await openWorkflowStorage(directory)
  try {
    assert.deepEqual(second.journal.readSnapshot(f.rootSessionId), before)
    await assert.rejects(second.journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model'), /预算/)
    assert.equal(second.journal.readSnapshot(f.rootSessionId).run.agents.length, 0)
    assert.equal(second.journal.readSnapshot(f.rootSessionId).run.outcome, null)
  } finally { await second.close() }
})

test('accounting does not rewrite unmetered legacy history or refill after a cancelled run', async t => {
  const table = memoryTable(), journal = new WorkflowJournal(table), f = fixture()
  t.after(() => journal.close())
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  const before = JSON.stringify(table.get(f.rootSessionId))
  await journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model')
  assert.equal(JSON.stringify(table.get(f.rootSessionId)), before)
  assert.equal(journal.readSnapshot(f.rootSessionId).run.budget, undefined)
  const h = await controllerFixture(t, { runBudgetConfig: { runModelRequests: 1 } })
  await h.setup()
  await h.controller.admitModelRequest(h.root)
  await h.controller.stop(h.root)
  await assert.rejects(h.controller.propose(h.root, proposal(h.snapshot().revision), signal), /绕过/)
  assert.equal(h.snapshot().history.length, 1)
})

test('malformed counters, unknown runs and attempts to reset frozen limits are rejected', async t => {
  const h = await setup(t)
  for (const mutate of [
    row => { row.budgets.revision++ },
    row => { row.budgets.accounts[0].used.rootModel = 99 },
    row => { row.budgets.accounts[0].runId = 'other-run' },
    row => { row.budgets.accounts.push(row.budgets.accounts[0]) },
  ]) {
    const row = structuredClone(h.table.get(h.f.rootSessionId)); mutate(row)
    assert.throws(() => parseWorkflowJournalRecord(row))
  }
  await assert.rejects(h.journal.commit({ rootSessionId: h.f.rootSessionId, expectedRevision: h.snapshot().revision,
    events: [h.f.approve()], runBudgetLimits: { modelRequests: 999, commands: 999 } }), /new run/)
  await assert.rejects(h.journal.consumeRunBudget(h.f.rootSessionId, 'foreign-run', 'root-model'), /current run/)
})

test('child denial revokes owned leases, preserves facts and suppresses automatic coordinator notices', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { runModelRequests: 1 } })
  await h.setup(); await h.advance()
  const child = h.child('author')
  await h.controller.admitModelRequest(child)
  await assert.rejects(h.controller.admitModelRequest(child), /预算/)
  await h.controller.close()
  assert.equal(h.snapshot().run.budget.blocked.resource, 'child-model')
  assert.equal(h.snapshot().run.agents[0].runtimeIssue.cause, 'run-budget')
  assert.equal(h.snapshot().run.agents[0].runtimeIssue.status, 'stopped')
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.snapshot().run.ledger.fail, 0)
  assert.equal(h.notices.length, 0)
})

test('failed drains remain unknown, never CANCELLED or business FAIL', async t => {
  let allowDrain = false
  const h = await controllerFixture(t, { runBudgetConfig: { runModelRequests: 1 },
    drain: async () => { if (!allowDrain) throw new Error('fixture unknown exit') } })
  await h.setup(); await h.advance()
  await h.controller.admitModelRequest(h.root)
  await assert.rejects(h.controller.admitModelRequest(h.root), /预算/)
  for (let i = 0; i < 100 && h.snapshot().run.agents[0].runtimeIssue?.status !== 'unknown'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(h.snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.snapshot().run.needsUser, true)
  allowDrain = true
  await h.controller.stop(h.root)
})

test('new run gets frozen Host defaults atomically and an in-place draft revision does not reset use', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { runModelRequests: 4, runCommands: 2 } })
  await h.controller.propose(h.root, proposal(0), signal)
  assert.deepEqual(h.snapshot().run.budget.limits, { modelRequests: 4, commands: 2 })
  await h.controller.admitModelRequest(h.root)
  await h.controller.propose(h.root, proposal(h.snapshot().revision), signal)
  assert.equal(h.snapshot().run.budget.used.rootModel, 1)
  assert.equal(h.snapshot().budgetRevision, 2)
})
