import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const reason = '整轮预算耗尽，官方回收已完成；需要决定如何继续。请使用 /workflow-budget end。'
const project = value => displayWorkflowState({ status: 'ready', snapshot: value }, [], stages)

test('an interrupted current role without a valid report is actionable in both durable projection and UI', async t => {
  const f = fixture(), journal = new WorkflowJournal(memoryTable())
  t.after(() => journal.close())
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [
    ...f.initial(), f.approve(), f.readyTask(), f.runTask(), f.assign(),
    f.event('task/status-changed', { taskId: 'normalize', taskVersion: 1,
      expectedStatus: 'running', status: 'failed', reason: '没有有效的角色报告' }),
    f.event('agent/settled', { assignmentId: 'assignment-normalize', outcome: 'interrupted', summary: '原生模型调用异常' }),
  ] })
  const value = journal.readSnapshot(f.rootSessionId), before = structuredClone(value), view = project(value)
  assert.equal(value.run.needsUser, true)
  assert.equal(view.needsUser, true); assert.equal(view.badge, '角色执行异常')
  assert.match(view.now, /实现 Agent 未正常完成/u)
  assert.match(view.summary, /不等于业务验收失败/u)
  assert.match(view.next, /停止本轮.*重新确认/u)
  assert.equal(value.run.outcome, null); assert.equal(value.run.ledger.fail, 0)
  assert.equal(value.run.latestReturn, null); assert.deepEqual(value, before)

  // A later completed/current version or terminal run must not inherit a historical prompt.
  for (const update of [
    run => { run.tasks[0].version++ }, run => { run.tasks[0].status = 'completed' },
    run => { run.outcome = 'CANCELLED' }, run => { run.agents[0].status = 'idle' },
  ]) {
    const historical = structuredClone(value); update(historical.run)
    assert.notEqual(project(historical).badge, '角色执行异常')
  }
  const invalidated = structuredClone(value); invalidated.run.tasks[0].status = 'invalidated'
  assert.equal(project(invalidated).badge, '角色执行异常', 'a report invalidated by abnormal native exit is not a success')
})
async function snapshot(t, outcome = null, status = 'stopped') {
  const f = fixture(), journal = new WorkflowJournal(memoryTable())
  t.after(() => journal.close())
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [...f.initial(), f.approve()] })
  const value = structuredClone(journal.readSnapshot(f.rootSessionId)), task = value.run.tasks[0]
  value.run.outcome = outcome
  value.run.agents = [{ assignmentId: 'assignment-normalize', agentSessionId: 'child-normalize',
    taskId: task.taskId, taskVersion: task.version, taskTitle: task.title, role: task.role,
    status: 'interrupted', lastSummary: reason,
    runtimeIssue: { incidentId: 'interruption-1', assignmentId: 'assignment-normalize', taskVersion: task.version,
      cause: 'run-budget', status, budgetMs: 0, elapsedMs: 0, reason } }]
  return value
}
function closeBudget(value) {
  const limits = { modelRequests: 10, commands: 1 }
  value.run.budget = { runId: value.run.runId, limits, used: { rootModel: 1, childModel: 2, commands: 1 },
    blocked: { resource: 'command', recordedAt: 1 }, recovery: { initialLimits: limits, blocks: 1,
      controlUsed: 0, requests: [], closed: true, resumes: 0, awaitingResume: false } }
}

test('a stopped role in an open run still requires disposition, not history-only presentation', async t => {
  const value = await snapshot(t), before = structuredClone(value), view = project(value)
  assert.equal(view.agents[0].status, '已停止 · 需处理')
  assert.equal(view.needsUser, true)
  assert.ok(view.agents[0].detail.includes(reason))
  assert.equal(view.agents[0].interruptionHistory, undefined)
  assert.deepEqual(value, before)
})

test('every terminal outcome distinguishes a confirmed stopped role from a current action request', async t => {
  for (const outcome of ['CANCELLED', 'FAIL', 'QUALIFIED', 'PASS', 'ABANDONED']) {
    const value = await snapshot(t, outcome), before = structuredClone(value), row = project(value).agents[0]
    assert.equal(row.status, '已停止 · 本轮已结束', outcome)
    assert.equal(row.tone, 'waiting', 'not a completed/pass claim or an active error')
    assert.doesNotMatch(row.detail, /需要决定|workflow-budget|需处理/u)
    assert.deepEqual(row.interruptionHistory, [reason])
    assert.deepEqual(value, before, 'projection must not rewrite lifecycle, evidence or outcome')
  }
})

