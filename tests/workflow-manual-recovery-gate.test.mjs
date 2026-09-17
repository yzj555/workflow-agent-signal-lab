import assert from 'node:assert/strict'
import test from 'node:test'
import { selectManualRecoveryGate, decideManualRecovery, discussManualRecovery } from '../lib/workflow-manual-recovery-gate.js'
import { manualCloseQuestion, MANUAL_CLOSE_LABEL, KEEP_UNKNOWN_LABEL } from '../lib/workflow-control.js'

function fixture() {
  const calls = []
  const question = manualCloseQuestion({ assignments: { a: { taskId: 't' } }, records: {} }, {
    gateId: 'exact-gate-id', reason: '核实后结束；非退出凭证',
    checks: [{ assignmentId: 'a', incidentId: 'i', taskVersion: 4, commandIds: ['c'],
      evidence: [{ source: '人工核实', observation: '完整陈述' }] }],
  })
  const wait = { kind: 'plan-review', sessionId: 'owner', key: 'original-pending-key', questions: [question],
    async answer(value) { assert.equal(this, wait); calls.push(value) },
    async cancel() { assert.equal(this, wait); calls.push('cancel') },
  }
  return { wait, calls, owner: { sessionId: 'owner', pendingInteraction: wait } }
}
test('manual selector preserves the exact Host question and Session-owned wait', () => {
  const f = fixture()
  assert.equal(selectManualRecoveryGate(f.owner), f.wait)
  f.wait.questions[0].options.reverse()
  assert.equal(selectManualRecoveryGate(f.owner), f.wait, 'order does not change available answers')
  assert.equal(selectManualRecoveryGate({ ...f.owner, sessionId: 'another-session' }), null)
  assert.equal(selectManualRecoveryGate({ pendingInteraction: f.wait }), null)
})
test('ordinary plans, batch questions, malformed payloads and extra options fall back to native UI', () => {
  for (const mutate of [
    f => f.wait.kind = 'question', f => f.wait.key = '', f => f.wait.answer = undefined,
    f => f.wait.cancel = undefined, f => f.wait.questions.push(f.wait.questions[0]),
    f => f.wait.questions = null, f => f.wait.questions[0] = null,
    f => f.wait.questions[0].id = '', f => f.wait.questions[0].header = '计划',
    f => f.wait.questions[0].question = '普通计划，是否执行？',
    f => f.wait.questions[0].detail = undefined, f => f.wait.questions[0].multiSelect = true,
    f => f.wait.questions[0].intent = { kind: 'plan-review', approve: '确认执行' },
    f => f.wait.questions[0].options.push({ label: '第三选项' }),
    f => f.wait.questions[0].options[0] = f.wait.questions[0].options[1],
    f => f.wait.questions[0].options[0].description = {},
  ]) {
    const f = fixture(); mutate(f)
    assert.equal(selectManualRecoveryGate(f.owner), null)
  }
  for (const value of [undefined, null, [], '', true, 42]) assert.equal(selectManualRecoveryGate({ sessionId: 'owner', pendingInteraction: value }), null)
})
test('both decisions retain exact option labels and id; no scope or revision is synthesized', async () => {
  for (const [choice, label] of [['keep', KEEP_UNKNOWN_LABEL], ['close', MANUAL_CLOSE_LABEL]]) {
    const f = fixture()
    await decideManualRecovery(selectManualRecoveryGate(f.owner), choice)
    assert.deepEqual(f.calls, [{ answers: [{ id: 'exact-gate-id', selected: [label] }] }])
  }
})
test('return-to-chat cancels only the current wait and errors stay visible to the UI', async () => {
  const f = fixture()
  await discussManualRecovery(selectManualRecoveryGate(f.owner))
  assert.deepEqual(f.calls, ['cancel'])
  f.wait.answer = async () => { throw new Error('request expired') }
  await assert.rejects(decideManualRecovery(f.wait, 'close'), /request expired/)
  f.wait.cancel = async () => { throw new Error('cancel failed') }
  await assert.rejects(discussManualRecovery(f.wait), /cancel failed/)
})
