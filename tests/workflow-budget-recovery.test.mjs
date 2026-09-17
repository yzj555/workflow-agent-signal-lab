import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { WorkflowTextController, CONFIRM_LABEL, BUDGET_TOPUP_LABEL, BUDGET_END_LABEL } from '../lib/workflow-control.js'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { displayWorkflowState } from '../lib/workflow-display.js'

const accept = (_agent, question) => ({ answers: [{ id: question.id, selected: [question.intent?.approve ?? CONFIRM_LABEL] }] })
const input = (h, action = 'topup', add = { modelRequests: 2, commands: 1 }) => ({
  expectedRevision: h.snapshot().revision, action, reason: '隔离测试：核对剩余工作后申请', ...(action === 'topup' ? { add } : {}),
})
async function exhausted(t, options = {}) {
  const h = await controllerFixture(t, { ask: accept, ...options, runBudgetConfig: { runModelRequests: 1, runCommands: 1, ...options.runBudgetConfig } })
  await h.setup()
  await h.controller.admitModelRequest(h.root)
  await assert.rejects(h.controller.admitModelRequest(h.root), /预算/)
  return h
}
function turn(h, kind = 'user') {
  h.controller.observeBudgetTurn(h.root, { type: 'turn/end' })
  h.controller.observeBudgetTurn(h.root, { type: 'turn/start', data: { turn: 10 } })
  h.controller.observeBudgetTurn(h.root, { type: 'user/message', data: { source: { kind } } })
}
const account = h => h.snapshot().run.budget
const request = h => account(h).recovery.requests.at(-1)

test('native topup freezes exact additions, keeps use and gates, and waits for a NEW user-origin turn', async t => {
  const h = await exhausted(t), before = h.snapshot()
  const result = await h.controller.budgetRecovery(h.root, input(h), signal)
  assert.equal(result.applied, true)
  assert.deepEqual(account(h).limits, { modelRequests: 3, commands: 2 })
  assert.deepEqual(account(h).used, before.run.budget.used)
  assert.deepEqual(h.snapshot().run.gates, before.run.gates)
  assert.equal(h.snapshot().revision, before.revision)
  assert.equal(account(h).blocked, null)
  assert.equal(account(h).recovery.awaitingResume, true)
  assert.equal(request(h).decisionAudit.operator, 'unverified')
  assert.equal(request(h).decisionAudit.requestId, request(h).id)
  assert.equal(h.questions.at(-1).intent.approve, BUDGET_TOPUP_LABEL)
  assert.match(h.questions.at(-1).detail, /累计上限变为 3/)
  await assert.rejects(h.controller.admitModelRequest(h.root), /等待用户/)
  await assert.rejects(h.advance(), /预算/)
  turn(h, 'plugin')
  await assert.rejects(h.controller.admitModelRequest(h.root), /等待用户/)
  turn(h)
  await h.controller.admitModelRequest(h.root)
  assert.equal(account(h).recovery.awaitingResume, false)
  assert.equal(account(h).recovery.resumes, 1)
  assert.equal(account(h).used.rootModel, 2)
  assert.equal(h.calls.filter(item => item.operation === 'start').length, 0)
})

test('recovery lane rejects an old turn, fake Agent and plugin messages; only 3 admissions per fresh user turn', async t => {
  const h = await exhausted(t)
  await assert.rejects(h.controller.admitModelRequest({ id: h.root.id }), /Agent/)
  await assert.rejects(h.controller.admitModelRequest(h.root), /原生输入框/)
  turn(h, 'plugin')
  await assert.rejects(h.controller.admitModelRequest(h.root), /原生输入框/)
  turn(h)
  const results = await Promise.allSettled(Array.from({ length: 7 }, () => h.controller.admitModelRequest(h.root)))
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 3)
  assert.equal(account(h).recovery.controlUsed, 3)
  assert.equal(account(h).used.rootModel, 1)
  for (const name of ['workflow_confirm', 'workflow_advance', 'workflow_return', 'workflow_stop', 'write', 'pwsh', 'ask_user_question']) {
    assert.match(h.controller.guard(h.root, name), /预算/)
  }
})

test('control accounting does not stale a pending native gate; concurrent gates cannot replace it', async t => {
  const answer = Promise.withResolvers(), entered = Promise.withResolvers()
  const h = await exhausted(t, { ask: (agent, question) => {
    if (question.header !== '本轮预算') return accept(agent, question)
    entered.resolve(question); return answer.promise
  } })
  const work = h.controller.budgetRecovery(h.root, input(h), signal)
  const question = await entered.promise
  assert.equal(request(h).status, 'pending')
  turn(h); await h.controller.admitModelRequest(h.root)
  await assert.rejects(h.controller.budgetRecovery(h.root, input(h), signal), /已有原生问题/)
  answer.resolve({ answers: [{ id: question.id, selected: [BUDGET_TOPUP_LABEL] }] })
  assert.equal((await work).applied, true)
  assert.equal(account(h).recovery.controlUsed, 1)
  assert.equal(account(h).recovery.requests.length, 1)
})

