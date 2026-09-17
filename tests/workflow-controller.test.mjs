import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile, readFile } from 'node:fs/promises'
import { WorkflowTextController, explicitAnswer, CONFIRM_LABEL } from '../lib/workflow-control.js'
import { controllerFixture, proposal, reportQA, signal } from './helpers/workflow-controller-fixture.mjs'

test('a pending plugin gate belongs to its exact root instance, not a recycled Session id', async t => {
  const ready = Promise.withResolvers(), answer = Promise.withResolvers()
  const f = await controllerFixture(t, { ask: (_agent, question) => {
    ready.resolve(question)
    return answer.promise
  } })
  await f.controller.propose(f.root, proposal(0), signal)
  const confirming = f.controller.confirm(f.root, f.revision(), signal)
  const outcome = confirming.then(value => ({ value }), error => ({ error }))
  const question = await ready.promise
  assert.equal(f.controller.isAwaitingUser(f.root), true)
  const replacement = { id: f.root.id }
  f.live.set(replacement.id, replacement)
  f.driver.isRoot = candidate => f.live.get(candidate.id) === candidate
  f.controller.bindRoot(replacement)
  assert.equal(f.controller.isAwaitingUser(f.root), false)
  assert.equal(f.controller.isAwaitingUser(replacement), false)
  answer.resolve({ answers: [{ id: question.id, selected: [CONFIRM_LABEL] }] })
  assert.ok((await outcome).error, 'the old root cannot approve after losing runtime identity')
  assert.equal(f.snapshot().run.gates.some(gate => gate.status === 'approved'), false)
})

test('the text requirement card shares the one confirmation contract and fails closed when a face is missing', async t => {
  const cards = await import('../lib/workflow-control.js')
  const f = await controllerFixture(t)
  await f.setup()
  const question = f.questions.at(-1)
  const runId = f.snapshot().run.runId
  assert.equal(cards.CONFIRMATION_CARD_CONTRACT_VERSION, 'workflow-confirmation-card/1')
  assert.deepEqual([...cards.CONFIRMATION_REQUIRED_FIELDS], ['whyNow', 'changes', 'preserved', 'impactAndNext', 'auditPointer'])
  assert.deepEqual([...cards.CONFIRMATION_CARD_KINDS], ['requirements', 'execution', 'rule-cleanup', 'rollback'])
  for (const field of cards.CONFIRMATION_REQUIRED_FIELDS) {
    assert.match(question.detail, new RegExp(`\\*\\*${cards.CONFIRMATION_FIELD_LABELS[field]}\\*\\*`), `missing required face ${field}`)
  }
  assert.equal(question.header, '需求确认')
  assert.deepEqual(question.options.map(option => option.label), [CONFIRM_LABEL, '需要修改'])
  assert.equal(question.intent.approve, CONFIRM_LABEL)
  assert.ok(question.detail.includes(cards.CONFIRMATION_AUDIT_POINTERS.requirements))
  assert.doesNotMatch(question.detail, new RegExp(runId))
  assert.doesNotMatch(question.detail, /runId|ruleId|evidenceId/i)

  const draft = {
    kind: 'rollback',
    revision: 3,
    retained: cards.CONTRACT_RETAINED_SEMANTICS,
    headline: '标题',
    header: '头部',
    question: '是否确认？',
    whyNow: '原因。',
    changes: '变化。',
    preserved: '保持。',
    impactAndNext: ['- 影响。'],
    options: [{ label: '批准', description: '批准。' }],
  }
  const card = cards.renderConfirmationCard(draft)
  assert.equal(card.approveLabel, '批准')
  assert.equal(card.binding.revision, 3)
  assert.equal(card.binding.contractVersion, cards.CONFIRMATION_CARD_CONTRACT_VERSION)
  for (const field of ['whyNow', 'changes', 'preserved', 'impactAndNext']) {
    assert.throws(
      () => cards.renderConfirmationCard({ ...draft, [field]: field === 'impactAndNext' ? [] : '   ' }),
      error => error instanceof cards.ConfirmationCardError && error.code === 'CONFIRMATION_CARD_INCOMPLETE',
      `${field} must fail closed`,
    )
  }
  assert.throws(() => cards.assertConfirmationCardCurrent(card, { revision: 4, retained: cards.CONTRACT_RETAINED_SEMANTICS }), /过期/)
  assert.throws(
    () => cards.assertConfirmationCardCurrent(card, {
      revision: 3,
      retained: { ...cards.CONTRACT_RETAINED_SEMANTICS, gateSemantics: '被替换的门禁语义' },
    }),
    /保留项/,
  )

  const state = f.journal.readRunState(f.root.id, runId)
  const retained = cards.retainedSnapshotFromState(state)
  const requirement = state.records['requirement:requirement']
  const widened = {
    ...state,
    records: {
      ...state.records,
      'requirement:requirement': {
        ...requirement,
        data: { ...requirement.data, permissionBoundaries: [...requirement.data.permissionBoundaries, '被追加的边界'] },
      },
    },
  }
  assert.notEqual(
    cards.retainedSemanticsDigest(cards.retainedSnapshotFromState(widened)),
    cards.retainedSemanticsDigest(retained),
    'a changed permission boundary must change the retained snapshot',
  )
  assert.throws(() => cards.retainedSnapshotFromState({ ...state, records: {} }), /缺少当前需求或验收记录/)

  // A Host-decorated historical rule keeps its identity in the record and loses it
  // on the first screen; the guard is fed every identity the record can prove.
  const decoration = '【已确认历史规则 learning-9f2c1d3e-aaaa-4bbb-8ccc-ddddeeee0000@v3 · 当前项目】示例规则。'
  assert.deepEqual(cards.ruleIdentitiesInText(decoration), ['learning-9f2c1d3e-aaaa-4bbb-8ccc-ddddeeee0000'])
  assert.equal(cards.displayRecordedRuleText(decoration), '【已确认历史规则 · 当前项目】示例规则。')
  assert.equal(cards.displayRecordedRuleText('普通约束，不含规则标识。'), '普通约束，不含规则标识。')
  const decorated = {
    ...state,
    records: {
      ...state.records,
      'requirement:requirement': {
        ...requirement,
        data: { ...requirement.data, constraints: [...requirement.data.constraints, decoration] },
      },
    },
  }
  const identifiers = cards.firstScreenIdentifiers(decorated)
  assert.ok(identifiers.includes('learning-9f2c1d3e-aaaa-4bbb-8ccc-ddddeeee0000'))
  assert.ok(identifiers.includes(runId))
  assert.throws(
    () => cards.renderConfirmationCard({
      ...draft,
      forbiddenIdentifiers: identifiers,
      preserved: '泄漏 learning-9f2c1d3e-aaaa-4bbb-8ccc-ddddeeee0000',
    }),
    /首屏/,
  )
  const sanitized = cards.renderConfirmationCard({
    ...draft,
    forbiddenIdentifiers: identifiers,
    preserved: cards.displayRecordedRuleText(decoration),
  })
  assert.equal(sanitized.detail.includes('learning-9f2c1d3e'), false)
})

