import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowSnapshotSource } from '../lib/workflow-source.js'
import { displayPreRunConversation, displayWorkflowState } from '../lib/workflow-display.js'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const success = value => ({ ok: true, value })
const absent = id => ({ schemaVersion: 1, source: 'plugin-journal', rootSessionId: id, revision: 0, availability: 'absent', run: null, history: [] })

test('budget-only changes reach native projections without changing workflow revision, and stale budget views are rejected', async t => {
  const f = fixture(), journal = new WorkflowJournal(memoryTable())
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial(),
    runBudgetLimits: { modelRequests: 1, commands: 1 } })
  const before = journal.readSnapshot(f.rootSessionId)
  const requests = []
  const source = new WorkflowSnapshotSource({ call: () => new Promise(resolve => requests.push(resolve)) }, { pollMs: 2 })
  t.after(async () => { source.dispose(); await journal.close() })
  source.subscribe(f.rootSessionId, () => {})
  requests[0](success(before)); await tick()
  await journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model')
  await assert.rejects(journal.consumeRunBudget(f.rootSessionId, f.runId, 'child-model'))
  const after = journal.readSnapshot(f.rootSessionId)
  while (requests.length < 2) await tick()
  requests[1](success(after)); await tick()
  assert.equal(source.getSnapshot(f.rootSessionId).snapshot.revision, before.revision)
  assert.equal(source.getSnapshot(f.rootSessionId).snapshot.budgetRevision, after.budgetRevision)
  const display = displayWorkflowState(source.getSnapshot(f.rootSessionId), [], stages)
  assert.equal(display.badge, '预算耗尽')
  assert.match(display.nowDetail, /协调 1、子角色 0/)
  assert.match(display.attentionDetail, /不证明后台已停止/)
  assert.equal(display.needsUser, true)
  source.connectionChanged(false); source.connectionChanged(true)
  requests.at(-1)(success(before)); await tick()
  assert.equal(source.getSnapshot(f.rootSessionId).status, 'unavailable')
})

test('pre-run clarification is visible without inventing a Journal run or approval', () => {
  const display = displayPreRunConversation({
    blank: false, hasUserGoal: true, running: false, pending: null, interrupted: false,
    assistantText: '当前还缺少客户范围、访谈来源、时间边界和篇幅；请先补充这些要点。',
  }, [], stages)
  assert.equal(display.stageIndex, 0)
  assert.equal(display.badge, '待你回复')
  assert.equal(display.needsUser, true)
  assert.match(display.now, /等待你补充/)
  assert.match(display.next, /合并目标、边界与验收标准/)
  assert.match(display.source, /尚未建立受控运行记录/)
  assert.equal(display.stageStates[0], 'waiting')
  assert.doesNotMatch(`${display.title} ${display.summary}`, /正在实现|已确认/)
})

test('a discussion that ends without a run is not painted as waiting approval or background execution', () => {
  const display = displayPreRunConversation({
    blank: false, hasUserGoal: true, running: false, pending: null, interrupted: false,
    assistantText: '由于缺少外发许可，本次评估结论是不执行；没有后台任务。',
  }, [], stages)
  assert.equal(display.badge, '未启动执行')
  assert.equal(display.needsUser, false)
  assert.match(display.now, /讨论已经结束/)
  assert.match(display.next, /没有自动下一步/)
  assert.deepEqual(display.stageStates.slice(1), Array(6).fill('not_run'))
})

test('pre-run recovery is explicit without implying a run, approval or execution', () => {
  const base = {
    blank: false, hasUserGoal: true, running: false, pending: null, interrupted: true,
    assistantText: '',
    recovery: {
      incidentId: 'ingress-1', status: 'recovering', attempt: 1, turn: 2,
      stage: 'requirements', noProgressMs: 180000, journalRevision: 0,
      reason: '需求分析无进展。', preserved: ['原生目标', 'Signal Gate 关闭'],
      resumeFrom: '重新读取目标并继续澄清',
    },
  }
  let display = displayPreRunConversation(base, [], stages)
  assert.equal(display.badge, '自动恢复中')
  assert.equal(display.needsUser, false)
  assert.match(display.summary, /Signal Gate 仍关闭/)
  assert.match(display.next, /需求分析与澄清/)
  assert.doesNotMatch(`${display.title} ${display.summary}`, /已批准|正在实现/)

  display = displayPreRunConversation({
    ...base,
    recovery: { ...base.recovery, status: 'needs-attention', attempt: 2, journalRevision: 1 },
  }, [], stages)
  assert.equal(display.badge, '需要处理')
  assert.equal(display.needsUser, true)
  assert.match(display.attentionDetail, /原生输入框/)
})

