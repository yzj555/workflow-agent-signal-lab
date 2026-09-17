import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approveRequirementsGate,
  reviseRequirementsGate,
  selectRequirementsGate,
} from '../lib/workflow-requirements-gate.js'
import { REQUIREMENTS_CONFIRM_LABEL } from '../lib/workflow-control.js'

function fixture(overrides = {}, behavior = {}) {
  const answers = []
  let cancellations = 0
  const question = {
    id: 'gate-1',
    question: '目标、范围和成功条件是否理解正确？',
    detail: '## 先确认理解\n\n只会启动只读方案 Agent。',
    options: [{ label: REQUIREMENTS_CONFIRM_LABEL, description: '只授权只读规划。' }],
    multiSelect: false,
    intent: { kind: 'plan-review', approve: REQUIREMENTS_CONFIRM_LABEL },
    ...overrides,
  }
  const wait = {
    kind: 'plan-review',
    key: 'q:gate-1',
    sessionId: 'session-1',
    questions: [question],
    answer: async answer => {
      if (behavior.answerError) throw behavior.answerError
      answers.push(answer)
    },
    cancel: async () => {
      if (behavior.cancelError) throw behavior.cancelError
      cancellations += 1
    },
  }
  return { wait, answers, cancellationCount: () => cancellations }
}

test('first-gate selector claims only the exact read-only planning decision', () => {
  const expected = fixture().wait
  assert.equal(selectRequirementsGate({ pendingInteraction: expected }), expected)

  const execution = fixture({
    options: [{ label: '确认此版本并允许执行' }],
    intent: { kind: 'plan-review', approve: '确认此版本并允许执行' },
  }).wait
  const generic = fixture({ intent: undefined }).wait
  const multi = fixture({ options: [
    { label: REQUIREMENTS_CONFIRM_LABEL }, { label: '另一个答案' },
  ] }).wait
  assert.equal(selectRequirementsGate({ pendingInteraction: execution }), null)
  assert.equal(selectRequirementsGate({ pendingInteraction: generic }), null)
  assert.equal(selectRequirementsGate({ pendingInteraction: multi }), null)
  assert.equal(selectRequirementsGate({}), null)
})

test('approval answers the current PendingQuestion with the Host-owned label', async () => {
  const { wait, answers } = fixture()
  const selected = selectRequirementsGate({ pendingInteraction: wait })
  assert.ok(selected)
  await approveRequirementsGate(selected)
  assert.deepEqual(answers, [{
    answers: [{ id: 'gate-1', selected: [REQUIREMENTS_CONFIRM_LABEL] }],
  }])
})

test('returning to conversation cancels the official PendingQuestion', async () => {
  const { wait, cancellationCount } = fixture()
  const selected = selectRequirementsGate({ pendingInteraction: wait })
  assert.ok(selected)
  await reviseRequirementsGate(selected)
  assert.equal(cancellationCount(), 1)
})

test('a stale PendingQuestion re-arms the UI through a surfaced error', async () => {
  const { wait } = fixture({}, { answerError: new Error('stale request') })
  const selected = selectRequirementsGate({ pendingInteraction: wait })
  assert.ok(selected)
  await assert.rejects(approveRequirementsGate(selected), /stale request/)
})