test('native answer must match one current question and unambiguous approval', () => {
  for (const answer of [
    { id: 'gate', selected: [], custom: '同意，但是把范围扩大' },
    { id: 'gate', selected: [CONFIRM_LABEL], custom: '先别执行' },
    { id: 'gate', selected: [CONFIRM_LABEL, '需要修改'] },
    { id: 'gate', selected: [] },
  ]) assert.equal(explicitAnswer({ answers: [answer] }, 'gate').approved, false)
  assert.equal(explicitAnswer({ answers: [{ id: 'gate', selected: [], custom: CONFIRM_LABEL }] }, 'gate').approved, true)
  assert.throws(() => explicitAnswer({ answers: [{ id: 'old', selected: [CONFIRM_LABEL] }] }, 'gate'), /未匹配/)
  assert.throws(() => explicitAnswer({ answers: [{ id: 'gate', selected: [CONFIRM_LABEL] }], actor: 'user' }, 'gate'))
})

test('drafts do not dispatch and unresolved requirements cannot reach native confirmation', async t => {
  const f = await controllerFixture(t)
  await f.controller.propose(f.root, { ...proposal(0), unresolvedQuestions: ['这则公告给谁看？'] }, signal)
  await assert.rejects(f.controller.confirm(f.root, f.revision(), signal), /未解决/)
  await assert.rejects(f.advance(), /Signal Gate/)
  assert.equal(f.questions.length, 0)
  assert.equal(f.calls.length, 0)
})

