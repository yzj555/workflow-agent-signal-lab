import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'

async function record() {
  const table = memoryTable(), f = fixture(), journal = new WorkflowJournal(table)
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial(), runBudgetLimits: { modelRequests: 240, commands: 40, activeMs: 1800000 } })
  await journal.close()
  return { table, f, value: table.get(f.rootSessionId) }
}

test('replay proof reuses only its own deeply frozen output, never a mutable caller input', async () => {
  const { value } = await record(), mutable = structuredClone(value), parsed = parseWorkflowJournalRecord(mutable)
  assert.notEqual(parsed, mutable)
  assert.equal(parseWorkflowJournalRecord(parsed), parsed)
  assert.ok(Object.isFrozen(parsed.events[0].data.payload)); assert.ok(Object.isFrozen(parsed.budgets.accounts[0].limits))
  assert.throws(() => { parsed.events[0].data.payload.title = 'forged' }, TypeError)
  mutable.events[0].data.payload.title = 'different source'
  const changed = parseWorkflowJournalRecord(mutable)
  assert.equal(changed.events[0].data.payload.title, 'different source')
  assert.notEqual(changed, parsed)
  assert.notEqual(parsed.events[0].data.payload.title, 'different source')
})

test('same identity fields, caller freezing and copied records cannot borrow a valid replay proof', async () => {
  const { value } = await record()
  const invalid = structuredClone(value)
  invalid.events[1].seq = 42
  Object.freeze(invalid)
  assert.throws(() => parseWorkflowJournalRecord(invalid), /contiguous seq/)
  const budget = structuredClone(value)
  budget.budgets.accounts[0].used.rootModel = 241
  assert.throws(() => parseWorkflowJournalRecord(budget), /budget accounting/)
  const changed = structuredClone(value)
  changed.events[0].data.payload.rootSessionId = 'not-the-row'
  assert.throws(() => parseWorkflowJournalRecord(changed), /another root/)
})

test('multiple readers sharing a validated record cannot mutate each other through snapshots or state copies', async () => {
  const { table, f } = await record(), first = new WorkflowJournal(table), second = new WorkflowJournal(table)
  try {
    const expected = second.readSnapshot(f.rootSessionId)
    const view = first.readSnapshot(f.rootSessionId)
    view.run.title = 'not durable'
    const state = first.readRunState(f.rootSessionId, f.runId)
    state.created.title = 'not durable either'
    const budget = first.readRunBudget(f.rootSessionId, f.runId)
    budget.used.rootModel = 239
    assert.deepEqual(second.readSnapshot(f.rootSessionId), expected)
    assert.deepEqual(first.readSnapshot(f.rootSessionId), expected)
    await first.consumeRunBudget(f.rootSessionId, f.runId, 'root-model')
    assert.equal(second.readRunBudget(f.rootSessionId, f.runId).used.rootModel, 1)
    assert.equal(second.readSnapshot(f.rootSessionId).revision, expected.revision)
  } finally { await first.close(); await second.close() }
})

test('operational budget updates share only frozen history and match an independent full cold replay', async () => {
  const { table, f, value } = await record(), journal = new WorkflowJournal(table)
  try {
    const original = journal.readSnapshot(f.rootSessionId)
    for (let index = 0; index < 12; index++) {
      await journal.consumeRunBudget(f.rootSessionId, f.runId, index % 2 ? 'command' : 'root-model')
      const current = table.get(f.rootSessionId)
      assert.equal(current.events, value.events)
      assert.equal(current.revision, value.revision)
      // A JSON round trip loses the private object proof; the cold parser must
      // independently validate every event, budget and cross-reference again.
      const cold = parseWorkflowJournalRecord(JSON.parse(JSON.stringify(current)))
      const coldReader = new WorkflowJournal({ get: () => cold, entries: function* () { yield [f.rootSessionId, cold] }, put: () => { throw new Error('readonly') } })
      try { assert.deepEqual(journal.readSnapshot(f.rootSessionId), coldReader.readSnapshot(f.rootSessionId)) }
      finally { await coldReader.close() }
    }
    assert.equal(journal.readSnapshot(f.rootSessionId).revision, original.revision)
    const before = table.get(f.rootSessionId)
    await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: before.revision, events: [f.approve()] })
    assert.notEqual(table.get(f.rootSessionId).events, before.events, 'business events cannot reuse the budget-only path')
    assert.equal(journal.readSnapshot(f.rootSessionId).run.gates[0].status, 'approved')
    assert.equal(journal.readRunBudget(f.rootSessionId, f.runId).used.commands, 6)
  } finally { await journal.close() }
})

test('budget-only byte deltas enforce the UTF-8 execution high-water exactly', async () => {
  const { table, f, value } = await record(), raw = structuredClone(value)
  raw.budgets.accounts[0].used.rootModel = 8
  raw.budgets.revision = 9
  raw.events[0].data.payload.title += '中文\\"'
  raw.events[0].data.payload.title += 'x'.repeat(14 * 1024 * 1024 - 1 - Buffer.byteLength(JSON.stringify(raw)))
  table.rows.set(f.rootSessionId, parseWorkflowJournalRecord(raw))
  const journal = new WorkflowJournal(table)
  try {
    assert.equal(journal.readSnapshot(f.rootSessionId).capacity, undefined)
    const before = table.get(f.rootSessionId)
    await journal.consumeRunBudget(f.rootSessionId, f.runId, 'root-model')
    const current = table.get(f.rootSessionId), capacity = journal.readSnapshot(f.rootSessionId).capacity
    assert.equal(current.events, before.events)
    assert.equal(capacity.reason, 'bytes')
    assert.equal(capacity.bytes, Buffer.byteLength(JSON.stringify(current)))
    assert.equal(capacity.bytes, 14 * 1024 * 1024)
    await assert.rejects(journal.consumeRunBudget(f.rootSessionId, f.runId, 'command'), /容量/)
    assert.equal(table.get(f.rootSessionId), current)
  } finally { await journal.close() }
})

test('budget settlement beyond the hard byte limit rejects before persistence without changing the row', async () => {
  const { table, f, value } = await record(), raw = structuredClone(value)
  Object.assign(raw.budgets.accounts[0].time, { revision: 1, reservedMs: 1, ownerId: 'a' })
  raw.budgets.revision = 2
  raw.events[0].data.payload.title += 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(raw)))
  const frozen = parseWorkflowJournalRecord(raw)
  table.rows.set(f.rootSessionId, frozen)
  const journal = new WorkflowJournal(table)
  try {
    await assert.rejects(journal.updateRunTime(f.rootSessionId, f.runId, 'a',
      { elapsedMs: 1, reserveMs: 0, release: true, overrunMs: 1000000 }), /16 MiB/)
    assert.equal(table.get(f.rootSessionId), frozen)
    assert.equal(journal.readFault(), undefined)
    assert.equal(journal.readSnapshot(f.rootSessionId).capacity.bytes, Buffer.byteLength(JSON.stringify(frozen)))
  } finally { await journal.close() }
})
