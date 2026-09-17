import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { ChildLeaseWatchdog, resolveChildWatchdogConfig, WorkflowTextController } from '../lib/workflow-control.js'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { controllerFixture, reportQA, signal } from './helpers/workflow-controller-fixture.mjs'
import { childClock, childConfig, flushChild } from './helpers/workflow-child-clock.mjs'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const display = snapshot => displayWorkflowState({ status: 'ready', snapshot }, [], stages)

test('child budgets reject invalid configuration and normalize per-role defaults', () => {
  for (const value of [0, -1, 999, 1.5, '1000', NaN, Infinity, 2147483648]) {
    assert.throws(() => resolveChildWatchdogConfig({ childAdmissionMs: value }), /safe integer/)
  }
  assert.throws(() => resolveChildWatchdogConfig({ childNoProgressMs: 5000, childMaxRunMs: 1000 }), /cover/)
  assert.throws(() => resolveChildWatchdogConfig({ childRoleBudgets: { pm: { noProgressMs: 1000 } } }), /unsupported/)
  assert.throws(() => resolveChildWatchdogConfig({ childRoleBudgets: { engineer: { unknown: true } } }), /invalid/)
  const config = resolveChildWatchdogConfig({ ...childConfig, childRoleBudgets: { engineer: { noProgressMs: 3000 } } })
  assert.deepEqual(config.childRoleBudgets.engineer, { noProgressMs: 3000, maxRunMs: 5000 })
})

test('independent clocks enforce admission, progress, total duration and report exit without resetting the total limit', () => {
  const clock = childClock(), events = []
  const watchdog = new ChildLeaseWatchdog(childConfig, clock, (token, expiry) => events.push({ token, ...expiry }))
  const admission = {}, busy = {}, reporting = {}
  watchdog.watch(admission, 'architect')
  watchdog.watch(busy, 'engineer'); watchdog.admitted(busy)
  watchdog.watch(reporting, 'test_engineer'); watchdog.admitted(reporting)
  clock.advance(999); assert.equal(events.length, 0)
  clock.advance(1); assert.equal(events[0].cause, 'admission-timeout')
  watchdog.reported(reporting)
  watchdog.progress(busy)
  clock.advance(999); watchdog.progress(reporting); watchdog.progress(busy)
  clock.advance(1); assert.equal(events[1].cause, 'report-timeout')
  for (let i = 0; i < 3; i++) { watchdog.progress(busy); clock.advance(1000) }
  assert.equal(events[2].cause, 'deadline')
  assert.equal(events[2].elapsedMs, 5000)
  assert.equal(clock.count(), 0)
})

test('per-role budgets and exact dispatch tokens do not leak across same-role siblings', () => {
  const clock = childClock(), events = []
  const config = resolveChildWatchdogConfig({ ...childConfig, childRoleBudgets: { code_reviewer: { noProgressMs: 3000, maxRunMs: 5000 } } })
  const watchdog = new ChildLeaseWatchdog(config, clock, (token, observation) => events.push({ token, ...observation }))
  const stalled = {}, moving = {}, reviewer = {}
  for (const [token, role] of [[stalled, 'engineer'], [moving, 'engineer'], [reviewer, 'code_reviewer']]) {
    watchdog.watch(token, role); watchdog.admitted(token)
  }
  clock.advance(1000); watchdog.progress(moving)
  clock.advance(1000)
  assert.deepEqual(events.map(event => event.token), [stalled])
  watchdog.forget(moving)
  clock.advance(1000)
  assert.deepEqual(events.map(event => event.token), [stalled, reviewer])
  watchdog.close(); assert.equal(clock.count(), 0)
})

