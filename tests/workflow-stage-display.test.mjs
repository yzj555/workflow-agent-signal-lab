import assert from 'node:assert/strict'
import test from 'node:test'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { WorkflowJournal, workflowSnapshotSchema } from '../lib/workflow-journal.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'
import { controllerFixture } from './helpers/workflow-controller-fixture.mjs'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const display = snapshot => displayWorkflowState({ status: 'ready', snapshot }, [], stages)
const detail = (snapshot, index) => display(snapshot).stageDetails[index]

async function delivered(t) {
  const f = await controllerFixture(t)
  await f.setup()
  await f.author('测试功能已就绪')
  await f.qa(true)
  await f.advance()
  return f
}

test('Host identifies the versioned text contract without migrating its saved events', async t => {
  const f = await delivered(t)
  const before = structuredClone([...f.table.rows])
  assert.equal(f.snapshot().run.executionProfile, 'workflow-text-pilot/1')
  assert.deepEqual([...f.table.rows], before)
  const generic = fixture()
  const journal = new WorkflowJournal(memoryTable())
  const old = await journal.commit({ rootSessionId: generic.rootSessionId, expectedRevision: 0, events: generic.initial() })
  assert.equal(old.run.executionProfile, undefined, 'the same preset id is not evidence of this execution profile')
  const unsupported = structuredClone(f.snapshot())
  unsupported.run.executionProfile = 'workflow-text-pilot/999'
  assert.equal(workflowSnapshotSchema.safeParse(unsupported).success, false)
})

test('a completed text run cannot imply active deposition without evidence', async t => {
  const f = await delivered(t)
  const snapshot = f.snapshot()
  const before = structuredClone(snapshot)
  const result = display(snapshot)
  assert.deepEqual(result.stageStates, ['done', 'merged', 'done', 'done', 'not_required', 'done', 'not_run'])
  assert.deepEqual(result.stageDetails.map(item => item.label), ['已确认', '并入需求确认', '已完成', '已完成', '本次无需', '已交付', '未整理'])
  assert.ok(result.stageDetails.every(item => item.reason.length > 0))
  assert.match(result.completionNotice, /本轮已结束.*通过.*经验未整理/)
  assert.doesNotMatch(result.now, /正在整理/)
  assert.equal(result.badge, '通过')
  assert.deepEqual(snapshot, before, 'the UI must not write skip or completion events')
})

test('absence of profile metadata never turns an unexecuted stage into an approved skip', async t => {
  const f = await delivered(t)
  const legacy = structuredClone(f.snapshot())
  delete legacy.run.executionProfile
  assert.equal(workflowSnapshotSchema.safeParse(legacy).success, true, 'new client can read an older Host response')
  for (const index of [1, 4]) {
    assert.equal(detail(legacy, index).state, 'not_run')
    assert.equal(detail(legacy, index).label, '未执行')
    assert.match(detail(legacy, index).reason, /不推断/)
  }
  assert.equal(detail(legacy, 6).label, '未整理', 'an older terminal run can still be reviewed, but absence is not activity')
})

test('a cancelled run has an ending, not a successful or perpetually active delivery', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  await f.controller.stop(f.root, {})
  const result = display(f.snapshot())
  assert.equal(result.stageDetails[6].label, '未整理')
  assert.equal(result.stageDetails[5].label, '未交付')
  assert.notEqual(result.stageStates[5], 'done')
  assert.match(result.completionNotice, /本轮已结束.*已取消/)
})

test('a failed or qualified outcome is never painted as a normal completed delivery', async t => {
  const f = await delivered(t)
  for (const outcome of ['FAIL', 'QUALIFIED']) {
    const snapshot = structuredClone(f.snapshot())
    snapshot.run.outcome = outcome
    if (outcome === 'QUALIFIED') snapshot.run.ledger = { pass: 1, fail: 0, waived: 1, pending: 0, hardOutcome: 'QUALIFIED' }
    const result = detail(snapshot, 5)
    assert.notEqual(result.state, 'done')
    assert.equal(result.label, outcome === 'FAIL' ? '未交付' : '有条件交付')
    snapshot.run.gates.push({ ...snapshot.run.gates[0], gateId: 'delivery', kind: 'delivery', stage: 'delivery' })
    assert.equal(detail(snapshot, 5).label, result.label, 'an approved delivery gate must not override the actual outcome')
  }
})

test('post-delivery learning stays pending until its own decision exists', async t => {
  const f = await delivered(t)
  const snapshot = structuredClone(f.snapshot())
  snapshot.run.stage = 'learning'
  snapshot.run.proposedLearningCount = 1
  assert.equal(detail(snapshot, 5).state, 'done')
  assert.equal(detail(snapshot, 6).state, 'waiting')
  assert.match(display(snapshot).completionNotice, /仍待你决定/)
  snapshot.run.learningDecided = true
  assert.equal(detail(snapshot, 6).label, '已作决定')
  assert.match(detail(snapshot, 6).reason, /不额外声称/)
  assert.equal(display(snapshot).stageStates.includes('current'), false)
})