test('a stalled first requirement turn is journaled and auto-continued only once before any run exists', async t => {
  const f = await controllerFixture(t)
  const first = await f.controller.recordRootStall(f.root, {
    turn: 3, noProgressMs: 180000, faultInjected: true,
  })
  assert.equal(first.kind, 'auto-continue')
  assert.match(first.prompt, /Signal Gate 批准/)
  assert.match(first.prompt, /受控故障注入/)
  assert.equal(f.snapshot().availability, 'absent')
  assert.equal(f.snapshot().run, null)
  assert.equal(f.snapshot().preRunRecovery.status, 'recovering')
  assert.match(f.snapshot().preRunRecovery.reason, /受控故障注入/)
  assert.match((await f.controller.status(f.root)).hint, /自动恢复/)

  const second = await f.controller.recordRootStall(f.root, { turn: 4, noProgressMs: 120000 })
  assert.equal(second.kind, 'needs-attention')
  assert.equal(f.snapshot().preRunRecovery.status, 'needs-attention')
  assert.equal(f.snapshot().preRunRecovery.attempt, 2)
  const revision = f.snapshot().revision
  const repeated = await f.controller.recordRootStall(f.root, { turn: 5, noProgressMs: 120000 })
  assert.equal(repeated.incidentId, second.incidentId)
  assert.equal(f.snapshot().revision, revision, 'needs-attention cannot create a third incident')

  assert.equal(await f.controller.settleRootRecovery(
    f.root, second.incidentId, 'resumed', '用户通过新的原生输入明确继续。',
  ), true)
  assert.equal(f.snapshot().preRunRecovery, null)
})

test('only exact native root identity is eligible; model-supplied authority is rejected', async t => {
  const f = await controllerFixture(t)
  await assert.rejects(f.controller.propose({ id: f.root.id }, proposal(0), signal), /真实根 Agent/)
  await assert.rejects(f.controller.propose(f.root, { ...proposal(0), actor: { kind: 'user' }, confirmed: true }, signal))
  assert.equal(f.snapshot().revision, 0)
  await f.setup()
  assert.equal(f.questions.length, 1)
  assert.match(f.questions[0].detail, /需求确认 · 版本 1/)
  assert.match(f.questions[0].detail, /禁止 Shell/)
  const row = f.table.rows.get(f.root.id)
  const decision = row.events.find(event => event.data.name === 'gate/decided').data
  assert.equal(decision.actor.id, `native-question:${f.questions[0].id}`)
  assert.equal(decision.actor.kind, 'user')
  assert.deepEqual(decision.payload.decisionAudit, {
    authority: 'user',
    channel: 'native-question',
    operator: 'unverified',
    requestId: f.questions[0].id,
  })
  assert.deepEqual(f.snapshot().run.gates[0].decisionAudit, decision.payload.decisionAudit)
  assert.equal(f.calls.length, 0)
})

test('ambiguous native answer rejects the gate and no model assertion can start a child', async t => {
  const f = await controllerFixture(t, { ask: async (_, question) => ({ answers: [{ id: question.id, selected: [], custom: '我想再调整一下' }] }) })
  await f.setup()
  assert.equal(f.snapshot().run.gates[0].status, 'rejected')
  await assert.rejects(f.advance(), /Signal Gate/)
  assert.equal(f.calls.length, 0)
})

test('missing native provider closes the question without impersonating a user', async t => {
  const f = await controllerFixture(t, { ask: async () => { throw new Error('NO_PROVIDER') } })
  await f.controller.propose(f.root, proposal(0), signal)
  await assert.rejects(f.controller.confirm(f.root, f.revision(), signal), /NO_PROVIDER/)
  assert.equal(f.snapshot().run.gates[0].status, 'cancelled')
  const decision = f.table.rows.get(f.root.id).events.at(-1).data
  assert.equal(decision.actor.kind, 'system')
  await assert.rejects(f.advance(), /Signal Gate/)
})

test('requirement revision during a native question makes the old answer unusable', async t => {
  let respond
  const asked = Promise.withResolvers()
  const f = await controllerFixture(t, { ask: async (_, question) => {
    asked.resolve(question)
    return new Promise(resolve => { respond = resolve })
  } })
  await f.controller.propose(f.root, proposal(0), signal)
  const pending = f.controller.confirm(f.root, f.revision(), signal)
  const question = await asked.promise
  const rejected = assert.rejects(pending, /版本|改变/)
  await f.controller.propose(f.root, { ...proposal(f.snapshot().revision), goal: '修订后的目标' }, signal)
  respond({ answers: [{ id: question.id, selected: [CONFIRM_LABEL] }] })
  await rejected
  assert.equal(f.snapshot().run.gates[0].status, 'cancelled')
  await assert.rejects(f.advance(), /Signal Gate/)
})