test('expiry revokes capabilities before drain, rejects late reports, and never creates acceptance failure or retry', async t => {
  const clock = childClock(), drain = Promise.withResolvers()
  const f = await controllerFixture(t, { childConfig, childClock: clock, drain: () => drain.promise })
  await f.setup(); await f.advance()
  const agent = f.child('author')
  clock.advance(2000)
  assert.ok(f.controller.guard(agent, 'workflow_report'))
  await assert.rejects(f.controller.report(agent, { role: 'engineer', text: 'late' }, signal), /关闭/)
  await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'stopping')
  assert.equal(display(f.snapshot()).badge, '正在停止')
  assert.equal(display(f.snapshot()).needsUser, false)
  assert.ok(f.calls.filter(call => call.operation === 'drain').every(call => call.ids.length === 1 && call.ids[0] === agent.id))
  clock.advance(1000); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  assert.equal(display(f.snapshot()).badge, '未确认停止')
  assert.equal(display(f.snapshot()).needsUser, true)
  await f.controller.settled(agent.id, true)
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'unknown', 'late end alone does not prove owned cleanup completed')
  drain.resolve(); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'stopped')
  assert.equal(f.snapshot().run.agents[0].status, 'interrupted')
  assert.equal(f.snapshot().run.tasks[0].status, 'blocked')
  assert.equal(f.snapshot().run.ledger.fail, 0)
  assert.equal(f.snapshot().run.latestReturn, null)
  assert.equal(display(f.snapshot()).badge, '已停止 · 需要处理')
  await assert.rejects(f.advance(), /禁止自动续跑/)
  clock.advance(20000); await flushChild()
  assert.equal(f.calls.filter(call => call.operation === 'start').length, 1)
  await f.controller.stop(f.root)
  assert.equal(f.snapshot().run.outcome, 'CANCELLED')
})

test('an ignored admission abort cannot hold the coordinator forever or authorize a late materialization', async t => {
  const clock = childClock(), start = Promise.withResolvers()
  const f = await controllerFixture(t, { childConfig, childClock: clock, start: () => start.promise })
  await f.setup()
  const advancing = f.advance()
  const rejected = assert.rejects(advancing, /期限/)
  await flushChild()
  clock.advance(1000)
  await rejected; await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.cause, 'admission-timeout')
  clock.advance(1000); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'unknown', 'early no-op drain does not prove an unresolved admission stopped')
  const childId = f.snapshot().run.agents[0].agentSessionId
  assert.throws(() => f.controller.bindChild({ id: childId }), /失效/)
  start.resolve(); await flushChild()
  assert.equal(f.live.has(childId), false)
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'stopped')
})

test('report acceptance starts a separate exit grace and missing native end invalidates provisional work', async t => {
  const clock = childClock()
  const f = await controllerFixture(t, { childConfig, childClock: clock })
  await f.setup(); await f.advance()
  const agent = f.child('author')
  clock.advance(1500)
  await f.controller.report(agent, { role: 'engineer', text: '测试公告' }, signal)
  clock.advance(999); f.controller.observeChildProgress(agent)
  assert.equal(f.snapshot().run.agents[0].runtimeIssue, undefined)
  clock.advance(1); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.cause, 'report-timeout')
  assert.equal(f.snapshot().run.tasks[0].status, 'invalidated')
  assert.equal(f.snapshot().run.outcome, null)
})

test('native dispose-before-end is normal; stale lifecycle epochs cannot settle a new same-ID rework', async t => {
  const clock = childClock()
  const f = await controllerFixture(t, { childConfig, childClock: clock })
  await f.setup(); await f.advance()
  const original = f.child('author')
  f.controller.observeChildStart(original.id, 'epoch-1')
  await f.controller.report(original, { role: 'engineer', text: '测试公告' }, signal)
  f.controller.observeChildDisposed(original)
  assert.ok(f.controller.guard(original, 'workflow_packet'))
  f.live.delete(original.id)
  await f.controller.settled(original.id, true, 'epoch-1')
  clock.advance(2000)
  assert.equal(f.snapshot().run.agents[0].runtimeIssue, undefined)
  await f.advance()
  const qa = f.child('acceptance')
  await f.controller.report(qa, reportQA(false), signal); await f.settle(qa)
  await f.controller.returnForRework(f.root, f.revision(), signal)
  await f.advance()
  const current = f.child('author')
  assert.equal(current.id, original.id)
  f.controller.observeChildStart(current.id, 'epoch-2')
  await f.controller.settled(original.id, true, 'epoch-1')
  assert.equal(f.controller.guard(current, 'workflow_packet'), undefined)
  clock.advance(2000); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.cause, 'no-progress', 'old completion must not disarm the current lease clock')
})

