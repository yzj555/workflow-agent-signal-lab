import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { fixture, memoryTable } from './helpers/workflow-fixture.mjs'

const ingressEvent = (name, payload, eventId = `${name}-${Math.random()}`) => ({
  version: 1,
  runId: '@workflow-ingress',
  eventId,
  name,
  actor: { kind: 'system', id: 'workflow-host' },
  payload,
})

const ingressStall = (journalRevision, attempt = 1, disposition = 'auto-continue') => ingressEvent(
  'runtime/stall-detected',
  {
    incidentId: `pre-run-stall-${attempt}`,
    turn: 1,
    stage: 'requirements',
    noProgressMs: 180000,
    journalRevision,
    attempt,
    disposition,
    reason: '首轮需求分析没有可观察进展。',
    preserved: ['原生目标与会话历史', 'Signal Gate 仍关闭'],
    resumeFrom: '重新读取原始目标并继续需求分析',
  },
  `pre-run-stall-event-${journalRevision}-${attempt}`,
)

test('journal commits an atomic merged contract and publishes a defensive, versioned view', async () => {
  const table = memoryTable()
  const journal = new WorkflowJournal(table, () => 100)
  const f = fixture()
  const observations = []
  journal.subscribe(view => observations.push(view))
  const request = { rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() }
  const result = await journal.commit(request)
  assert.equal(result.revision, 6)
  assert.equal(result.run.needsUser, true)
  assert.equal(result.run.ledger.hardOutcome, 'PENDING')
  assert.equal(observations.length, 1)
  assert.deepEqual(table.get(f.rootSessionId).events.map(event => event.seq), [0, 1, 2, 3, 4, 5])
  result.run.title = 'caller mutation'
  observations[0].run.tasks[0].title = 'observer mutation'
  request.events[0].payload.title = 'request mutation'
  assert.equal(journal.readSnapshot(f.rootSessionId).run.title, '通用流程测试')
  assert.equal(journal.readSnapshot(f.rootSessionId).run.tasks[0].title, '实现文本转换')
  await journal.close()
})

test('pre-run root recovery is durable without inventing a workflow run or approval', async () => {
  const table = memoryTable()
  const journal = new WorkflowJournal(table)
  const f = fixture('pre-run-root')
  let snapshot = await journal.commit({
    rootSessionId: f.rootSessionId,
    expectedRevision: 0,
    events: [ingressStall(0)],
  })
  assert.equal(snapshot.availability, 'absent')
  assert.equal(snapshot.run, null)
  assert.equal(snapshot.history.length, 0)
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.preRunRecovery.status, 'recovering')

  const cold = new WorkflowJournal(table)
  assert.equal(cold.readSnapshot(f.rootSessionId).preRunRecovery.resumeFrom, '重新读取原始目标并继续需求分析')
  snapshot = await cold.commit({
    rootSessionId: f.rootSessionId,
    expectedRevision: 1,
    events: f.initial(),
  })
  assert.equal(snapshot.availability, 'ready')
  assert.equal(snapshot.run.runId, f.runId)
  assert.equal(snapshot.preRunRecovery.status, 'recovering')

  snapshot = await cold.commit({
    rootSessionId: f.rootSessionId,
    expectedRevision: snapshot.revision,
    events: [ingressEvent('runtime/recovery-settled', {
      incidentId: 'pre-run-stall-1',
      outcome: 'resumed',
      summary: '需求入口自动恢复已正常结束。',
    }, 'pre-run-settled')],
  })
  assert.equal(snapshot.preRunRecovery, null)
  assert.equal(snapshot.run.recovery, null)
})

