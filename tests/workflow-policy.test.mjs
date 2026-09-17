import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { classifyWorkflowOutcome, summarizeAgentFollowup } from '../lib/index.js'

test('a documented or approved deviation outranks optimistic pass language', () => {
  assert.equal(classifyWorkflowOutcome('交付：全链路通过。偏差记录（已获批准）：删除改用了新实例。'), 'qualified')
  assert.equal(classifyWorkflowOutcome('结论：有条件通过；验收豁免一项。'), 'qualified')
  assert.equal(classifyWorkflowOutcome('FAIL：0 项；WAIVED：1 项。结论：通过。'), 'qualified')
})

test('hard acceptance failure cannot become a completed outcome', () => {
  assert.equal(classifyWorkflowOutcome('结论：未通过；硬性验收有一项未满足。'), 'failed')
  assert.equal(classifyWorkflowOutcome('FAIL=2；WAIVED=0。结论：通过。'), 'failed')
})

test('clean pass and cancellation remain distinct', () => {
  assert.equal(classifyWorkflowOutcome('结论：通过。验收项目全部通过。'), 'passed')
  assert.equal(classifyWorkflowOutcome('FAIL：0 项；WAIVED：0 项。结论：通过。'), 'passed')
  assert.equal(classifyWorkflowOutcome('结论：已取消。用户要求停止。'), 'cancelled')
})

test('preset requires continuable lifecycle for cross-stage ownership', () => {
  const preset = readFileSync(new URL('../preset/workflow-agent-signal-lab/agent.cordis.yml', import.meta.url), 'utf8')
  assert.match(preset, /continuable/)
  assert.match(preset, /same child/)
  assert.match(preset, /workflow_return/)
  assert.match(preset, /workflow_rollback/)
  assert.match(preset, /不因失败、停止或模型判断自动撤销/)
  assert.match(preset, /workflow_confirm/)
  assert.doesNotMatch(preset, /name:.*dsh-crew/)
  assert.match(preset, /Never say “全链路通过”/)
  assert.match(preset, /其他候选的采纳／不采纳决定已经独立保存/)
  assert.match(preset, /只用 workflow_learn 提交 Host 返回的 candidateId/)
  assert.match(preset, /不得重提整批，也不得重跑实现或验证/)
  assert.doesNotMatch(preset, /退回修改”时整批不落盘/)
})

test('continued Agent work is summarized from its latest message', () => {
  assert.equal(
    summarizeAgentFollowup('Phase 2 of 2（同一实例续接）——删除探针。\n更多背景'),
    'Phase 2 of 2（同一实例续接）——删除探针。',
  )
  assert.equal(summarizeAgentFollowup(`  ${'x'.repeat(120)}\nignored`, 20), `${'x'.repeat(19)}…`)
})
