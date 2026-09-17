import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { WorkflowTextController, MANUAL_CLOSE_LABEL, KEEP_UNKNOWN_LABEL, reconciliationSchema,
  unknownRuntimeScope, assertManualCloseScope, manualCloseQuestion } from '../lib/workflow-control.js'
import { WorkflowJournal, workflowSnapshotSchema } from '../lib/workflow-journal.js'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { flushChild } from './helpers/workflow-child-clock.mjs'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const display = snapshot => displayWorkflowState({ status: 'ready', snapshot }, [], stages)
const evidence = [{ source: '测试夹具核实记录；不是真实生产证据', observation: '受控 fixture 中核对旧执行范围及外部影响，仅用于测试原生裁决机制' }]
const stateOf = f => f.journal.readRunState(f.root.id, f.snapshot().run.runId)
const event = (f, name, payload, actor = { kind: 'system', id: 'fixture-host' }) => ({
  version: 1, runId: f.snapshot().run.runId, eventId: randomUUID(), name, actor, payload,
})
const commit = (f, events) => f.journal.commit({ rootSessionId: f.root.id, expectedRevision: f.snapshot().revision, events })

async function coldFixture(t, { command = false, ask } = {}) {
  const f = await controllerFixture(t)
  await f.setup()
  if (command) {
    await f.author('测试公告')
    await f.advance()
    const agent = f.snapshot().run.agents.find(agent => agent.role === 'acceptance_qa')
    await commit(f, [event(f, 'command/started', { commandId: 'fixture-command', assignmentId: agent.assignmentId,
      taskVersion: agent.taskVersion, checkId: 'ACC-1', timeoutMs: 1000 })])
  } else await f.advance()
  await f.controller.close()
  const coldQuestions = []
  const cold = new WorkflowTextController(f.journal, f.artifacts, { ...f.driver,
    async ask(agent, questions, signal) {
      coldQuestions.push(...questions)
      if (ask) return ask(questions[0], signal)
      return { answers: [{ id: questions[0].id, selected: [MANUAL_CLOSE_LABEL] }] }
    },
  })
  cold.bindRoot(f.root)
  await cold.recoverOrphanedLeases()
  t.after(() => cold.close())
  const input = () => ({ ...f.revision(), reason: '核实后人工结束旧运行，保留原始证据',
    checks: unknownRuntimeScope(stateOf(f)).map(({ assignmentId, incidentId }) => ({ assignmentId, incidentId, evidence })) })
  return { ...f, cold, coldQuestions, input }
}

test('manual closure is atomic, audited, preserves unknown command evidence and cannot resume the old run', async t => {
  const f = await coldFixture(t, { command: true })
  const before = stateOf(f), row = structuredClone(f.table.get(f.root.id))
  const calls = f.calls.length
  const originalInput = f.input(), put = f.table.put, writes = []
  f.table.put = async (key, value) => { writes.push(structuredClone(value)); await put(key, value) }
  const result = await f.cold.reconcile(f.root, originalInput, signal)
  assert.equal(result.applied, true)
  assert.equal(result.hostExitVerified, false)
  assert.equal(f.snapshot().run.outcome, 'ABANDONED')
  assert.equal(f.snapshot().revision, row.revision + 5, 'revision counts events')
  assert.equal(writes.length, 2, 'one prepare transaction and one approval+closure+outcome transaction')
  assert.deepEqual(writes[1].events.slice(-3).map(item => item.data.name), ['gate/decided', 'runtime/manual-close-recorded', 'outcome/declared'])
  assert.deepEqual(f.table.get(f.root.id).events.slice(0, row.events.length), row.events)
  const after = stateOf(f)
  for (const key of ['commands', 'assignments', 'tasks', 'acceptance', 'records', 'returns']) assert.deepEqual(after[key], before[key], key)
  assert.equal(after.commands['fixture-command'].observation.exitConfirmed, false)
  assert.equal(after.commands['fixture-command'].status, 'unknown')
  assert.deepEqual(after.manualClose.decisionAudit, { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: after.manualClose.gateId })
  assert.equal(f.calls.length, calls, 'no drain, spawn, resume or filesystem operation')
  assert.equal((await f.cold.status(f.root)).reconciliation.status, 'manually-closed')
  assert.deepEqual((await f.cold.status(f.root)).recoveryRequired, [])
  const ui = display(f.snapshot())
  assert.equal(ui.badge, '人工结束')
  assert.deepEqual(ui.manualClose, f.snapshot().run.manualClose, 'full reason and audit remain available')
  const checkedAgent = ui.agents.find(agent => /独立验收/.test(agent.label))
  assert.deepEqual(checkedAgent.verification.evidence, evidence)
  assert.equal(checkedAgent.detail.includes(evidence[0].observation), false, 'evidence is not pasted into the Agent summary')
  assert.equal(ui.nowDetail.includes(originalInput.reason), false, 'long disposition reason is available in the audit disclosure')
  assert.equal(ui.needsUser, false)
  assert.match(ui.now, /退出证据仍未知/)
  assert.match(ui.agents.find(agent => /独立验收/.test(agent.label)).status, /未确认停止/)
  assert.equal(ui.stageDetails[5].label, '人工结束')
  assert.equal(ui.stageDetails[6].label, '未整理')
  assert.equal(workflowSnapshotSchema.safeParse(f.snapshot()).success, true)
  for (const outcome of ['PASS', 'CANCELLED', null]) assert.equal(workflowSnapshotSchema.safeParse({ ...f.snapshot(),
    run: { ...f.snapshot().run, outcome } }).success, false)
  await assert.rejects(f.cold.advance(f.root, f.revision(), signal), /停止或结束/)
  await assert.rejects(f.cold.reconcile(f.root, { ...originalInput, ...f.revision() }, signal), /已结束/)
  assert.equal((await f.cold.stop(f.root)).stopped, false)
  assert.equal((await f.cold.recordRootStall(f.root, { turn: 1, noProgressMs: 2000 })).kind, 'needs-attention')
  const latest = f.snapshot()
  await f.cold.recoverOrphanedLeases()
  assert.deepEqual(f.snapshot(), latest)
  const reread = new WorkflowJournal(f.table)
  assert.deepEqual(reread.readSnapshot(f.root.id), latest, 'cold Journal replay preserves the complete audit and disposition')
  await reread.close()
  await f.cold.propose(f.root, proposal(f.snapshot().revision), signal)
  assert.notEqual(f.snapshot().run.runId, before.runId)
  assert.equal(f.snapshot().history.find(run => run.runId === before.runId).outcome, 'ABANDONED')
  assert.equal(f.snapshot().run.gates.some(gate => gate.status === 'approved'), false)
  assert.equal(f.snapshot().run.agents.length, 0)
  await assert.rejects(f.cold.advance(f.root, f.revision(), signal), /门禁|Signal/)
})

