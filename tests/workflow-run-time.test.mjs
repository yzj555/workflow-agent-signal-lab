import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { openWorkflowStorage } from '../lib/workflow-runtime.js'
import { WorkflowRunTime, WorkflowTextController, resolveRunBudgetLimits, CONFIRM_LABEL,
  BUDGET_TOPUP_LABEL, runTimeSummary } from '../lib/workflow-control.js'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { childClock, flushChild } from './helpers/workflow-child-clock.mjs'

async function setup(t, activeMs = 20_000, suppliedClock) {
  const table = memoryTable(), journal = new WorkflowJournal(table), f = fixture()
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial(),
    runBudgetLimits: { modelRequests: 50, commands: 10, ...(activeMs === undefined ? {} : { activeMs }) } })
  const clock = suppliedClock ?? childClock(), stops = [], errors = []
  const runtime = new WorkflowRunTime(journal, (...args) => stops.push(args), e => errors.push(e), clock)
  t.after(async () => { await runtime.close(); await journal.close() })
  const snapshot = () => journal.readSnapshot(f.rootSessionId)
  return { table, journal, f, clock, stops, errors, runtime, snapshot,
    account: () => snapshot().run.budget,
    enter: (actor = 'root', waiting = false) => runtime.enter(f.rootSessionId, f.runId, actor, waiting),
    leave: async (actor = 'root') => { runtime.leave(f.rootSessionId, actor); await runtime.flush(f.rootSessionId) },
    advance: async ms => { clock.advance(ms); await flushChild(); await runtime.flush(f.rootSessionId) },
  }
}

test('time policy is a separate opt-in with validated frozen defaults', () => {
  assert.equal(resolveRunBudgetLimits().activeMs, undefined)
  assert.equal(resolveRunBudgetLimits({ runTimeBudgetEnabled: true }).activeMs, 1_800_000)
  for (const config of [{ runActiveMs: 0 }, { runActiveMs: -1 }, { runActiveMs: 0.5 },
    { runActiveMs: Infinity }, { runActiveMs: 86_400_001 }, { runTimeBudgetEnabled: 'true' }]) {
    assert.throws(() => resolveRunBudgetLimits(config))
  }
})

test('active intervals accumulate across turns; idle and root-only question waits do not', async t => {
  const h = await setup(t)
  await h.enter(); await h.advance(100); await h.leave()
  assert.equal(h.account().time.observedMs, 100)
  assert.equal(h.account().time.reservedMs, 0)
  await h.advance(10_000)
  await h.enter(); await h.advance(50)
  h.runtime.waiting(h.f.rootSessionId, true); await h.runtime.flush(h.f.rootSessionId)
  assert.equal(h.account().time.observedMs, 150)
  await h.advance(100_000)
  assert.equal(h.stops.length, 0)
  h.runtime.waiting(h.f.rootSessionId, false); await h.runtime.flush(h.f.rootSessionId)
  await h.enter(); await h.advance(25); await h.leave()
  assert.equal(h.account().time.observedMs, 175)
})

test('parallel root and two children count the union; waiting parent never exempts working children', async t => {
  const h = await setup(t)
  await h.enter(); await h.advance(100)
  await Promise.all([h.enter('child-a'), h.enter('child-b')])
  h.runtime.waiting(h.f.rootSessionId, true)
  await h.advance(200); await h.leave('child-a')
  await h.advance(300); await h.leave('child-b')
  assert.equal(h.account().time.observedMs, 600)
  assert.equal(h.account().time.reservedMs, 0)
  await h.advance(30_000)
  assert.equal(h.account().time.observedMs, 600)
  assert.equal(h.stops.length, 0)
})