test('pre-run recovery permits only one automatic continuation and rejects foreign lane events', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const f = fixture('pre-run-bounded')
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [ingressStall(0)] })
  const snapshot = await journal.commit({
    rootSessionId: f.rootSessionId,
    expectedRevision: 1,
    events: [ingressStall(1, 2, 'needs-attention')],
  })
  assert.equal(snapshot.preRunRecovery.status, 'needs-attention')
  assert.equal(snapshot.preRunRecovery.attempt, 2)
  await assert.rejects(journal.commit({
    rootSessionId: f.rootSessionId,
    expectedRevision: 2,
    events: [ingressStall(2)],
  }), /needs user attention/)
  await assert.rejects(new WorkflowJournal(memoryTable()).commit({
    rootSessionId: 'foreign-ingress',
    expectedRevision: 0,
    events: [{ ...f.created(), runId: '@workflow-ingress' }],
  }), /reserved pre-run Journal lane/)
})

test('invalid final event rolls back the whole logical batch before any write', async () => {
  const table = memoryTable()
  const journal = new WorkflowJournal(table)
  const f = fixture()
  let observed = 0
  journal.subscribe(() => observed++)
  await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [...f.initial(), f.readyTask(), f.runTask()] }), /Signal Gate/i)
  assert.equal(table.rows.size, 0)
  assert.equal(observed, 0)
  assert.equal(journal.readSnapshot(f.rootSessionId).availability, 'absent')
})

test('same-root concurrent commits perform revision CAS, while independent roots stay separate', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const f = fixture()
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  const approvals = [f.approve(), f.approve()]
  const results = await Promise.allSettled(approvals.map(event => journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 6, events: [event] })))
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected'])
  assert.equal(results[1].reason.code, 'conflict')
  const other = fixture('session-b', 'run-b')
  await journal.commit({ rootSessionId: other.rootSessionId, expectedRevision: 0, events: [other.created()] })
  assert.equal(journal.readSnapshot(f.rootSessionId).revision, 7)
  assert.equal(journal.readSnapshot(other.rootSessionId).revision, 1)
})

test('revision and duplicate event ids stop retries from applying an action twice', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const f = fixture()
  const events = f.initial()
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events })
  await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events }), error => error.code === 'conflict')
  await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 6, events: [events[3]] }), /duplicated/)
  assert.equal(journal.readSnapshot(f.rootSessionId).revision, 6)
})

test('no view is published before the durable write resolves', async () => {
  const table = memoryTable()
  let allowWrite
  const barrier = new Promise(resolve => { allowWrite = resolve })
  table.put = async (key, value) => { await barrier; table.rows.set(key, value) }
  const journal = new WorkflowJournal(table)
  let observed = 0
  journal.subscribe(() => observed++)
  const f = fixture()
  const pending = journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] })
  await Promise.resolve()
  assert.equal(journal.readSnapshot(f.rootSessionId).availability, 'absent')
  assert.equal(observed, 0)
  allowWrite()
  assert.equal((await pending).revision, 1)
  assert.equal(observed, 1)
})

test('failed or uncertain persistence freezes the writer until a fresh recovery', async () => {
  for (const writtenBeforeError of [false, true]) {
    const table = memoryTable()
    const journal = new WorkflowJournal(table)
    const f = fixture()
    let observed = 0
    journal.subscribe(() => observed++)
    table.put = async (key, value) => {
      if (writtenBeforeError) table.rows.set(key, value)
      throw new Error('simulated storage failure')
    }
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] }), error => error.code === 'recovery-required')
    assert.equal(observed, 0)
    assert.throws(() => journal.readSnapshot(f.rootSessionId), /reopen and verify/)
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] }), /reopen and verify/)
    await journal.close()
    const recovered = new WorkflowJournal(table)
    assert.equal(recovered.readSnapshot(f.rootSessionId).availability, writtenBeforeError ? 'ready' : 'absent')
  }
})

test('one throwing or mutating observer cannot reject a committed write or corrupt the next observer', async () => {
  const failures = []
  const journal = new WorkflowJournal(memoryTable(), Date.now, error => failures.push(error))
  const views = []
  journal.subscribe(view => { view.run.title = 'mutated'; throw new Error('observer failed') })
  journal.subscribe(view => views.push(view))
  const f = fixture()
  assert.equal((await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] })).revision, 1)
  assert.equal(views[0].run.title, '通用流程测试')
  assert.equal(failures.length, 1)
})