test('budget close and terminal outcome agree without removing interruption evidence', async t => {
  const value = await snapshot(t, 'CANCELLED')
  closeBudget(value)
  const before = structuredClone(value), view = project(value)
  assert.equal(view.badge, '已取消')
  assert.equal(view.attentionTitle, '本轮已结束，无需操作')
  assert.equal(view.needsUser, false)
  assert.equal(view.agents[0].status, '已停止 · 本轮已结束')
  assert.deepEqual(view.agents[0].interruptionHistory, [reason])
  assert.deepEqual(value, before)
})

test('a budget closed marker alone is not a terminal outcome or permission to hide a stopped-role decision', async t => {
  const value = await snapshot(t)
  closeBudget(value)
  const view = project(value)
  assert.equal(view.agents[0].status, '已停止 · 需处理')
  assert.equal(view.agents[0].interruptionHistory, undefined)
  assert.equal(view.needsUser, true)
})

test('unknown and stopping remain prominent even beside a terminal outcome and closed budget', async t => {
  for (const outcome of ['CANCELLED', 'ABANDONED']) for (const [status, label] of [['unknown', '未确认停止'], ['stopping', '正在停止']]) {
    const value = await snapshot(t, outcome, status)
    closeBudget(value)
    const before = structuredClone(value), view = project(value)
    assert.equal(view.agents[0].status, label)
    assert.equal(view.agents[0].interruptionHistory, undefined)
    assert.ok(view.agents[0].detail.includes(reason))
    assert.equal(view.badge, label)
    assert.equal(view.needsUser, status === 'unknown')
    assert.deepEqual(value, before)
  }
})

test('manual abandonment never converts unknown exit or verification statements into confirmed stop', async t => {
  const value = await snapshot(t, 'ABANDONED', 'unknown')
  value.run.manualClose = { reason: '仅人工结束旧运行', checks: [{ assignmentId: 'assignment-normalize', evidence: [] }],
    recordedAt: 1, decisionAudit: { channel: 'native-question', operator: 'unverified', requestId: 'test-close' } }
  const before = structuredClone(value), view = project(value)
  assert.equal(view.badge, '人工结束')
  assert.match(view.completionNotice, /Host 退出未证实/u)
  assert.equal(view.agents[0].status, '未确认停止')
  assert.equal(view.agents[0].interruptionHistory, undefined)
  assert.deepEqual(view.agents[0].verification, value.run.manualClose.checks[0])
  assert.deepEqual(value, before)
})

test('historical detail preserves distinct incident and last report verbatim, independent of budget fields', async t => {
  const value = await snapshot(t, 'FAIL')
  delete value.run.budget // Compatible with snapshots before run-budget fields existed.
  value.run.agents[0].runtimeIssue.cause = 'command-timeout'
  value.run.agents[0].lastSummary = '单独报告：路径 C:\\测试\\结果，保留原样。'
  const before = structuredClone(value), row = project(value).agents[0]
  assert.equal(row.status, '已停止 · 本轮已结束')
  assert.deepEqual(row.interruptionHistory, [reason, value.run.agents[0].lastSummary])
  assert.deepEqual(value, before)
})

test('normal PASS and recorded running roles do not acquire interruption history or false stop evidence', async t => {
  const value = await snapshot(t, 'PASS'), agent = value.run.agents[0]
  delete agent.runtimeIssue
  value.run.tasks[0].status = 'completed'
  agent.status = 'idle'; agent.lastSummary = '角色正常完成'
  let row = project(value).agents[0]
  assert.equal(row.status, '已完成')
  assert.equal(row.interruptionHistory, undefined)
  assert.match(row.detail, /角色正常完成/u)
  agent.status = 'running'
  row = project(value).agents[0]
  assert.equal(row.status, '运行记录')
  assert.equal(row.tone, 'active')
  assert.equal(row.interruptionHistory, undefined)
})