test('many model admissions neither double-charge time nor discard fractional elapsed intervals', async t => {
  const h = await setup(t)
  for (let i = 0; i < 10; i++) {
    await h.enter(); await h.advance(0.6); await h.leave()
  }
  assert.ok(h.account().time.observedMs >= 5 && h.account().time.observedMs <= 6)
  const before = h.account().time.observedMs
  for (let i = 0; i < 10; i++) await h.enter()
  await h.leave()
  assert.equal(h.account().time.observedMs, before)
})

test('renewal checkpoints preserve one cumulative balance and do not stale workflow gates', async t => {
  const h = await setup(t), revision = h.snapshot().revision
  await h.enter()
  for (let i = 0; i < 12; i++) await h.advance(1000)
  await h.leave()
  assert.equal(h.account().time.observedMs, 12_000)
  assert.equal(h.account().time.reservedMs, 0)
  assert.equal(h.snapshot().revision, revision)
  await h.journal.commit({ rootSessionId: h.f.rootSessionId, expectedRevision: revision, events: [h.f.approve()] })
  assert.equal(h.snapshot().run.gates[0].status, 'approved')
  assert.equal(h.account().time.observedMs, 12_000)
})

test('time exhaustion seals the run durably, once, without a failed or cancelled business result', async t => {
  const h = await setup(t, 100), revision = h.snapshot().revision
  await h.enter(); await h.advance(100)
  assert.equal(h.account().blocked.resource, 'active-time')
  assert.equal(h.account().time.observedMs, 100)
  assert.equal(h.account().time.reservedMs, 0)
  assert.equal(h.account().recovery.blocks, 1)
  assert.equal(h.snapshot().revision, revision)
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.snapshot().run.ledger.fail, 0)
  await h.advance(1000); await h.leave()
  assert.equal(h.stops.length, 1)
  await assert.rejects(h.enter(), /预算/)
  await assert.rejects(h.journal.consumeRunBudget(h.f.rootSessionId, h.f.runId, 'command'), /预算/)
  const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
  const view = displayWorkflowState({ status: 'ready', snapshot: h.snapshot() }, [], stages)
  assert.equal(view.badge, '时长预算耗尽')
  assert.match(view.nowDetail, /已观测/)
})

test('fractional remaining time survives integer timer truncation while the parent waits', async t => {
  const clock = childClock(), schedule = clock.set
  // Match Node's integer-millisecond scheduling against performance.now().
  clock.set = (callback, delay) => schedule(callback, Math.max(1, Math.trunc(delay)))
  const h = await setup(t, 100, clock)
  await h.enter('root', true)
  await h.enter('working-child')
  await h.advance(25.4)
  await h.enter('working-child')
  await h.advance(74)
  assert.equal(h.stops.length, 0, 'never stop before the funded deadline')
  assert.ok(clock.count() > 0, 'an early boundary must not drop the only remaining observer')
  // No model request, tool completion or user answer drives this expiry.
  await h.advance(1)
  assert.equal(h.stops.length, 1)
  assert.equal(h.account().blocked.resource, 'active-time')
  assert.equal(h.account().time.observedMs, 100)
  assert.equal(h.account().recovery.blocks, 1)
  assert.equal(h.snapshot().run.outcome, null)
})

test('an early boundary callback rearms without premature expiry or duplicate stops', async t => {
  const clock = childClock(), schedule = clock.set
  let early = true
  clock.set = (callback, delay) => {
    const actual = early ? delay - 0.6 : delay
    early = false
    return schedule(callback, actual)
  }
  const h = await setup(t, 100, clock)
  await h.enter('root', true)
  await h.enter('working-child')
  await h.advance(99.4)
  assert.equal(h.stops.length, 0)
  assert.ok(clock.count() > 0, 'rounded scheduling alone does not justify discarding an early callback')
  await h.advance(1)
  assert.equal(h.stops.length, 1)
  assert.equal(h.account().blocked.resource, 'active-time')
  await h.advance(1000)
  assert.equal(h.stops.length, 1)
  assert.equal(clock.count(), 0)
})

