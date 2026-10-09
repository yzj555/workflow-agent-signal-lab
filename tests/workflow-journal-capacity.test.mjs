import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'
import { ingressHistory, padHistory, recoveryPair } from './helpers/workflow-capacity-fixture.mjs'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'
import { WorkflowTextController } from '../lib/workflow-control.js'
import { displayWorkflowState, workflowStatusLabel } from '../lib/workflow-display.js'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const show = snapshot => displayWorkflowState({ status: snapshot.availability === 'absent' ? 'absent' : 'ready', snapshot }, [], stages)
const cross = (journal, rootId) => {
  const snapshot = journal.readSnapshot(rootId)
  return journal.commit({ rootSessionId: rootId, expectedRevision: snapshot.revision, events: recoveryPair(snapshot) })
}
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('capacity cleanup did not converge')
}

test('capacity: a legacy hard-full history remains readable but clearly blocks new work across cold opens', async () => {
  const table = memoryTable(), record = ingressHistory('full-history', 10000)
  table.rows.set(record.rootSessionId, parseWorkflowJournalRecord(record))
  const original = JSON.stringify(table.get(record.rootSessionId))
  for (let index = 0; index < 2; index++) {
    const journal = new WorkflowJournal(table)
    try {
      const snapshot = journal.readSnapshot(record.rootSessionId)
      assert.ok(snapshot.capacity, 'Full Journal must not look like an ordinary usable empty session')
      assert.equal(snapshot.capacity.reason, 'events')
      assert.equal(snapshot.capacity.events, 10000)
      assert.equal(snapshot.run, null)
      assert.equal(JSON.stringify(table.get(record.rootSessionId)), original)
    } finally { await journal.close() }
  }
})

test('capacity: the last ordinary commit is durable; reserve permits cancellation, not a fresh approval or model request', async () => {
  const table = memoryTable(), f = fixture('threshold-run'), journal = new WorkflowJournal(table)
  try {
    await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
    padHistory(table, f.rootSessionId, 8998)
    assert.equal(journal.readSnapshot(f.rootSessionId).capacity, undefined)
    const observed = []
    const unsubscribe = journal.subscribe(snapshot => observed.push(snapshot))
    const result = await cross(journal, f.rootSessionId)
    assert.equal(result.revision, 9000)
    assert.equal(observed.at(-1).capacity.events, 9000)
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 9000, events: [f.approve()] }), /容量/)
    assert.equal(journal.readSnapshot(f.rootSessionId).run.gates[0].status, 'waiting')
    const cancelled = await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 9000,
      events: [f.event('gate/decided', { gateId: 'signal', decision: 'cancelled', reason: 'Host capacity stop' }, { kind: 'system', id: 'host' })] })
    assert.equal(cancelled.run.gates[0].status, 'cancelled')
    assert.equal(cancelled.run.outcome, null)
    assert.equal(cancelled.run.ledger.fail, 0)
    unsubscribe()
  } finally { await journal.close() }
})

test('capacity: byte high-water is independently derived from canonical UTF-8 bytes and shown before any run', async () => {
  const table = memoryTable(), record = ingressHistory('byte-full', 2)
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
  record.events[0].data.payload.reason += 'x'.repeat(14 * 1024 * 1024 - bytes)
  table.rows.set(record.rootSessionId, parseWorkflowJournalRecord(record))
  const before = JSON.stringify(table.get(record.rootSessionId)), journal = new WorkflowJournal(table)
  try {
    const snapshot = journal.readSnapshot(record.rootSessionId)
    assert.equal(snapshot.capacity.reason, 'bytes')
    assert.equal(snapshot.capacity.bytes, Buffer.byteLength(before, 'utf8'))
    const view = show(snapshot)
    assert.equal(workflowStatusLabel(view), '容量暂停')
    assert.equal(view.needsUser, true)
    assert.match(view.next, /workflow-capacity/)
    assert.doesNotMatch(view.now, /完成|已停止|失败/)
    assert.throws(() => journal.assertExecutionCapacity(record.rootSessionId), /容量/)
    await assert.rejects(cross(journal, record.rootSessionId), /容量/)
    assert.equal(JSON.stringify(table.get(record.rootSessionId)), before)
  } finally { await journal.close() }
})