test('cold replay exposes unknown historical assignments once, without new children, approval or success', async t => {
  const f = await controllerFixture(t)
  await f.setup(); await f.advance(); await f.controller.close()
  const callsBefore = f.calls.length
  const cold = new WorkflowTextController(f.journal, f.artifacts, f.driver)
  cold.bindRoot(f.root)
  await cold.recoverOrphanedLeases()
  const snapshot = f.snapshot()
  assert.equal(snapshot.run.agents[0].runtimeIssue.cause, 'host-restart')
  assert.equal(snapshot.run.agents[0].runtimeIssue.status, 'unknown')
  assert.equal(display(snapshot).agents[0].status, '未确认停止')
  assert.equal(snapshot.run.outcome, null)
  assert.equal(f.calls.length, callsBefore)
  await cold.recoverOrphanedLeases()
  assert.equal(f.snapshot().revision, snapshot.revision)
  await assert.rejects(cold.advance(f.root, f.revision(), signal), /禁止自动续跑/)
  const stopped = await cold.stop(f.root)
  assert.equal(stopped.stopped, false, 'new-Host no-op drain is not proof that the old epoch stopped')
  assert.equal(f.snapshot().run.outcome, null)
  await cold.close()
})

test('runtime event replay rejects actor forgery, stale versions, false stop and non-monotonic recovery', async t => {
  const f = await controllerFixture(t)
  await f.setup(); await f.advance()
  const agent = f.snapshot().run.agents[0]
  const issue = { incidentId: 'issue', assignmentId: agent.assignmentId, taskVersion: agent.taskVersion,
    cause: 'no-progress', status: 'stopping', budgetMs: 2000, elapsedMs: 2000, reason: 'fixture timeout' }
  const commit = (payload, actor = { kind: 'system', id: 'workflow-controller/1' }) => f.journal.commit({
    rootSessionId: f.root.id, expectedRevision: f.snapshot().revision,
    events: [{ version: 1, runId: f.snapshot().run.runId, eventId: randomUUID(), name: 'agent/runtime-interrupted', actor, payload }],
  })
  await assert.rejects(commit(issue, { kind: 'agent', id: agent.agentSessionId, role: 'engineer' }), /only the Host/)
  await assert.rejects(commit({ ...issue, taskVersion: 99 }), /stale/)
  await assert.rejects(commit({ ...issue, status: 'stopped' }), /without claiming a stop/)
  await commit(issue)
  await commit({ ...issue, status: 'unknown' })
  await assert.rejects(commit({ ...issue, incidentId: 'wrong', status: 'stopped' }), /identity/)
  await commit({ ...issue, status: 'stopped' })
  await assert.rejects(commit({ ...issue, status: 'unknown' }), /monotonic/)
})

test('explicit stop is bounded and never declares cancellation while owned cleanup remains unconfirmed', async t => {
  const clock = childClock(), drain = Promise.withResolvers()
  const f = await controllerFixture(t, { childConfig, childClock: clock, drain: () => drain.promise })
  await f.setup(); await f.advance()
  const agent = f.child('author'), stopping = f.controller.stop(f.root)
  assert.ok(f.controller.guard(agent, 'workflow_packet'))
  clock.advance(1000)
  const result = await stopping
  assert.equal(result.stopped, false)
  assert.equal(f.snapshot().run.outcome, null)
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  drain.resolve(); await flushChild()
  await f.controller.stop(f.root)
  assert.equal(f.snapshot().run.outcome, 'CANCELLED')
})