test('decline leaves the same unknown run blocked and a second request needs a fresh exact answer', async t => {
  let oldId, count = 0
  const f = await coldFixture(t, { ask: q => {
    count++
    if (count === 1) { oldId = q.id; return { answers: [{ id: q.id, selected: [KEEP_UNKNOWN_LABEL] }] } }
    return { answers: [{ id: oldId, selected: [MANUAL_CLOSE_LABEL] }] }
  } })
  const before = stateOf(f)
  assert.equal((await f.cold.reconcile(f.root, f.input(), signal)).applied, false)
  assert.equal(f.snapshot().run.outcome, null)
  assert.deepEqual(stateOf(f).assignments, before.assignments)
  await assert.rejects(f.cold.reconcile(f.root, f.input(), signal), /未匹配/)
  assert.equal(f.snapshot().run.outcome, null)
  assert.deepEqual(Object.values(stateOf(f).gates).filter(g => g.kind === 'runtime-recovery').map(g => g.status), ['rejected', 'cancelled'])
})

test('abort and controller disposal cancel the pending gate without administrative closure', async t => {
  for (const mode of ['abort', 'dispose']) {
    const entered = Promise.withResolvers()
    const f = await coldFixture(t, { ask: (q, sig) => new Promise((resolve, reject) => {
      entered.resolve(q)
      sig.addEventListener('abort', () => reject(sig.reason), { once: true })
    }) })
    const abort = new AbortController()
    const work = f.cold.reconcile(f.root, f.input(), abort.signal)
    const rejected = assert.rejects(work, /取消|卸载/)
    await entered.promise
    assert.equal(display(f.snapshot()).badge, '待人工处置')
    if (mode === 'abort') abort.abort(new Error('测试取消'))
    else await f.cold.close()
    await rejected
    assert.equal(f.snapshot().run.outcome, null)
    assert.equal(stateOf(f).manualClose, undefined)
    assert.equal(Object.values(stateOf(f).gates).at(-1).status, 'cancelled')
  }
})

test('concurrent evidence or an incident change invalidates the entire pending approval', async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers()
  const f = await coldFixture(t, { ask: q => { entered.resolve(q); return answer.promise } })
  const work = f.cold.reconcile(f.root, f.input(), signal)
  const rejected = assert.rejects(work, /记录已变化/)
  const q = await entered.promise
  const old = Object.values(stateOf(f).assignments).find(agent => agent.runtimeIssue).runtimeIssue
  await commit(f, [event(f, 'agent/runtime-interrupted', { ...old, status: 'stopped', reason: '仅此 fixture 模拟 Host 后续精确退出证据' })])
  answer.resolve({ answers: [{ id: q.id, selected: [MANUAL_CLOSE_LABEL] }] })
  await rejected
  assert.equal(f.snapshot().run.outcome, null)
  assert.equal(Object.values(stateOf(f).gates).at(-1).status, 'cancelled')
})