test('ambiguous or rejected answer cannot refill; a foreign answer is cancelled, never approval', async t => {
  let choice = 'ambiguous'
  const h = await exhausted(t, { ask: (agent, question) => question.header !== '本轮预算' ? accept(agent, question) : {
    answers: [{ id: choice === 'foreign' ? 'old-question' : question.id,
      selected: choice === 'ambiguous' ? [BUDGET_TOPUP_LABEL, '保持暂停'] : [BUDGET_TOPUP_LABEL] }],
  } })
  assert.equal((await h.controller.budgetRecovery(h.root, input(h), signal)).applied, false)
  assert.equal(request(h).status, 'rejected')
  choice = 'foreign'
  await assert.rejects(h.controller.budgetRecovery(h.root, input(h), signal), /未匹配/)
  assert.equal(request(h).status, 'cancelled')
  assert.equal(request(h).decisionAudit, undefined)
  assert.equal(account(h).limits.modelRequests, 1)
  assert.equal(h.snapshot().run.outcome, null)
})

test('aborted gate ignores a late native approval and preserves the paused run', async t => {
  const answer = Promise.withResolvers(), entered = Promise.withResolvers()
  const h = await exhausted(t, { ask: (agent, question) => {
    if (question.header !== '本轮预算') return accept(agent, question)
    entered.resolve(question); return answer.promise
  } })
  const abort = new AbortController()
  const work = h.controller.budgetRecovery(h.root, input(h), abort.signal)
  const question = await entered.promise
  abort.abort(new Error('test user cancellation'))
  answer.resolve({ answers: [{ id: question.id, selected: [BUDGET_TOPUP_LABEL] }] })
  await assert.rejects(work, /cancellation/)
  assert.equal(request(h).status, 'cancelled')
  assert.equal(account(h).blocked.resource, 'root-model')
})

test('durable native request becomes cancelled on cold controller startup, never approved from history', async t => {
  const h = await exhausted(t)
  await h.journal.requestBudgetRecovery(h.root.id, h.snapshot().run.runId, 'pending-before-restart', input(h))
  const cold = new WorkflowJournal(h.table)
  const controller = new WorkflowTextController(cold, h.artifacts, h.driver)
  try {
    controller.bindRoot(h.root)
    await controller.recoverOrphanedLeases()
    assert.equal(cold.readSnapshot(h.root.id).run.budget.recovery.requests.at(-1).status, 'cancelled')
    assert.equal(cold.readSnapshot(h.root.id).run.budget.limits.modelRequests, 1)
    await assert.rejects(controller.admitModelRequest(h.root), /原生输入框/)
  } finally { await controller.close(); await cold.close() }
})

test('workflow revision change invalidates a budget answer, including a late duplicated approval', async t => {
  const h = await exhausted(t), runId = h.snapshot().run.runId
  await h.journal.requestBudgetRecovery(h.root.id, runId, 'stale-gate', input(h))
  await h.controller.stop(h.root)
  await assert.rejects(h.journal.settleBudgetRecovery(h.root.id, runId, 'stale-gate', 'approved'), /stale/)
  await h.journal.settleBudgetRecovery(h.root.id, runId, 'stale-gate', 'cancelled')
  await assert.rejects(h.journal.settleBudgetRecovery(h.root.id, runId, 'stale-gate', 'approved'), /matching pending/)
  assert.equal(account(h).limits.modelRequests, 1)
})

test('control pool exhaustion still permits a model-free native command and explicit topup', async t => {
  const h = await exhausted(t)
  for (let i = 0; i < 4; i++) {
    turn(h)
    for (let j = 0; j < 3; j++) await h.controller.admitModelRequest(h.root)
  }
  turn(h)
  await assert.rejects(h.controller.admitModelRequest(h.root), /核对对话额度已用尽/)
  assert.match(await h.controller.budgetCommand(h.root, '', signal), /模型 1\/1/)
  await assert.rejects(h.controller.budgetCommand(h.root, 'topup 1000', signal), /用法/)
  assert.match(await h.controller.budgetCommand(h.root, 'topup', signal), /补额已保存/)
  assert.equal(account(h).limits.modelRequests, 61)
  assert.equal(account(h).recovery.controlUsed, 12)
  assert.equal(h.calls.filter(item => item.operation === 'start').length, 0)
})

