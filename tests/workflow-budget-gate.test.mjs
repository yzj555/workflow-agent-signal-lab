import assert from 'node:assert/strict'
import test from 'node:test'
import { selectBudgetGate, decideBudget, discussBudget } from '../lib/workflow-budget-gate.js'
import { budgetQuestion } from '../lib/workflow-budget-recovery.js'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { displayWorkflowState, workflowStatusLabel } from '../lib/workflow-display.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'

function gate(action = 'topup') {
  const calls = []
  const account = { limits: { modelRequests: 2, commands: 4, activeMs: 60000 }, used: { rootModel: 1, childModel: 1, commands: 2 },
    time: { observedMs: 10000, uncertainMs: 1000, reservedMs: 0, overrunMs: 0 } }
  const question = budgetQuestion(account, { id: 'frozen-request', action, reason: '核对后申请 *不是额外授权*',
    add: { modelRequests: action === 'topup' ? 3 : 0, commands: 0, activeMs: action === 'topup' ? 60000 : 0 } })
  const wait = { kind: 'plan-review', sessionId: 'owner', key: 'native-key', questions: [question],
    async answer(value) { assert.equal(this, wait); calls.push(value) },
    async cancel() { assert.equal(this, wait); calls.push('cancel') } }
  return { wait, calls, owner: { sessionId: 'owner', pendingInteraction: wait } }
}
test('both budget gates preserve the exact native owner, original id, label and wait methods', async () => {
  for (const action of ['topup', 'end']) {
    const f = gate(action)
    assert.equal(selectBudgetGate(f.owner), f.wait)
    f.wait.questions[0].options.reverse()
    assert.equal(selectBudgetGate(f.owner), f.wait)
    for (const choice of ['keep', 'approve']) await decideBudget(f.wait, choice)
    await discussBudget(f.wait)
    assert.deepEqual(f.calls, [
      { answers: [{ id: 'frozen-request', selected: ['保持暂停'] }] },
      { answers: [{ id: 'frozen-request', selected: [f.wait.questions[0].intent.approve] }] }, 'cancel',
    ])
    assert.equal(selectBudgetGate({ ...f.owner, sessionId: 'other' }), null)
  }
})
test('ordinary/forged/mismatched/batch budget-like questions fall back to the native renderer', () => {
  for (const mutate of [
    f => f.wait.kind = 'question', f => f.wait.key = '', f => f.wait.answer = null, f => f.wait.cancel = null,
    f => f.wait.questions = [], f => f.wait.questions.push(f.wait.questions[0]), f => f.wait.questions[0] = null,
    f => f.wait.questions[0].id = '', f => f.wait.questions[0].header = '计划',
    f => f.wait.questions[0].question = '是否执行？', f => f.wait.questions[0].question = '是否结束本轮工作流？',
    f => f.wait.questions[0].detail = '', f => f.wait.questions[0].multiSelect = true,
    f => f.wait.questions[0].intent.approve = '确认执行', f => f.wait.questions[0].intent = null,
    f => f.wait.questions[0].options.push({ label: '第三项' }), f => f.wait.questions[0].options[0] = f.wait.questions[0].options[1],
    f => f.wait.questions[0].options[0].description = {}, f => f.wait.sessionId = 'other',
  ]) { const f = gate(); mutate(f); assert.equal(selectBudgetGate(f.owner), null) }
  for (const value of [null, undefined, [], '', true, 42]) assert.equal(selectBudgetGate({ sessionId: 'owner', pendingInteraction: value }), null)
})
test('budget details expose frozen amounts, time, reason and authority boundaries, not generic execution wording', () => {
  const topup = gate().wait.questions[0], end = gate('end').wait.questions[0]
  assert.match(topup.detail, /\| 模型请求 \| 2 \/ 2 次 \| 3 次 \| 5 次 \|/)
  assert.match(topup.detail, /\| 检查命令 \| 2 \/ 4 次 \| 0 次 \| 4 次 \|/)
  assert.match(topup.detail, /有效时长本次增加 1分0\.0秒；累计上限变为 2分0\.0秒/)
  assert.match(topup.detail, /申请原因/)
  assert.match(topup.detail, /不扩大任务或工具权限/)
  assert.match(topup.detail, /等待你在原生输入框明确继续/)
  assert.match(end.detail, /不撤销文件，不删除数据/)
  assert.match(end.detail, /不是验收通过/)
})
test('budget decision and cancellation failures remain observable to native UI retry', async () => {
  const f = gate()
  f.wait.answer = async () => { throw new Error('expired') }
  await assert.rejects(decideBudget(f.wait, 'approve'), /expired/)
  f.wait.cancel = async () => { throw new Error('cancel failed') }
  await assert.rejects(discussBudget(f.wait), /cancel failed/)
})

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
async function snapshot(t) {
  const f = fixture(), journal = new WorkflowJournal(memoryTable())
  t.after(() => journal.close())
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [...f.initial(), f.approve()],
    runBudgetLimits: { modelRequests: 1, commands: 1 } })
  await journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model')
  await assert.rejects(journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model'))
  return structuredClone(journal.readSnapshot(f.rootSessionId))
}
const project = value => displayWorkflowState({ status: 'ready', snapshot: value }, [], stages)
test('native status preserves all budget states instead of falling back to generic confirmation', async t => {
  const value = await snapshot(t)
  assert.equal(workflowStatusLabel(project(value)), '预算耗尽')
  value.run.budget.blocked.resource = 'active-time'
  assert.equal(workflowStatusLabel(project(value)), '时长预算耗尽')
  for (const [action, expected] of [['topup', '待补额确认'], ['end', '待结束确认']]) {
    value.run.budget.recovery.requests = [{ action, status: 'pending' }]
    assert.equal(workflowStatusLabel(project(value)), expected)
  }
  value.run.budget.blocked = null
  value.run.budget.recovery.requests = []
  value.run.budget.recovery.awaitingResume = true
  assert.equal(workflowStatusLabel(project(value)), '等待继续')
})
test('budget cannot hide unknown/stopping/confirmed drain or manual recovery and rollback decisions', async t => {
  const value = await snapshot(t)
  value.run.agents = [{ role: 'engineer', taskId: 'normalize', taskTitle: '测试', status: 'interrupted',
    runtimeIssue: { status: 'unknown', reason: '缺少退出凭据' } }]
  for (const [status, expected] of [['unknown', '未确认停止'], ['stopping', '正在停止'], ['stopped', '已停止 · 需要处理']]) {
    value.run.agents[0].runtimeIssue.status = status
    assert.equal(workflowStatusLabel(project(value)), expected)
  }
  value.run.agents = []
  value.run.gates.push({ kind: 'runtime-recovery', status: 'waiting', stale: false, scopeTaskIds: [], summary: '核实后人工处置' })
  assert.equal(workflowStatusLabel(project(value)), '待人工处置')
  value.run.gates.pop()
  value.run.gates.push({ kind: 'rollback', requiredActor: 'user', status: 'waiting', stale: false, scopeTaskIds: [], summary: '撤销决定' })
  assert.equal(workflowStatusLabel(project(value)), '待撤销确认')
})
test('ended runs without learning evidence show not-started, not imaginary activity; real candidates remain visible', async t => {
  const value = await snapshot(t)
  value.run.tasks.forEach(task => task.status = 'cancelled')
  value.run.outcome = 'CANCELLED'
  value.run.budget.recovery.closed = true
  let view = project(value)
  assert.equal(workflowStatusLabel(view), '已取消')
  assert.equal(view.needsUser, false)
  assert.equal(view.attentionTitle, '本轮已结束，无需操作')
  assert.equal(view.stageDetails[6].state, 'not_run')
  assert.equal(view.stageDetails[6].label, '未整理')
  assert.doesNotMatch(JSON.stringify(view), /正在整理|沉淀待整理/)
  value.run.budget = null
  value.run.outcome = 'PASS'
  view = project(value)
  assert.equal(view.badge, '通过')
  assert.equal(view.stageDetails[6].state, 'not_run')
  assert.match(view.now, /经验尚未整理/)
  value.run.proposedLearningCount = 1
  view = project(value)
  assert.equal(view.needsUser, true)
  assert.equal(view.stageDetails[6].state, 'waiting')
  assert.match(view.now, /沉淀建议正在等待逐项确认/)
})