test('missing, duplicate, foreign and stale checks are rejected before any native question', async t => {
  const f = await coldFixture(t, { command: true })
  const input = f.input(), before = f.snapshot()
  for (const value of [
    { ...input, checks: [] }, { ...input, checks: [...input.checks, ...input.checks] },
    { ...input, checks: [{ ...input.checks[0], assignmentId: 'foreign' }] },
    { ...input, checks: [{ ...input.checks[0], incidentId: 'old-incident' }] },
    { ...input, expectedRevision: input.expectedRevision - 1 },
    { ...input, checks: [{ ...input.checks[0], evidence: [] }] },
    { ...input, decisionAudit: { authority: 'user' } },
  ]) await assert.rejects(f.cold.reconcile(f.root, value, signal))
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.coldQuestions.length, 0)
  assert.throws(() => reconciliationSchema.parse({ ...input, checks: [{ ...input.checks[0], evidence: [{ source: ' ', observation: ' ' }] }] }))
})

test('active Host ownership and live/stopping siblings cannot be bypassed by manual closure', async t => {
  const f = await controllerFixture(t)
  await f.setup(); await f.advance()
  const agent = f.snapshot().run.agents[0]
  const issue = { incidentId: 'owned-issue', assignmentId: agent.assignmentId, taskVersion: agent.taskVersion,
    cause: 'command-exit-unknown', status: 'unknown', budgetMs: 1000, elapsedMs: 1000, reason: 'fixture ownership guard' }
  await commit(f, [event(f, 'agent/runtime-interrupted', issue)])
  await assert.rejects(f.controller.reconcile(f.root, { ...f.revision(), reason: 'do not bypass cleanup',
    checks: [{ assignmentId: agent.assignmentId, incidentId: issue.incidentId, evidence }] }, signal), /仍持有/)
  const state = stateOf(f)
  for (const status of ['running', 'stopping']) {
    const copy = structuredClone(state)
    copy.assignments.sibling = { ...copy.assignments[agent.assignmentId], assignmentId: 'sibling',
      runtimeIssue: status === 'stopping' ? { ...issue, status } : undefined }
    assert.throws(() => unknownRuntimeScope(copy), /运行或回收/)
  }
})

test('replay requires every unknown command and incident, not a selected subset or duplicated range', async t => {
  const f = await coldFixture(t, { command: true })
  const state = stateOf(f), scope = unknownRuntimeScope(state)
  const request = { gateId: 'fixture-gate', reason: 'test', checks: scope.map(item => ({ ...item, evidence })) }
  assert.doesNotThrow(() => assertManualCloseScope(state, request))
  for (const changed of [[], ['foreign-command'], ['fixture-command', 'fixture-command']]) {
    assert.throws(() => assertManualCloseScope(state, { ...request, checks: [{ ...request.checks[0], commandIds: changed }] }), /范围不匹配/)
  }
  const copy = structuredClone(state), source = Object.values(copy.assignments).find(a => a.runtimeIssue)
  copy.assignments.other = { ...source, assignmentId: 'other', runtimeIssue: { ...source.runtimeIssue, assignmentId: 'other', incidentId: 'other-incident' } }
  assert.throws(() => assertManualCloseScope(copy, request), /范围不匹配/)
})

test('replay rejects forged authority, missing native audit and direct terminal bypass', async t => {
  const f = await coldFixture(t)
  const before = f.snapshot(), state = stateOf(f)
  for (const outcome of ['PASS', 'FAIL', 'CANCELLED']) await assert.rejects(commit(f, [event(f, 'outcome/declared', {
    outcome, reason: 'must not hide unknown', ledger: before.run.ledger,
  })]), /unresolved runtime ranges/)
  for (const actor of [{ kind: 'pm', id: f.root.id }, { kind: 'system', id: 'fixture-host' }, { kind: 'user', id: 'fake' }]) {
    await assert.rejects(commit(f, [event(f, 'runtime/manual-close-recorded', { gateId: 'fake' }, actor)]))
    await assert.rejects(commit(f, [event(f, 'outcome/declared', { outcome: 'ABANDONED', reason: 'bypass', ledger: before.run.ledger }, actor)]), /audited manual closure/)
  }
  const scope = unknownRuntimeScope(state), gateId = 'fake-gate'
  const request = { gateId, reason: 'test', checks: scope.map(item => ({ ...item, evidence })) }
  const taskId = state.assignments[scope[0].assignmentId].taskId
  await commit(f, [event(f, 'gate/requested', { gateId, kind: 'runtime-recovery', stage: state.currentStage,
    summary: 'fixture gate', requiredActor: 'user', scopeTaskIds: [taskId], inputRefs: [{ kind: 'task', recordId: taskId, version: 1 }] }, { kind: 'pm', id: f.root.id }),
  event(f, 'runtime/manual-close-requested', request, { kind: 'pm', id: f.root.id })])
  for (const audit of [undefined, { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: 'wrong-id' }]) {
    await assert.rejects(commit(f, [event(f, 'gate/decided', { gateId, decision: 'approved', reason: 'fake', ...(audit ? { decisionAudit: audit } : {}) },
      { kind: 'user', id: `native-question:${audit?.requestId ?? gateId}` })]), /fresh exact native question audit/)
  }
  assert.equal(f.snapshot().run.outcome, null)
})