test('capacity: bounded batches cannot jump over the shutdown reserve or modify history on rejection', async () => {
  const table = memoryTable(), f = fixture('batch-limit'), journal = new WorkflowJournal(table)
  try {
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0,
      events: Array.from({ length: 129 }, () => f.created()) }), /单次日志提交过大/)
    const events = f.initial()
    events[0].payload.title = '中'.repeat(180000)
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events }), /单次日志提交过大/)
    assert.equal(table.rows.size, 0)
    await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
    assert.equal(journal.readSnapshot(f.rootSessionId).capacity, undefined)
  } finally { await journal.close() }
})

test('capacity: active child is revoked at the durable threshold; exit facts do not fabricate a business result', async t => {
  const h = await controllerFixture(t, { runBudgetConfig: { runBudgetEnabled: false } })
  await h.setup(); await h.advance()
  const child = h.child('author'), calls = h.calls.filter(item => item.operation === 'start').length
  padHistory(h.table, h.root.id, 8998)
  await cross(h.journal, h.root.id)
  await assert.rejects(h.controller.admitModelRequest(child), /容量/)
  assert.match(h.controller.guard(child, 'workflow_report'), /容量/)
  for (const tool of ['workflow_propose', 'workflow_confirm', 'workflow_advance', 'workflow_budget', 'workflow_return']) {
    assert.match(h.controller.guard(h.root, tool), /容量/)
  }
  await until(() => h.snapshot().run.agents[0].runtimeIssue?.status === 'stopped')
  assert.equal(h.live.has(child.id), false)
  assert.equal(h.snapshot().run.outcome, null)
  assert.equal(h.snapshot().run.ledger.fail, 0)
  assert.equal(h.calls.filter(item => item.operation === 'start').length, calls)
  assert.equal(workflowStatusLabel(show(h.snapshot())), '容量暂停')
  assert.match(await h.controller.capacityCommand(h.root, '', signal), /9000/)
  assert.match(await h.controller.capacityCommand(h.root, 'stop', signal), /已停止/)
  assert.equal(h.snapshot().run.outcome, 'CANCELLED')
  await assert.rejects(h.controller.capacityCommand(h.root, 'topup', signal), /不支持扩容/)
})

test('capacity: ingress is blocked without a run, while another root can still commit and admit work', async t => {
  const h = await controllerFixture(t)
  h.table.rows.set(h.root.id, parseWorkflowJournalRecord(ingressHistory(h.root.id, 9000)))
  await assert.rejects(h.controller.admitModelRequest(h.root), /容量/)
  assert.equal(h.snapshot().run, null)
  assert.match(await h.controller.capacityCommand(h.root, 'stop', signal), /尚无受控运行/)
  const f = fixture('healthy-root')
  await h.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  await h.journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model')
  assert.equal(h.journal.readSnapshot(f.rootSessionId).capacity, undefined)
})

test('capacity: late answer to a native confirmation is cancelled, never approved after shutdown', async t => {
  const entered = Promise.withResolvers(), reply = Promise.withResolvers()
  const h = await controllerFixture(t, { ask: (_agent, question) => { entered.resolve(question); return reply.promise } })
  await h.controller.propose(h.root, proposal(0), signal)
  const pending = h.controller.confirm(h.root, h.revision(), signal)
  const question = await entered.promise
  padHistory(h.table, h.root.id, 8998)
  await cross(h.journal, h.root.id)
  reply.resolve({ answers: [{ id: question.id, selected: [question.intent.approve] }] })
  await assert.rejects(pending, /容量|变化|失效/)
  assert.equal(h.snapshot().run.gates.some(gate => gate.status === 'approved'), false)
  assert.equal(h.calls.filter(call => call.operation === 'start').length, 0)
})

