import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './helpers/workflow-crash-fixture.mjs'

const options = { timeout: 90000 }
const phases = [
  { mode: 'requirements-gate', kind: 'signal', header: '需求理解', nextTask: 'architecture' },
  { mode: 'execution-gate', kind: 'execution', header: '执行授权', nextTask: 'implementation' },
  { mode: 'text-gate', kind: 'signal', header: '需求确认', nextTask: 'author' },
  { mode: 'local-execution-gate', kind: 'execution', header: '执行授权', nextTask: 'implementation' },
]
const originalSource = 'export const nativeReady = "original"\n'
const validApprovals = state => Object.values(state.gates).filter(gate => gate.status === 'approved' && !state.staleGateIds.includes(gate.gateId))
const latestGate = (receipt, kind) => Object.values(receipt.state.gates).filter(gate => gate.kind === kind).at(-1)
async function untouched(h) {
  assert.equal(await readFile(join(h.directory, 'src/native.js'), 'utf8'), originalSource)
  await assert.rejects(access(join(h.directory, 'recovery-checks.jsonl')), { code: 'ENOENT' }, 'No frozen check ran without execution authority')
}
async function assertBlocked(h, host, expected) {
  const probe = await host.request('probe-advance')
  assert.ok(probe.detail.accepted === false || probe.detail.result.needsUser === true)
  assert.deepEqual(probe.snapshot, expected.snapshot)
  assert.deepEqual(probe.state, expected.state)
  assert.deepEqual(probe.requests, expected.requests)
  await untouched(h)
  return probe
}
async function resumedPending(t, phase, suffix) {
  const h = await fixture(t, `${phase.mode}-${suffix}`, phase.mode)
  const active = await h.host(phase.mode)
  assert.equal(active.ready.nativeQuestion.question.header, phase.header)
  const oldQuestionId = active.ready.nativeQuestion.question.id
  assert.equal(active.ready.state.gates[oldQuestionId].status, 'waiting')
  await untouched(h)
  const before = await h.cut(active)
  const cold = await h.host('cold'), after = cold.ready
  assert.equal(after.snapshot.run.runId, before.snapshot.run.runId)
  assert.equal(after.snapshot.run.outcome, null)
  assert.deepEqual(after.state.records, before.state.records)
  assert.deepEqual(after.state.assignments, before.state.assignments)
  assert.deepEqual(after.state.gates, before.state.gates, 'Pending approval remains unapproved, not silently reconstructed as an answer')
  assert.deepEqual(after.snapshot.run.budget.used, before.snapshot.run.budget.used)
  assert.deepEqual(after.snapshot.run.budget.limits, before.snapshot.run.budget.limits)
  assert.equal(after.requests.length, 0); assert.equal(after.questions.length, 0)
  assert.equal(after.nativeQuestion, undefined, 'A new Host has no old in-memory native answer handle')
  await assertBlocked(h, cold, after)
  await h.save('cold-pending-confirmation', { ...after, oldQuestionId })
  return { h, cold, before, after, oldQuestionId }
}