test('revision CAS rejects duplicate dispatch even when two callers race', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  const args = f.revision()
  const results = await Promise.allSettled([f.controller.advance(f.root, args, signal), f.controller.advance(f.root, args, signal)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(f.calls.filter(item => item.operation === 'start').length, 1)
  await assert.rejects(f.controller.propose(f.root, proposal(f.snapshot().revision), signal), /不能覆盖/)
})

test('a failed Journal write cannot dispatch an Agent', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  const args = f.revision()
  f.table.put = async () => { throw new Error('disk unavailable') }
  await assert.rejects(f.controller.advance(f.root, args, signal), /reopen storage/)
  assert.equal(f.calls.length, 0)
})

test('failed native admission is a runtime interruption, never a business failure or completed work', async t => {
  const f = await controllerFixture(t, { start: async () => { throw new Error('provider rejected') } })
  await f.setup()
  await assert.rejects(f.advance(), /provider rejected/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.snapshot().run.tasks.find(task => task.taskId === 'author').status, 'blocked')
  assert.equal(f.snapshot().run.agents[0].status, 'interrupted')
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.cause, 'admission-failed')
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'stopped')
  assert.equal(f.snapshot().run.ledger.pass, 0)
})

test('root stall recovery is Journal-bound and resumes from the exact contract state', async t => {
  const f = await controllerFixture(t)
  await f.controller.propose(f.root, proposal(0), signal)
  let directive = await f.controller.recordRootStall(f.root, { turn: 2, noProgressMs: 180_000 })
  assert.equal(directive.kind, 'auto-continue')
  assert.equal(f.snapshot().run.recovery.status, 'recovering')
  assert.match(f.snapshot().run.recovery.resumeFrom, /需求|阶段/)

  assert.equal(await f.controller.settleRootRecovery(
    f.root, directive.incidentId, 'resumed', '自动恢复轮次正常结束',
  ), true)
  assert.equal(f.snapshot().run.recovery, null)
  await f.controller.confirm(f.root, f.revision(), signal)
  directive = await f.controller.recordRootStall(f.root, { turn: 3, noProgressMs: 180_000 })
  assert.equal(directive.kind, 'auto-continue')
  assert.match(directive.prompt, /workflow_status/)
  assert.match(directive.prompt, /不得重复已完成任务/)
  assert.equal(f.snapshot().run.recovery.status, 'recovering')
})

test('roles cannot choose verifier identity, call root tools or retain access after reporting', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  await f.advance()
  const child = f.child('author')
  assert.equal(f.controller.guard(child, 'workflow_packet'), undefined)
  for (const tool of ['write', 'read', 'shell', 'run_code', 'ask_user_question', 'workflow_confirm', 'workflow_advance', 'future_dangerous_tool']) assert.ok(f.controller.guard(child, tool))
  await assert.rejects(f.controller.report(child, reportQA(true), signal))
  await assert.rejects(f.controller.report({ id: child.id }, { role: 'engineer', text: '测试' }, signal), /无权/)
  await f.controller.report(child, { role: 'engineer', text: '测试功能已就绪' }, signal)
  assert.ok(f.controller.guard(child, 'workflow_packet'))
  await assert.rejects(f.controller.report(child, { role: 'engineer', text: '重复提交' }, signal), /关闭/)
  assert.equal(f.snapshot().run.ledger.pass, 0)
})

test('QA packet contains deliverable and approved contract, not engineer self-review or transcript', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  await f.author('测试功能已就绪')
  await f.advance()
  const child = f.child('acceptance')
  const packet = f.controller.packet(child)
  assert.equal(packet.deliverable.text, '测试功能已就绪')
  assert.equal(packet.role, 'acceptance_qa')
  assert.equal('transcript' in packet, false)
  assert.equal('evidence' in packet, false)
  assert.equal('rework' in packet, false)
  packet.deliverable.text = 'attempted mutation'
  assert.equal(f.controller.packet(child).deliverable.text, '测试功能已就绪')
  await assert.rejects(f.controller.report(child, { role: 'engineer', text: '越权改写' }, signal))
  await assert.rejects(f.controller.report(child, { role: 'acceptance_qa', results: [reportQA(true).results[0]] }, signal), /逐条覆盖/)
  await assert.rejects(f.controller.report(child, { role: 'acceptance_qa', results: [reportQA(true).results[0], reportQA(true).results[0]] }, signal), /逐条覆盖/)
  await assert.rejects(f.controller.report(child, { role: 'acceptance_qa', results: [{ ...reportQA(true).results[0], status: 'WAIVED' }, reportQA(true).results[1]] }, signal))
})