test('late event-loop observation reports overrun separately instead of pretending an exact kill', async t => {
  let now = 0
  const clock = { now: () => now, set: () => 1, clear: () => {} }
  const h = await setup(t, 100, clock)
  await h.enter(); now = 145
  await h.leave()
  assert.equal(h.account().time.observedMs, 100)
  assert.equal(h.account().time.overrunMs, 45)
  assert.equal(h.account().blocked.resource, 'active-time')
  assert.match(runTimeSummary(h.account()), /不声称实时强制终止/)
})

test('work waits for the first durable time reservation; failure prevents dispatch', async t => {
  const h = await setup(t), write = h.table.put, entered = Promise.withResolvers(), finish = Promise.withResolvers()
  h.table.put = async (...args) => { entered.resolve(); await finish.promise; return write(...args) }
  let dispatched = 0
  const work = h.enter().then(() => dispatched++)
  await entered.promise
  assert.equal(dispatched, 0)
  assert.equal(h.account().time.reservedMs, 0)
  finish.resolve(); await work; await h.leave()
  assert.equal(dispatched, 1)
  h.table.put = async () => { throw new Error('fixture time disk full') }
  await assert.rejects(h.enter().then(() => dispatched++), /reopen storage/)
  assert.equal(dispatched, 1)
  assert.equal(h.stops.length, 1)
  assert.throws(() => h.snapshot(), /storage failed/)
})

test('a renewal stuck beyond its durable horizon fails storage safety, not fake budget exhaustion', async t => {
  const h = await setup(t), write = h.table.put, entered = Promise.withResolvers(), finish = Promise.withResolvers()
  await h.enter()
  h.table.put = async (...args) => { entered.resolve(); await finish.promise; return write(...args) }
  h.clock.advance(2500); await entered.promise
  h.clock.advance(2500)
  assert.equal(h.stops.length, 1)
  assert.match(h.stops[0][2].message, /不是预算耗尽/)
  assert.throws(() => h.snapshot(), /storage failed/)
  finish.resolve(); await flushChild()
  const row = h.table.get(h.f.rootSessionId)
  assert.equal(row.budgets.accounts[0].blocked, null)
  assert.equal(row.events.some(e => e.data.name === 'outcome/declared'), false)
})

test('backwards monotonic clock seals admission without substituting wall-clock timestamps', async t => {
  let now = 10
  const h = await setup(t, 100, { now: () => now, set: () => 1, clear: () => {} })
  await h.enter(); now = 9
  assert.throws(() => h.runtime.assertAdmitted(h.f.rootSessionId, h.f.runId), /单调时钟/)
  assert.equal(h.stops.length, 1)
  assert.throws(() => h.snapshot(), /storage failed/)
})

test('cold SQLite reopen charges only the old unsettled slice, not arbitrary Host downtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-time-reopen-')), f = fixture()
  const first = await openWorkflowStorage(directory)
  await first.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial(),
    runBudgetLimits: { modelRequests: 20, commands: 3, activeMs: 20_000 } })
  await first.journal.updateRunTime(f.rootSessionId, f.runId, 'old-host', { elapsedMs: 0, reserveMs: 5000 })
  await first.journal.updateRunTime(f.rootSessionId, f.runId, 'old-host', { elapsedMs: 1000, reserveMs: 0 })
  await first.close()
  const second = await openWorkflowStorage(directory)
  try {
    await second.journal.recoverRunTime(f.rootSessionId, f.runId, 'new-host')
    const before = second.journal.readSnapshot(f.rootSessionId)
    assert.deepEqual(before.run.budget.time, { revision: 3, observedMs: 1000, uncertainMs: 4000,
      reservedMs: 0, overrunMs: 0, ownerId: null })
    await assert.rejects(second.journal.recoverRunTime(f.rootSessionId, f.runId, 'third-host'), /no old/)
    assert.deepEqual(second.journal.readSnapshot(f.rootSessionId), before)
    assert.equal(before.run.outcome, null)
  } finally { await second.close() }
})