async function view() {
  const f = fixture()
  const journal = new WorkflowJournal(memoryTable())
  return journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
}

test('header and native view share one read per Session and unsubscribe aborts the last request', async t => {
  const requests = []
  const rpc = { call: (_channel, _method, payload, signal) => new Promise(resolve => requests.push({ payload, signal, resolve })) }
  const source = new WorkflowSnapshotSource(rpc, { pollMs: 10000 })
  t.after(() => source.dispose())
  const offHeader = source.subscribe('session-a', () => {})
  const offDock = source.subscribe('session-a', () => {})
  assert.equal(requests.length, 1)
  offHeader(); assert.equal(requests[0].signal.aborted, false)
  offDock(); assert.equal(requests[0].signal.aborted, true)
  assert.equal(source.getSnapshot('session-a').status, 'loading')
  requests[0].resolve(success(await view()))
  await tick()
  assert.equal(source.getSnapshot('session-a').status, 'loading')
})

test('connection loss clears visible approvals and ignores a late response from the old generation', async t => {
  const requests = []
  const source = new WorkflowSnapshotSource({ call: (_c, _m, _p, signal) => new Promise(resolve => requests.push({ signal, resolve })) }, { pollMs: 10000 })
  t.after(() => source.dispose())
  source.subscribe('session-a', () => {})
  source.connectionChanged(false)
  assert.equal(source.getSnapshot('session-a').status, 'unavailable')
  assert.equal(requests[0].signal.aborted, true)
  source.connectionChanged(true)
  assert.equal(requests.length, 2)
  requests[0].resolve(success(await view()))
  await tick()
  assert.equal(source.getSnapshot('session-a').status, 'loading')
  requests[1].resolve(success(absent('session-a')))
  await tick()
  assert.equal(source.getSnapshot('session-a').status, 'absent')
})

test('a failed read never leaves the previous committed view displayed as current', async t => {
  const requests = []
  const source = new WorkflowSnapshotSource({ call: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) }, { pollMs: 2 })
  t.after(() => source.dispose())
  source.subscribe('session-a', () => {})
  requests[0].resolve(success(await view()))
  await tick()
  assert.equal(source.getSnapshot('session-a').status, 'ready')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(requests.length, 2)
  requests[1].reject(new Error('network failed'))
  await tick()
  assert.equal(source.getSnapshot('session-a').snapshot, null)
  assert.equal(source.getSnapshot('session-a').status, 'unavailable')
})

test('backwards revisions remain rejected even after a temporary failure', async t => {
  const requests = []
  const source = new WorkflowSnapshotSource({ call: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) }, { pollMs: 10000 })
  t.after(() => source.dispose())
  source.subscribe('session-a', () => {})
  requests[0].resolve(success(await view()))
  await tick()
  source.connectionChanged(false)
  source.connectionChanged(true)
  requests[1].resolve(success(absent('session-a')))
  await tick()
  assert.equal(source.getSnapshot('session-a').status, 'unavailable')
})

test('request timeouts abort transport and publish unavailable without indefinite overlap', async t => {
  let signal
  const source = new WorkflowSnapshotSource({ call: (_c, _m, _p, input) => { signal = input; return new Promise(() => {}) } }, { timeoutMs: 5, pollMs: 10000 })
  t.after(() => source.dispose())
  source.subscribe('session-a', () => {})
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(signal.aborted, true)
  assert.equal(source.getSnapshot('session-a').status, 'unavailable')
})

test('empty or unavailable structured data never becomes a guessed approval or completion', () => {
  const native = [{ label: '原生实现 Agent', detail: '当前观察', status: '进行中', tone: 'active' }]
  const empty = displayWorkflowState({ status: 'absent', snapshot: absent('session-a') }, native, stages)
  assert.equal(empty.stageIndex, -1)
  assert.equal(empty.badge, '尚无记录')
  assert.equal(empty.needsUser, false)
  assert.equal(empty.agents.length, 1)
  assert.deepEqual(empty.stageStates, Array(7).fill('locked'))
  const unavailable = displayWorkflowState({ status: 'unavailable', snapshot: null }, native, stages)
  assert.equal(unavailable.badge, '未确认')
  assert.equal(unavailable.agents.length, 0)
  assert.match(unavailable.live, /不能据此判断/)
})