test('capacity: an already hard-full legacy row cannot record exit, but does not break healthy Host recovery', async t => {
  const h = await controllerFixture(t), f = fixture('hard-full-active')
  const record = ingressHistory(f.rootSessionId, 9990)
  const events = [...f.initial(), f.approve(), f.readyTask(), f.runTask(), f.assign()]
  record.events.push(...events.map((data, offset) => ({ type: record.events[0].type, time: 1, seq: 9990 + offset, data })))
  record.revision = 10000
  h.table.rows.set(f.rootSessionId, parseWorkflowJournalRecord(record))
  const before = JSON.stringify(h.table.get(f.rootSessionId)), errors = []
  const cold = new WorkflowJournal(h.table), controller = new WorkflowTextController(cold, h.artifacts, h.driver, error => errors.push(error))
  try {
    await controller.recoverOrphanedLeases()
    assert.equal(JSON.stringify(h.table.get(f.rootSessionId)), before)
    assert.equal(cold.readSnapshot(f.rootSessionId).run.agents[0].status, 'running')
    const view = show(cold.readSnapshot(f.rootSessionId))
    assert.equal(view.agents[0].status, '退出待核对')
    assert.equal(view.badge, '容量暂停')
    assert.ok(errors.length > 0)
    const good = fixture('cold-healthy')
    await cold.commit({ rootSessionId: good.rootSessionId, expectedRevision: 0, events: good.initial() })
    assert.equal(cold.readSnapshot(good.rootSessionId).capacity, undefined)
  } finally { await controller.close(); await cold.close() }
})

test('capacity: a gate-request that consumes the last slot never opens a native approval card', async t => {
  const h = await controllerFixture(t)
  await h.controller.propose(h.root, proposal(0), signal)
  const count = padHistory(h.table, h.root.id, 8998)
  assert.ok(count === 8998 || count === 8999)
  if (count === 8998) await h.journal.commit({ rootSessionId: h.root.id, expectedRevision: count, events: [recoveryPair(h.snapshot())[0]] })
  await assert.rejects(h.controller.confirm(h.root, h.revision(), signal), /容量/)
  assert.equal(h.questions.length, 0)
  assert.equal(h.snapshot().run.gates.some(gate => gate.status === 'approved'), false)
})

test('capacity: a stalled root at high-water asks for attention without requesting automatic continuation or rewriting history', async t => {
  const h = await controllerFixture(t)
  h.table.rows.set(h.root.id, parseWorkflowJournalRecord(ingressHistory(h.root.id, 9000)))
  const before = JSON.stringify(h.table.get(h.root.id))
  assert.deepEqual(await h.controller.recordRootStall(h.root, { turn: 1, noProgressMs: 180000 }), { kind: 'needs-attention' })
  assert.equal(JSON.stringify(h.table.get(h.root.id)), before)
})

test('capacity: an unmetered run cannot admit another model request when journal execution space is consumed', async () => {
  const table = memoryTable(), f = fixture('capacity-run')
  const record = ingressHistory(f.rootSessionId, 8994)
  const created = f.initial()
  record.events.push(...created.map((data, offset) => ({ type: record.events[0].type, seq: record.revision + offset, time: 1, data })))
  record.revision = record.events.length
  table.rows.set(record.rootSessionId, parseWorkflowJournalRecord(record))
  const journal = new WorkflowJournal(table)
  try {
    assert.equal(journal.readSnapshot(f.rootSessionId).revision, 9000)
    await assert.rejects(journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model'), /capacity|容量/)
    assert.equal(journal.readSnapshot(f.rootSessionId).run.budget, undefined)
  } finally { await journal.close() }
})