test('cold recovery can exhaust time conservatively but never invent exit or outcome evidence', async t => {
  const h = await setup(t, 100)
  await h.journal.updateRunTime(h.f.rootSessionId, h.f.runId, 'old-owner', { elapsedMs: 0, reserveMs: 100 })
  await h.journal.recoverRunTime(h.f.rootSessionId, h.f.runId, h.runtime.ownerId)
  assert.equal(h.account().time.uncertainMs, 100)
  assert.equal(h.account().time.observedMs, 0)
  assert.equal(h.account().blocked.resource, 'active-time')
  assert.equal(h.snapshot().run.agents.length, 0)
  assert.equal(h.snapshot().run.outcome, null)
  await assert.rejects(h.enter(), /预算/)
})

test('clock metadata rejects missing pairs, impossible balances and changed owners', async t => {
  const h = await setup(t)
  await h.enter()
  for (const mutate of [
    a => { delete a.time }, a => { delete a.limits.activeMs },
    a => { a.time.reservedMs = 10_001 }, a => { a.time.ownerId = null },
    a => { a.time.observedMs = 99_999 }, a => { a.time.revision++ },
    a => { a.limits.activeMs++ },
  ]) {
    const row = structuredClone(h.table.get(h.f.rootSessionId)); mutate(row.budgets.accounts[0])
    assert.throws(() => parseWorkflowJournalRecord(row))
  }
  await assert.rejects(h.journal.updateRunTime(h.f.rootSessionId, h.f.runId, 'foreign-owner',
    { elapsedMs: 1, reserveMs: 0 }), /another Host/)
})

test('an old request-only account remains byte-for-byte unmodified by clock admission', async t => {
  const h = await controllerFixture(t)
  await h.setup()
  const before = JSON.stringify(h.table.get(h.root.id))
  await h.controller.runTime.enter(h.root.id, h.snapshot().run.runId, 'root')
  h.controller.runTime.leave(h.root.id, 'root'); await h.controller.runTime.flush(h.root.id)
  assert.equal(JSON.stringify(h.table.get(h.root.id)), before)
})

const timedConfig = { runTimeBudgetEnabled: true, runActiveMs: 100 }
const accept = (_agent, q) => ({ answers: [{ id: q.id, selected: [q.intent?.approve ?? CONFIRM_LABEL] }] })
async function timedController(t, options = {}) {
  const clock = childClock()
  const h = await controllerFixture(t, { ask: accept, ...options, childClock: clock, runBudgetConfig: timedConfig })
  await h.setup()
  return { ...h, clock, account: () => h.snapshot().run.budget }
}

test('duration interrupts owned children through existing drain evidence, not a fake QA failure', async t => {
  const h = await timedController(t)
  await h.advance()
  const child = h.child('author')
  await h.controller.admitModelRequest(child)
  h.clock.advance(100); await flushChild(); await h.controller.runTime.flush(h.root.id)
  assert.equal(h.account().blocked.resource, 'active-time')
  assert.equal(h.snapshot().run.agents[0].runtimeIssue.cause, 'run-budget')
  assert.equal(h.snapshot().run.agents[0].runtimeIssue.status, 'stopped')
  assert.equal(h.snapshot().run.ledger.fail, 0)
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.notices.length, 0)
})

test('child spawn is included only after durable time admission and cannot slip through a failed write', async t => {
  const h = await timedController(t), put = h.table.put
  h.table.put = async (key, row) => {
    if (row.budgets?.accounts[0].time.reservedMs > 0) throw new Error('time reservation disk failure')
    return put(key, row)
  }
  await assert.rejects(h.advance(), /storage|时长|预算/)
  assert.equal(h.calls.filter(c => c.operation === 'start').length, 0)
})