for (const phase of phases) {
  test(`${phase.mode}: crash preserves contract, rejects stale/refused answers, fresh approval admits only its next phase`, options, async t => {
    const { h, cold, before, after, oldQuestionId } = await resumedPending(t, phase, 'answers')
    await h.repeated(cold, after)
    const resumed = await h.host('cold')
    const stale = await resumed.request('explicit-confirm', { oldQuestionId })
    assert.equal(stale.detail.accepted, false)
    assert.equal(stale.state.gates[oldQuestionId].status, 'cancelled')
    assert.equal(latestGate(stale, phase.kind).status, 'cancelled')
    assert.equal(validApprovals(stale.state).length, validApprovals(before.state).length)
    await assertBlocked(h, resumed, stale)
    const refused = await resumed.request('explicit-confirm', { reject: true })
    assert.equal(refused.detail.accepted, true, 'Explicit refusal is a recorded decision, not a transport failure')
    assert.equal(latestGate(refused, phase.kind).status, 'rejected')
    await assertBlocked(h, resumed, refused)
    const approved = await resumed.request('explicit-confirm')
    assert.equal(approved.detail.accepted, true)
    const newGate = latestGate(approved, phase.kind)
    assert.equal(newGate.status, 'approved'); assert.notEqual(newGate.gateId, oldQuestionId)
    assert.equal(approved.questions.at(-1).headers[0], phase.header)
    assert.deepEqual(approved.state.assignments, before.state.assignments, 'Confirmation alone never starts an Agent')
    assert.equal(approved.requests.length, 0)
    await untouched(h)
    const advanced = await resumed.request('explicit-advance')
    const next = advanced.snapshot.run.agents.filter(agent => agent.taskId === phase.nextTask)
    assert.equal(next.length, 1); assert.equal(next[0].status, 'idle')
    assert.equal(Object.keys(advanced.state.commands).length, 0)
    if (phase.mode === 'requirements-gate') {
      await untouched(h)
      assert.equal(advanced.snapshot.run.agents.some(agent => agent.taskId === 'implementation'), false)
      const waiting = await assertBlocked(h, resumed, advanced)
      assert.match(waiting.detail.result.next, /执行授权/)
    } else if (phase.mode === 'text-gate') {
      await untouched(h)
      assert.equal(advanced.snapshot.run.agents.some(agent => agent.taskId === 'acceptance'), false)
      assert.equal(advanced.snapshot.run.ledger.hardOutcome, 'PENDING')
    } else {
      assert.deepEqual(advanced.state.records['design:design'], before.state.records['design:design'])
      assert.equal(await readFile(join(h.directory, 'src/native.js'), 'utf8'), 'export const nativeReady = true\n')
    }
    await h.save('fresh-decision-explicit-next-wave', advanced)
    await h.repeated(resumed, advanced)
  })

  test(`${phase.mode}: durable approval survives another crash but never dispatches automatically or twice`, options, async t => {
    const { h, cold, before } = await resumedPending(t, phase, 'approved-cut')
    const approved = await cold.request('explicit-confirm')
    const gate = latestGate(approved, phase.kind)
    assert.equal(gate.status, 'approved'); assert.equal(approved.requests.length, 0)
    assert.deepEqual(approved.state.assignments, before.state.assignments)
    await untouched(h)
    const committed = await h.cut(cold)
    assert.equal(committed.state.gates[gate.gateId].status, 'approved')
    const recovered = await h.host('cold')
    assert.deepEqual(recovered.ready.state.gates, committed.state.gates)
    assert.deepEqual(recovered.ready.state.assignments, committed.state.assignments)
    assert.equal(recovered.ready.requests.length, 0); assert.equal(recovered.ready.questions.length, 0)
    await h.repeated(recovered, recovered.ready)
    const nextHost = await h.host('cold')
    const duplicate = await nextHost.request('explicit-confirm')
    assert.equal(duplicate.detail.accepted, false, 'Already approved current contract does not open another approval')
    assert.equal(duplicate.questions.length, 0)
    const next = await nextHost.request('explicit-advance')
    const task = next.snapshot.run.agents.filter(agent => agent.taskId === phase.nextTask)
    assert.equal(task.length, 1); assert.equal(task[0].status, 'idle')
    assert.equal(next.activity.filter(item => item.event === 'agent/created' && item.id === task[0].agentSessionId).length, 1)
    assert.equal(next.snapshot.run.outcome, null)
    await h.save('approved-crash-preserved-no-duplicate-dispatch', next)
    await h.repeated(nextHost, next)
  })

  test(`${phase.mode}: changed requirements cannot inherit approval; an already-assigned plan must end before a new run`, options, async t => {
    const { h, cold } = await resumedPending(t, phase, 'changed-contract')
    const approved = await cold.request('explicit-confirm')
    const oldGate = latestGate(approved, phase.kind)
    assert.equal(oldGate.status, 'approved')
    let changed = await cold.request('change-gate-proposal')
    if (phase.mode === 'execution-gate') {
      assert.equal(changed.detail.accepted, false)
      assert.match(changed.detail.error, /先停止本轮/)
      assert.deepEqual(changed.state, approved.state, 'A previously assessed contract must not be silently overwritten')
      await untouched(h)
      const stopped = await cold.request('explicit-stop')
      assert.equal(stopped.snapshot.run.outcome, 'CANCELLED')
      const oldRunId = stopped.snapshot.run.runId
      changed = await cold.request('change-gate-proposal')
      assert.equal(changed.detail.accepted, true)
      assert.notEqual(changed.snapshot.run.runId, oldRunId)
      assert.deepEqual(changed.state.assignments, {})
      const historical = await cold.request('read-run', { runId: oldRunId })
      assert.deepEqual(historical.detail, stopped.state, 'Starting a new run preserves the old contract, approval and cancellation')
    } else {
      assert.equal(changed.detail.accepted, true)
      assert.ok(changed.state.staleGateIds.includes(oldGate.gateId))
    }
    assert.equal(validApprovals(changed.state).length, 0)
    assert.equal(changed.requests.length, 0)
    await assertBlocked(h, cold, changed)
    const old = await cold.request('explicit-confirm', { oldQuestionId: oldGate.gateId })
    assert.equal(old.detail.accepted, false)
    assert.equal(validApprovals(old.state).length, 0)
    await assertBlocked(h, cold, old)
    const fresh = await cold.request('explicit-confirm')
    assert.equal(fresh.detail.accepted, true)
    const requiresNewPlan = phase.mode === 'execution-gate'
    assert.equal(fresh.questions.at(-1).headers[0], requiresNewPlan ? '需求理解' : phase.header)
    assert.equal(validApprovals(fresh.state).length, 1)
    assert.equal(validApprovals(fresh.state)[0].kind, requiresNewPlan ? 'signal' : phase.kind)
    assert.equal(fresh.requests.length, 0)
    await untouched(h)
    await h.save('changed-contract-new-requirement-only', fresh)
    await h.repeated(cold, fresh)
  })
}