test('root identity, unrelated histories and late exit claims remain isolated after closure', async t => {
  const f = await coldFixture(t, { command: true }), input = f.input()
  const other = await controllerFixture(t)
  await other.setup()
  const protectedRow = structuredClone(other.table.get(other.root.id))
  // Same persisted ID is not a live Agent capability; a child object is not a root.
  await assert.rejects(f.cold.reconcile({ id: f.root.id }, input, signal), /根 Agent|绑定/)
  const unknown = f.snapshot().run.agents.find(agent => agent.runtimeIssue)
  await assert.rejects(f.cold.reconcile({ id: unknown.agentSessionId }, input, signal))
  await f.cold.reconcile(f.root, input, signal)
  const closed = f.snapshot()
  await assert.rejects(commit(f, [event(f, 'command/finished', { commandId: 'fixture-command', status: 'completed',
    elapsedMs: 1, processCount: 1, exitConfirmed: true, toolSettled: true, exitCode: 0 })]), /exact running execution/)
  await assert.rejects(commit(f, [event(f, 'agent/runtime-interrupted', { ...unknown.runtimeIssue, status: 'stopped' })]), /unresolved command/)
  assert.deepEqual(f.snapshot(), closed)
  assert.deepEqual(other.table.get(other.root.id), protectedRow)
})

test('pending native gate is exclusive and cannot be replaced by a simultaneous model call', async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers()
  const f = await coldFixture(t, { ask: q => { entered.resolve(q); return answer.promise } })
  const work = f.cold.reconcile(f.root, f.input(), signal)
  const q = await entered.promise
  await assert.rejects(f.cold.reconcile(f.root, f.input(), signal), /已有原生问题/)
  answer.resolve({ answers: [{ id: q.id, selected: [KEEP_UNKNOWN_LABEL] }] })
  await work
  assert.equal(f.coldQuestions.length, 1)
})

test('stale revision, malformed answer and ambiguous approval never close the run', async t => {
  for (const selection of [[MANUAL_CLOSE_LABEL, KEEP_UNKNOWN_LABEL], [], ['我同意']]) {
    const f = await coldFixture(t, { ask: q => ({ answers: [{ id: q.id, selected: selection }] }) })
    assert.equal((await f.cold.reconcile(f.root, f.input(), signal)).applied, false)
    assert.equal(f.snapshot().run.outcome, null)
  }
})

test('failed durable commit cannot publish a successful manual disposition', async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers()
  const f = await coldFixture(t, { ask: q => { entered.resolve(q); return answer.promise } })
  const work = f.cold.reconcile(f.root, f.input(), signal)
  const rejected = assert.rejects(work)
  const q = await entered.promise, before = f.snapshot()
  const put = f.table.put
  f.table.put = async () => { throw new Error('fixture durable write failed') }
  answer.resolve({ answers: [{ id: q.id, selected: [MANUAL_CLOSE_LABEL] }] })
  await rejected
  f.table.put = put
  const reopened = new WorkflowJournal(f.table)
  assert.deepEqual(reopened.readSnapshot(f.root.id), before)
  assert.equal(reopened.readSnapshot(f.root.id).run.outcome, null)
  await reopened.close()
})

test('native recovery question preserves full verification statements as inert text', async t => {
  const f = await coldFixture(t)
  const request = { gateId: 'fixture', reason: 'why', checks: unknownRuntimeScope(stateOf(f)).map(item => ({ ...item,
    evidence: [{ source: '[link](https://invalid.example)', observation: '<script>fake()</script>\n# fake header' }] })) }
  const question = manualCloseQuestion(stateOf(f), request)
  assert.equal(question.options[0].label, KEEP_UNKNOWN_LABEL)
  assert.equal(question.intent.approve, MANUAL_CLOSE_LABEL)
  assert.match(question.detail, /系统未独立验证/)
  assert.doesNotMatch(question.detail, /<script>|\[link\]\(https/)
  assert.match(question.detail, /后台工作和外部影响/)
  assert.match(question.detail, /ABANDONED/)
  await flushChild()
})