test('recovering changed requirement versions invalidates prior approval and dependent work', async () => {
  const table = memoryTable()
  const f = fixture()
  const first = new WorkflowJournal(table)
  await first.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [...f.initial(), f.approve()] })
  await first.commit({ rootSessionId: f.rootSessionId, expectedRevision: 7, events: [f.publish(f.requirement(2))] })
  await first.close()
  const recovered = new WorkflowJournal(table)
  const view = recovered.readSnapshot(f.rootSessionId)
  assert.equal(view.run.gates[0].stale, true)
  assert.equal(view.run.tasks[0].stale, true)
  await assert.rejects(recovered.commit({ rootSessionId: f.rootSessionId, expectedRevision: 8, events: [f.readyTask(), f.runTask()] }), /stale/)
})

test('structured Agent projection reports roles and current tasks without exposing task packets', async () => {
  const f = fixture()
  const journal = new WorkflowJournal(memoryTable())
  const view = await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0,
    events: [...f.initial(), f.approve(), f.publish(f.task('blackbox', 'acceptance_qa')), f.assign(), f.assign('blackbox', 'acceptance_qa')] })
  assert.deepEqual(view.run.agents.map(agent => [agent.role, agent.taskTitle]), [
    ['engineer', '实现文本转换'], ['acceptance_qa', '独立黑盒验收'],
  ])
  assert.equal(JSON.stringify(view).includes('forbiddenKnowledge'), false)
  assert.equal(JSON.stringify(view).includes('writeScopes'), false)
})

test('root response stalls and their exact continuation point survive Journal replay', async () => {
  const table = memoryTable()
  const f = fixture()
  const journal = new WorkflowJournal(table)
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  const stalled = f.event('runtime/stall-detected', {
    incidentId: 'stall-1', turn: 9, stage: 'requirements', noProgressMs: 180_000,
    journalRevision: 6, attempt: 1, disposition: 'auto-continue',
    reason: '根协调响应无进展',
    preserved: ['已确认合同', '2 个已完成任务'],
    resumeFrom: '需求确认后的唯一下一步',
  }, { kind: 'system', id: 'workflow-controller/1' })
  let view = await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 6, events: [stalled] })
  assert.deepEqual(view.run.recovery, {
    incidentId: 'stall-1', status: 'recovering', attempt: 1, turn: 9,
    stage: 'requirements', noProgressMs: 180_000, journalRevision: 6,
    reason: '根协调响应无进展', preserved: ['已确认合同', '2 个已完成任务'],
    resumeFrom: '需求确认后的唯一下一步',
  })

  await journal.close()
  const recovered = new WorkflowJournal(table)
  assert.equal(recovered.readSnapshot(f.rootSessionId).run.recovery.incidentId, 'stall-1')
  view = await recovered.commit({ rootSessionId: f.rootSessionId, expectedRevision: 7, events: [
    f.event('runtime/recovery-settled', {
      incidentId: 'stall-1', outcome: 'resumed', summary: '恢复轮次正常结束',
    }, { kind: 'system', id: 'workflow-controller/1' }),
  ] })
  assert.equal(view.run.recovery, null)
})