test('explicit time-only topup preserves spent time, freezes exact numbers, and requires fresh native input', async t => {
  const h = await timedController(t)
  await h.controller.admitModelRequest(h.root)
  h.clock.advance(100); await flushChild(); await h.controller.runTime.flush(h.root.id)
  await assert.rejects(h.controller.budgetRecovery(h.root, { expectedRevision: h.snapshot().revision,
    action: 'topup', reason: '测试', add: { modelRequests: 2, commands: 1 } }, signal), /increase the exhausted resource/)
  const result = await h.controller.budgetRecovery(h.root, { expectedRevision: h.snapshot().revision,
    action: 'topup', reason: '测试剩余工作', add: { modelRequests: 0, commands: 0, activeMs: 200 } }, signal)
  assert.equal(result.applied, true)
  assert.equal(h.account().limits.activeMs, 300)
  assert.equal(h.account().time.observedMs, 100)
  assert.equal(h.account().recovery.awaitingResume, true)
  assert.equal(h.questions.at(-1).intent.approve, BUDGET_TOPUP_LABEL)
  assert.match(h.questions.at(-1).detail, /有效时长/)
  await assert.rejects(h.controller.admitModelRequest(h.root), /等待用户/)
  h.controller.observeBudgetTurn(h.root, { type: 'turn/end' })
  h.controller.observeBudgetTurn(h.root, { type: 'turn/start' })
  h.controller.observeBudgetTurn(h.root, { type: 'user/message', data: { source: { kind: 'user' } } })
  await h.controller.admitModelRequest(h.root)
  h.clock.advance(50); h.controller.observeBudgetTurn(h.root, { type: 'turn/end' })
  await h.controller.runTime.flush(h.root.id)
  assert.equal(h.account().time.observedMs, 150)
  assert.equal(h.account().blocked, null)
})

test('native fixed topup adds ten minutes only to a timed run and never erases accounting', async t => {
  const h = await timedController(t)
  await h.controller.admitModelRequest(h.root)
  h.clock.advance(100); await flushChild(); await h.controller.runTime.flush(h.root.id)
  await h.controller.budgetCommand(h.root, 'topup', signal)
  assert.equal(h.account().limits.activeMs, 600_100)
  assert.equal(h.account().time.observedMs, 100)
  assert.equal(h.account().recovery.requests.at(-1).add.activeMs, 600_000)
})

test('cold controller recovers unsettled time once without re-reading larger Host defaults', async t => {
  const h = await timedController(t), runId = h.snapshot().run.runId
  await h.journal.updateRunTime(h.root.id, runId, 'old-host', { elapsedMs: 0, reserveMs: 80 })
  const next = new WorkflowTextController(h.journal, h.artifacts, h.driver, undefined, {}, h.clock, {},
    { runTimeBudgetEnabled: false, runActiveMs: 9999 })
  try {
    next.bindRoot(h.root)
    await next.recoverOrphanedLeases()
    assert.equal(h.account().time.uncertainMs, 80)
    assert.equal(h.account().limits.activeMs, 100)
    const before = JSON.stringify(h.table.get(h.root.id))
    await next.recoverOrphanedLeases()
    assert.equal(JSON.stringify(h.table.get(h.root.id)), before)
  } finally { await next.close() }
})

test('separate root sessions never share time or cancellation scope', async t => {
  const h = await setup(t, 100), second = fixture('other-session', 'other-run')
  await h.journal.commit({ rootSessionId: second.rootSessionId, expectedRevision: 0, events: second.initial(),
    runBudgetLimits: { modelRequests: 50, commands: 10, activeMs: 1000 } })
  await h.enter()
  await h.runtime.enter(second.rootSessionId, second.runId, 'root')
  await h.advance(100)
  assert.equal(h.stops.length, 1)
  assert.deepEqual(h.stops[0].slice(0, 2), [h.f.rootSessionId, h.f.runId])
  h.runtime.assertAdmitted(second.rootSessionId, second.runId)
  h.runtime.leave(second.rootSessionId, 'root'); await h.runtime.flush(second.rootSessionId)
  assert.equal(h.journal.readSnapshot(second.rootSessionId).run.budget.time.observedMs, 100)
  assert.equal(h.journal.readSnapshot(second.rootSessionId).run.budget.blocked, null)
})