test('topup rejects invalid or non-exhausted resource additions and caps approvals at three', async t => {
  const h = await exhausted(t)
  for (const add of [{ modelRequests: 0, commands: 1 }, { modelRequests: 121, commands: 1 }, { modelRequests: -1, commands: 1 }]) {
    await assert.rejects(h.controller.budgetRecovery(h.root, input(h, 'topup', add), signal))
  }
  assert.equal(account(h).recovery.requests.length, 0)
  for (let i = 0; i < 3; i++) {
    await h.controller.budgetRecovery(h.root, input(h, 'topup', { modelRequests: 1, commands: 0 }), signal)
    turn(h); await h.controller.admitModelRequest(h.root)
    await assert.rejects(h.controller.admitModelRequest(h.root), /预算/)
  }
  await assert.rejects(h.controller.budgetRecovery(h.root, input(h), signal), /三次补额上限/)
  assert.equal(account(h).limits.modelRequests, 4)
  assert.equal(account(h).used.rootModel, 4)
  assert.equal(account(h).recovery.blocks, 4)
})

test('confirmed budget end settles the workflow atomically, never as PASS, and only a fresh user can propose again', async t => {
  const h = await exhausted(t), runId = h.snapshot().run.runId
  const result = await h.controller.budgetRecovery(h.root, input(h, 'end'), signal)
  assert.equal(result.applied, true)
  assert.equal(h.snapshot().run.outcome, 'CANCELLED')
  assert.equal(account(h).recovery.closed, true)
  assert.equal(request(h).decisionAudit.requestId, request(h).id)
  assert.equal(h.questions.at(-1).intent.approve, BUDGET_END_LABEL)
  assert.equal(h.snapshot().run.ledger.pass, 0)
  assert.equal(h.snapshot().run.agents.length, 0)
  await assert.rejects(h.controller.propose(h.root, proposal(h.snapshot().revision), signal), /预算/)
  turn(h, 'plugin')
  await assert.rejects(h.controller.propose(h.root, proposal(h.snapshot().revision), signal), /预算/)
  turn(h); await h.controller.admitModelRequest(h.root)
  await h.controller.propose(h.root, proposal(h.snapshot().revision), signal)
  assert.notEqual(h.snapshot().run.runId, runId)
  assert.ok(h.snapshot().run.gates.every(gate => gate.status !== 'approved'))
  assert.equal(h.snapshot().run.agents.length, 0)
  assert.equal(h.snapshot().history.length, 2)
  assert.equal(h.journal.readRunBudget(h.root.id, runId).recovery.closed, true)
})

test('interrupted child cannot be revived by topup even after confirmed drain; explicit end keeps interruption evidence', async t => {
  const h = await controllerFixture(t, { ask: accept, runBudgetConfig: { runModelRequests: 1 } })
  await h.setup(); await h.advance()
  await h.controller.admitModelRequest(h.child('author'))
  await assert.rejects(h.controller.admitModelRequest(h.child('author')), /预算/)
  for (let i = 0; i < 100 && h.snapshot().run.agents[0].runtimeIssue?.status !== 'stopped'; i++) await new Promise(r => setTimeout(r, 5))
  const before = structuredClone(h.snapshot().run.agents[0].runtimeIssue)
  await assert.rejects(h.controller.budgetRecovery(h.root, input(h), signal), /中断/)
  await h.controller.budgetRecovery(h.root, input(h, 'end'), signal)
  assert.deepEqual(h.snapshot().run.agents[0].runtimeIssue, before)
  assert.equal(h.snapshot().run.outcome, 'CANCELLED')
  assert.equal(h.calls.filter(item => item.operation === 'start').length, 1)
})

test('unknown exit blocks both topup and end and is not overwritten by an empty drain', async t => {
  let drain = false
  const h = await controllerFixture(t, { ask: accept, runBudgetConfig: { runModelRequests: 1 },
    drain: async () => { if (!drain) throw new Error('unknown exit fixture') } })
  await h.setup(); await h.advance(); await h.controller.admitModelRequest(h.root)
  await assert.rejects(h.controller.admitModelRequest(h.root), /预算/)
  for (let i = 0; i < 100 && h.snapshot().run.agents[0].runtimeIssue?.status !== 'unknown'; i++) await new Promise(r => setTimeout(r, 5))
  for (const action of ['topup', 'end']) await assert.rejects(h.controller.budgetRecovery(h.root, input(h, action), signal), /回收|未确认/)
  assert.equal(account(h).recovery.requests.length, 0)
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  drain = true; await h.controller.stop(h.root)
})