test('a recovery turn may stall only once more and cannot auto-loop', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const f = fixture()
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 6, events: [
    f.event('runtime/stall-detected', {
      incidentId: 'stall-1', turn: 3, stage: 'requirements', noProgressMs: 1000,
      journalRevision: 6, attempt: 1, disposition: 'auto-continue', reason: '首次停滞',
      preserved: ['Journal'], resumeFrom: '当前阶段',
    }, { kind: 'system', id: 'workflow-controller/1' }),
  ] })
  const view = await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 7, events: [
    f.event('runtime/stall-detected', {
      incidentId: 'stall-2', turn: 4, stage: 'requirements', noProgressMs: 1000,
      journalRevision: 7, attempt: 2, disposition: 'needs-attention', reason: '恢复再次停滞',
      preserved: ['Journal'], resumeFrom: '当前阶段',
    }, { kind: 'system', id: 'workflow-controller/1' }),
  ] })
  assert.equal(view.run.recovery.status, 'needs-attention')
  assert.equal(view.run.recovery.attempt, 2)
  await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 8, events: [
    f.event('runtime/stall-detected', {
      incidentId: 'stall-3', turn: 5, stage: 'requirements', noProgressMs: 1000,
      journalRevision: 8, attempt: 1, disposition: 'auto-continue', reason: '不应再继续',
      preserved: ['Journal'], resumeFrom: '当前阶段',
    }, { kind: 'system', id: 'workflow-controller/1' }),
  ] }), /needs user attention/)
})

test('native forks/copies do not inherit approvals; starting a second unfinished run is rejected', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const first = fixture()
  await journal.commit({ rootSessionId: first.rootSessionId, expectedRevision: 0, events: [first.created()] })
  assert.equal(journal.readSnapshot('native-fork-id').availability, 'absent')
  const second = fixture(first.rootSessionId, 'run-b')
  await assert.rejects(journal.commit({ rootSessionId: first.rootSessionId, expectedRevision: 1, events: [second.created()] }), /unfinished/)
  await assert.rejects(journal.commit({ rootSessionId: 'other-root', expectedRevision: 0, events: [second.created()] }), /another root Session/)
})

test('a terminal run permits an explicit new run and keeps the previous history', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const first = fixture()
  const second = fixture(first.rootSessionId, 'run-b')
  const cancelled = first.event('outcome/declared', { outcome: 'CANCELLED', reason: '测试取消',
    ledger: { pass: 0, fail: 0, waived: 0, pending: 0, hardOutcome: 'PENDING' } })
  await journal.commit({ rootSessionId: first.rootSessionId, expectedRevision: 0, events: [first.created(), cancelled, second.created()] })
  const view = journal.readSnapshot(first.rootSessionId)
  assert.equal(view.run.runId, 'run-b')
  assert.equal(view.history[0].outcome, 'CANCELLED')
  assert.equal(journal.readRunState(first.rootSessionId, first.runId).outcome.outcome, 'CANCELLED')
})

test('cold read rejects unknown versions, missing events, gaps, and mismatched row identities', async () => {
  const table = memoryTable()
  const f = fixture()
  const journal = new WorkflowJournal(table)
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] })
  const valid = table.get(f.rootSessionId)
  for (const mutate of [
    value => { value.schemaVersion = 2 }, value => { value.events = [] },
    value => { value.events[0].seq = 1 }, value => { value.events[0].data.version = 2 },
    value => { value.events[0].data.payload.rootSessionId = 'foreign' },
  ]) {
    const bad = structuredClone(valid); mutate(bad)
    assert.throws(() => parseWorkflowJournalRecord(bad))
  }
  const wrongKey = memoryTable(); wrongKey.rows.set('foreign', valid)
  assert.throws(() => new WorkflowJournal(wrongKey), /row key/)
})

test('commit rejects lossy JSON without touching storage', async () => {
  const table = memoryTable()
  const journal = new WorkflowJournal(table)
  for (const poison of [undefined, () => {}, new Date(), NaN]) {
    const f = fixture()
    const created = f.created(); created.payload.title = poison
    await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [created] }))
  }
  const f = fixture()
  const events = [f.created()]; events.hidden = true
  await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events }))
  assert.equal(table.rows.size, 0)
})

test('close drains accepted writes but rejects new submissions', async () => {
  const journal = new WorkflowJournal(memoryTable())
  const f = fixture()
  const pending = journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] })
  const closing = journal.close()
  await assert.rejects(journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] }), /draining/)
  assert.equal((await pending).revision, 1)
  await closing
  assert.throws(() => journal.readSnapshot(f.rootSessionId), /closed/)
})