test('a returned learning item is visible without rolling back completed candidate decisions', async t => {
  const f = await delivered(t)
  const snapshot = structuredClone(f.snapshot())
  snapshot.run.stage = 'learning'
  snapshot.run.proposedLearningCount = 2
  snapshot.run.learningDecided = false
  snapshot.run.learning = {
    reviewed: true,
    decisionRecorded: false,
    candidates: [
      { id: 'accepted', statement: '已确认规则。', basis: 'evidence', scope: 'preset', status: 'accepted', revisionCount: 0 },
      { id: 'returned', statement: '需要修订规则。', basis: 'evidence', scope: 'preset', status: 'revision-required', revisionCount: 0 },
    ],
    applied: [],
    revokedRuleIds: [],
    decisionAudit: { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: 'learning-batch' },
  }
  assert.equal(detail(snapshot, 6).label, '待修订 1 条')
  const projection = display(snapshot)
  assert.equal(projection.badge, '待修订')
  assert.match(projection.attentionDetail, /原生输入框/)
  assert.match(projection.learning.summary, /1 条已采纳.*1 条待修订/)
  assert.deepEqual(projection.learning.items.map(item => item.status), ['已采纳', '待修订'])
})

test('an actual stage task or gate takes precedence over the text route omission hint', async t => {
  const f = await delivered(t)
  const snapshot = structuredClone(f.snapshot())
  snapshot.run.outcome = null
  snapshot.run.stage = 'review'
  snapshot.run.tasks.push({ ...snapshot.run.tasks[1], taskId: 'additional-review', stage: 'review', status: 'pending' })
  assert.notEqual(detail(snapshot, 4).state, 'not_required')
  snapshot.run.gates.push({ ...snapshot.run.gates[0], gateId: 'review-gate', kind: 'review', stage: 'review', status: 'waiting' })
  assert.equal(detail(snapshot, 4).state, 'waiting')
})

test('stale inputs, failed tasks, and incomplete deliveries cannot receive a completed stage mark', async t => {
  const f = await delivered(t)
  const snapshot = structuredClone(f.snapshot())
  snapshot.run.tasks[0].stale = true
  assert.equal(detail(snapshot, 2).state, 'unconfirmed')
  assert.equal(detail(snapshot, 5).state, 'unconfirmed')
  snapshot.run.tasks[0].stale = false
  snapshot.run.tasks[0].status = 'failed'
  assert.equal(detail(snapshot, 2).state, 'failed')
  assert.notEqual(detail(snapshot, 5).state, 'done')
})

test('an ending does not imply that a recorded running stage has stopped', async t => {
  const f = await delivered(t)
  const snapshot = structuredClone(f.snapshot())
  snapshot.run.tasks[0].status = 'running'
  snapshot.run.agents[0].status = 'running'
  assert.equal(detail(snapshot, 2).label, '运行记录')
  assert.equal(detail(snapshot, 2).state, 'unconfirmed')
  assert.match(detail(snapshot, 2).reason, /不能据此推断进程已停止/)
  assert.match(display(snapshot).completionNotice, /仍有运行记录待核对/)
})

test('historical replaced gates cannot hide the current confirmed requirements stage', async t => {
  const f = await delivered(t)
  const snapshot = structuredClone(f.snapshot())
  snapshot.run.gates.unshift({ ...snapshot.run.gates[0], gateId: 'old-gate', status: 'approved', stale: true })
  assert.equal(detail(snapshot, 0).state, 'done')
  snapshot.run.gates.at(-1).stale = true
  assert.equal(detail(snapshot, 0).state, 'unconfirmed')
})

test('a committed verification return exposes its reason, responsible work and revalidation next step', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  await f.author('功能已就绪')
  await f.qa(false)
  await f.controller.returnForRework(f.root, f.revision(), new AbortController().signal)
  await f.advance()
  const snapshot = f.snapshot()
  assert.deepEqual(snapshot.run.latestReturn, {
    fromStage: 'verification', toStage: 'implementation', responsibleTaskId: 'author',
    reason: 'AC-1：当前文本缺少“测试”', attempt: 1,
  })
  const result = display(snapshot)
  assert.equal(result.badge, '返工中')
  assert.equal(result.tone, 'return')
  assert.equal(result.needsUser, false)
  assert.match(result.now, /第 1 次返工.*验证退回.*实现/)
  assert.match(result.nowDetail, /原因：AC-1.*当前修正.*交付文本/)
  assert.match(result.next, /完成后.*验证重新验收/)
  assert.match(result.nextDetail, /原独立验收 Agent.*重新验收/)
  assert.match(result.attentionTitle, /不需要你操作/)
})

test('snapshots from before return context was exposed remain readable', async t => {
  const f = await delivered(t)
  const older = structuredClone(f.snapshot())
  delete older.run.latestReturn
  assert.equal(workflowSnapshotSchema.safeParse(older).success, true)
})