test('storage failure while recording approval cannot unblock or publish a partial outcome', async t => {
  const h = await exhausted(t)
  const original = h.table.put, saved = []
  h.table.put = async (key, value) => {
    if (value.budgets.accounts[0].recovery.requests.some(item => item.status === 'approved')) throw new Error('fixture disk full')
    saved.push(value); return original(key, value)
  }
  await assert.rejects(h.controller.budgetRecovery(h.root, input(h, 'end'), signal), /storage failed|reopen storage/)
  const row = h.table.get(h.root.id)
  assert.equal(row.budgets.accounts[0].recovery.requests.at(-1).status, 'pending')
  assert.equal(row.events.some(event => event.data.name === 'outcome/declared'), false)
  assert.equal(row.budgets.accounts[0].recovery.closed, false)
  assert.equal(saved.length, 1)
})

test('strict replay rejects reset counters, forged revisions, missing audit and phantom closure', async t => {
  const h = await exhausted(t)
  await h.controller.budgetRecovery(h.root, input(h), signal)
  for (const mutate of [
    a => { a.used.rootModel = 0 },
    a => { a.recovery.controlUsed = 999 },
    a => { a.limits.modelRequests++ },
    a => { a.recovery.requests[0].decisionAudit = undefined; delete a.recovery.requests[0].decisionAudit },
    a => { a.recovery.requests[0].workflowRevision = 99999 },
    a => { a.recovery.requests[0].block = 2 },
    a => { a.recovery.closed = true },
    a => { a.recovery.awaitingResume = false },
  ]) {
    const row = structuredClone(h.table.get(h.root.id)); mutate(row.budgets.accounts[0])
    assert.throws(() => parseWorkflowJournalRecord(row))
  }
})

test('budget projection distinguishes exhausted, waiting approval, approved-but-paused and explicitly ended', async t => {
  const h = await exhausted(t)
  const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
  const display = () => displayWorkflowState({ status: 'ready', snapshot: h.snapshot() }, [], stages)
  assert.equal(display().badge, '预算耗尽')
  assert.match(display().next, /workflow-budget/)
  await h.journal.requestBudgetRecovery(h.root.id, h.snapshot().run.runId, 'projection-pending', input(h))
  assert.equal(display().attentionTitle, '等待预算决定')
  await h.journal.settleBudgetRecovery(h.root.id, h.snapshot().run.runId, 'projection-pending', 'cancelled')
  await h.controller.budgetRecovery(h.root, input(h, 'topup', { modelRequests: 1, commands: 0 }), signal)
  assert.equal(display().badge, '等待继续')
  assert.equal(display().needsUser, true)
  turn(h); await h.controller.admitModelRequest(h.root)
  await assert.rejects(h.controller.admitModelRequest(h.root), /预算/)
  await h.controller.budgetRecovery(h.root, input(h, 'end'), signal)
  assert.notEqual(display().badge, '预算耗尽')
  assert.doesNotMatch(display().now, /仍在执行|PASS/)
})

test('approved topup survives a cold reopen without releasing the new-user requirement or resetting counters', async t => {
  const h = await exhausted(t)
  await h.controller.budgetRecovery(h.root, input(h), signal)
  const before = h.snapshot(), cold = new WorkflowJournal(h.table)
  const controller = new WorkflowTextController(cold, h.artifacts, h.driver)
  try {
    controller.bindRoot(h.root); await controller.recoverOrphanedLeases()
    assert.deepEqual(cold.readSnapshot(h.root.id), before)
    await assert.rejects(controller.admitModelRequest(h.root), /等待用户/)
    assert.equal(cold.readSnapshot(h.root.id).run.budget.used.rootModel, 1)
    assert.equal(cold.readSnapshot(h.root.id).run.budget.recovery.awaitingResume, true)
  } finally { await controller.close(); await cold.close() }
})

test('first-slice persisted budget without recovery fields is upgraded on write, never on read', async t => {
  const h = await exhausted(t)
  const row = structuredClone(h.table.get(h.root.id))
  delete row.budgets.accounts[0].recovery
  h.table.put(h.root.id, parseWorkflowJournalRecord(row))
  const serialized = JSON.stringify(h.table.get(h.root.id))
  const cold = new WorkflowJournal(h.table)
  try {
    assert.equal(cold.readSnapshot(h.root.id).run.budget.recovery, undefined)
    assert.equal(JSON.stringify(h.table.get(h.root.id)), serialized)
    await cold.requestBudgetRecovery(h.root.id, h.snapshot().run.runId, 'legacy-request', input(h))
    assert.equal(cold.readSnapshot(h.root.id).run.budget.recovery.blocks, 1)
    assert.equal(cold.readSnapshot(h.root.id).run.budget.used.rootModel, 1)
  } finally { await cold.close() }
})