test('a request ceiling settles partial duration without reclassifying the original block', async t => {
  const h = await setup(t)
  await h.enter(); await h.advance(125)
  for (let i = 0; i < 50; i++) await h.journal.consumeRunBudget(h.f.rootSessionId, h.f.runId, 'root-model')
  await assert.rejects(h.journal.consumeRunBudget(h.f.rootSessionId, h.f.runId, 'root-model'), /预算/)
  h.runtime.halt(h.f.rootSessionId); await h.runtime.flush(h.f.rootSessionId)
  assert.equal(h.account().blocked.resource, 'root-model')
  assert.equal(h.account().recovery.blocks, 1)
  assert.equal(h.account().time.observedMs, 125)
  assert.equal(h.account().time.reservedMs, 0)
})

test('same-ID rework keeps the original duration balance', async t => {
  const clock = childClock()
  const h = await controllerFixture(t, { childClock: clock,
    runBudgetConfig: { runTimeBudgetEnabled: true, runActiveMs: 10_000 } })
  await h.setup(); await h.advance()
  const first = h.child('author')
  clock.advance(50)
  await h.controller.report(first, { role: 'engineer', text: '功能已就绪' }, signal); await h.settle(first)
  await h.qa(false)
  const before = h.snapshot().run.budget.time.observedMs
  await h.controller.returnForRework(h.root, h.revision(), signal)
  await h.advance()
  const rework = h.child('author')
  assert.equal(rework.id, first.id)
  clock.advance(75)
  await h.controller.report(rework, { role: 'engineer', text: '测试功能已就绪' }, signal); await h.settle(rework)
  await h.controller.runTime.flush(h.root.id)
  assert.equal(h.snapshot().run.budget.time.observedMs, before + 75)
})

test('closing the old clock at its deadline cannot silently start a fresh allowance', async t => {
  const h = await timedController(t)
  await h.controller.admitModelRequest(h.root)
  h.clock.advance(90)
  await h.controller.stop(h.root)
  assert.equal(h.snapshot().run.outcome, 'CANCELLED')
  const oldRun = h.snapshot().run.runId, release = h.controller.runTime.release.bind(h.controller.runTime)
  h.controller.runTime.release = async id => { h.clock.advance(10); await release(id) }
  await assert.rejects(h.controller.propose(h.root, proposal(h.snapshot().revision), signal), /预算/)
  assert.equal(h.snapshot().run.runId, oldRun)
  assert.equal(h.snapshot().run.budget.blocked.resource, 'active-time')
  assert.equal(h.snapshot().history.length, 1)
})

test('controller unload is bounded even when a final time checkpoint stalls', async t => {
  const h = await controllerFixture(t), clock = childClock()
  const next = new WorkflowTextController(h.journal, h.artifacts, h.driver, undefined,
    { childCancelGraceMs: 1000 }, clock, {}, { runBudgetEnabled: true, runBudgetScope: 'all', ...timedConfig })
  next.bindRoot(h.root)
  await next.propose(h.root, proposal(0), signal)
  await next.admitModelRequest(h.root)
  clock.advance(10)
  const put = h.table.put, entered = Promise.withResolvers(), finish = Promise.withResolvers()
  h.table.put = async (...args) => { entered.resolve(); await finish.promise; return put(...args) }
  const closing = next.close()
  const denied = assert.rejects(closing, /卸载回收未在期限内确认/)
  await entered.promise; clock.advance(1000); await denied
  finish.resolve(); await flushChild(); await next.runTime.flush(h.root.id)
  assert.equal(h.snapshot().run.budget.time.observedMs, 10)
  assert.equal(h.snapshot().run.outcome, null)
})