test('displaying a later stage does not automatically mark all preceding stages complete', async () => {
  const snapshot = await view()
  snapshot.run.stage = 'verification'
  const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.equal(display.stageIndex, 3)
  assert.equal(display.stageStates[0], 'waiting')
  assert.equal(display.stageStates[2], 'locked')
  assert.equal(display.stageStates[3], 'current')
  assert.match(display.source, /revision 6/)
})

test('root recovery state makes the automatic action and user handoff explicit', async () => {
  const snapshot = await view()
  snapshot.run.gates[0].status = 'approved'
  snapshot.run.recovery = {
    incidentId: 'stall-1', status: 'recovering', attempt: 1, turn: 8,
    stage: 'requirements', noProgressMs: 180_000, journalRevision: 6,
    reason: '根协调响应无进展', preserved: ['已确认合同', 'Journal revision 6'],
    resumeFrom: '需求确认后的唯一下一步',
  }
  let display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.equal(display.badge, '自动恢复中')
  assert.equal(display.needsUser, false)
  assert.match(display.now, /自动恢复第 1 次/)
  assert.match(display.summary, /已确认合同/)
  assert.match(display.next, /需求确认后的唯一下一步/)

  snapshot.run.recovery = { ...snapshot.run.recovery, status: 'needs-attention', attempt: 2 }
  display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.equal(display.badge, '需要处理')
  assert.equal(display.needsUser, true)
  assert.match(display.attentionTitle, /需要你决定/)
  assert.match(display.live, /不会继续循环/)
})

test('a replaced stale historical gate does not mask a new current confirmation', async () => {
  const snapshot = await view()
  const old = snapshot.run.gates[0]
  old.status = 'cancelled'
  old.stale = true
  snapshot.run.gates.push({ ...old, gateId: 'new-current', stale: false, status: 'approved' })
  const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.notEqual(display.tone, 'return')
  assert.doesNotMatch(display.attentionTitle, /原授权/)
})

async function settledAgentView(outcome = 'PASS') {
  const snapshot = await view()
  const task = snapshot.run.tasks[0]
  task.status = 'completed'
  snapshot.run.outcome = outcome
  snapshot.run.agents = [{ assignmentId: 'assignment-normalize', agentSessionId: 'child-normalize',
    taskId: task.taskId, taskVersion: task.version, taskTitle: task.title, role: task.role,
    status: 'idle', lastSummary: '角色报告已保存，原生 Agent 本轮正常结束' }]
  return snapshot
}

test('completed PASS displays a settled role as completed rather than awaiting resume', async () => {
  const snapshot = await settledAgentView()
  const before = structuredClone(snapshot)
  const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.equal(display.agents[0].status, '已完成')
  assert.equal(display.agents[0].tone, 'done')
  assert.deepEqual(snapshot, before, 'display must not rewrite journal state or lifecycle')
})

test('terminal failure, qualification and cancellation never invite automatic continuation', async () => {
  for (const outcome of ['QUALIFIED', 'FAIL', 'CANCELLED']) {
    const snapshot = await settledAgentView(outcome)
    const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
    assert.equal(display.agents[0].status, '本轮已结束')
    assert.equal(display.agents[0].tone, 'waiting')
  }
})

test('a finished role before workflow delivery is not the same as workflow acceptance', async () => {
  const snapshot = await settledAgentView(null)
  const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.equal(display.agents[0].status, '本轮已完成')
  assert.notEqual(display.badge, '通过')
})

test('idle agents with stale or superseded task versions are not shown as completed', async () => {
  for (const change of [task => { task.stale = true }, task => { task.version += 1 }]) {
    const snapshot = await settledAgentView()
    change(snapshot.run.tasks[0])
    const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
    assert.equal(display.agents[0].status, '本轮已结束')
    assert.equal(display.agents[0].tone, 'waiting')
  }
})

test('even a terminal result does not turn a recorded running Agent into a stopped process', async () => {
  const snapshot = await settledAgentView()
  snapshot.run.agents[0].status = 'running'
  const display = displayWorkflowState({ status: 'ready', snapshot }, [], stages)
  assert.equal(display.agents[0].status, '运行记录')
  assert.equal(display.agents[0].tone, 'active')
  assert.match(display.live, /尚未接入进程存活核对/)
})