test('failure routes one bounded rework through the same identities and fresh acceptance', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  const authorId = await f.author('功能已就绪')
  const qaId = await f.qa(false)
  assert.equal(f.snapshot().run.ledger.fail, 1)
  assert.equal(f.snapshot().run.outcome, null)
  await f.controller.returnForRework(f.root, f.revision(), signal)
  assert.equal(f.snapshot().run.ledger.pass, 0)
  assert.equal(f.snapshot().run.ledger.pending, 2)
  assert.equal(await f.author('测试功能已就绪'), authorId)
  assert.equal(await f.qa(true), qaId)
  const result = await f.advance()
  assert.equal(result.snapshot.run.outcome, 'PASS')
  assert.equal(result.deliverable.version, 2)
  assert.equal(await readFile(result.deliverable.path, 'utf8'), '测试功能已就绪')
  assert.equal(f.calls.filter(item => item.operation === 'start').length, 2)
  assert.equal(f.calls.filter(item => item.operation === 'resume').length, 2)
  assert.ok(f.notices.every(item => item.snapshot.run.agents.some(agent => agent.status === 'idle')))
  assert.ok(f.table.rows.get(f.root.id).events.some(event => event.data.name === 'acceptance/recorded' && event.data.payload.result.status === 'FAIL'))
})

test('a second QA failure cannot trigger an unbounded retry or optimistic delivery', async t => {
  const f = await controllerFixture(t)
  await f.setup()
  await f.author('功能已就绪'); await f.qa(false)
  await f.controller.returnForRework(f.root, f.revision(), signal)
  await f.author('功能仍未含关键词'); await f.qa(false)
  await assert.rejects(f.controller.returnForRework(f.root, f.revision(), signal), /仅允许一次/)
  const next = await f.advance()
  assert.match(next.next, /已暂停/)
  assert.equal(f.snapshot().run.outcome, null)
})

test('plain Agent completion without a structured report is not verification', async t => {
  const f = await controllerFixture(t)
  await f.setup(); await f.advance()
  await f.settle(f.child('author'))
  assert.equal(f.snapshot().run.agents[0].status, 'interrupted')
  assert.equal(f.snapshot().run.ledger.pass, 0)
  assert.match((await f.advance()).next, /暂停/)
})

test('cancel revokes child capability before drain and does not delete saved history', async t => {
  const f = await controllerFixture(t)
  await f.setup(); await f.advance()
  const child = f.child('author')
  const stopping = f.controller.stop(f.root)
  assert.ok(f.controller.guard(child, 'workflow_report'))
  await stopping
  assert.equal(f.snapshot().run.outcome, 'CANCELLED')
  await assert.rejects(f.advance(), /已停止/)
  assert.equal(f.table.rows.size, 1)
  const last = f.table.rows.get(f.root.id).events.at(-1).data
  assert.equal(last.actor.kind, 'pm')
})

test('cold Host does not mistake persistent running records for current dispatch authority', async t => {
  const f = await controllerFixture(t)
  await f.setup(); await f.advance()
  await f.controller.close()
  const cold = new WorkflowTextController(f.journal, f.artifacts, f.driver)
  cold.bindRoot(f.root)
  t.after(() => cold.close())
  assert.equal((await cold.status(f.root)).recoveryRequired.length, 1)
  await assert.rejects(cold.advance(f.root, f.revision(), signal), /当前 Host/)
})

test('artifact paths are Host-derived and disk corruption cannot become accepted evidence', async t => {
  const f = await controllerFixture(t)
  const stored = await f.artifacts.put('not executable text')
  assert.match(stored.locator, /text-artifacts[\\/][a-f0-9]{64}\.txt$/)
  await assert.rejects(f.artifacts.read('../outside'), /digest/)
  await writeFile(stored.locator, 'tampered test artifact', 'utf8')
  await assert.rejects(f.artifacts.read(stored.digest), /digest mismatch/)
  await assert.rejects(f.artifacts.put('not executable text'), /digest mismatch/)
})
