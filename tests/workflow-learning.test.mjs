import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  LearningRuleConflictError,
  applyWorkflowStoredEvent,
  collectActiveLearningRules,
  emptyWorkflowRunState,
  findLearningRuleOverlap,
  learningCommandSchema,
  learningDecisionComplete,
  learningRevocationPresentation,
  learningStatementIssues,
  matchLearningRules,
} from '../lib/index.js'
import { CONFIRM_LABEL, PILOT_BOUNDARIES } from '../lib/workflow-control.js'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'

const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀']
  .map(name => ({ name, purpose: name }))

async function delivered(t, ask) {
  const f = await controllerFixture(t, { ask })
  await f.setup()
  await f.author('测试公告已就绪')
  await f.qa(true)
  const delivery = await f.advance()
  return { ...f, delivery }
}

function learningAsk({ revoke = false } = {}) {
  return async (_, question) => {
    if (question.header === '需求确认') return { answers: [{ id: question.id, selected: [CONFIRM_LABEL] }] }
    if (question.question === '这条规则的内容和生效范围是否正确？') {
      const selected = question.options.find(option => option.label.includes('同类工作流')).label
      return { answers: [{ id: question.id, selected: [selected] }] }
    }
    if (question.header === '清理重叠规则' || question.header === '停用历史规则') {
      return { answers: [{ id: question.id, selected: [question.options[revoke ? 0 : 1].label] }] }
    }
    throw new Error(`unexpected question: ${question.header}`)
  }
}

function learningInput(f, overrides = {}) {
  const source = f.delivery.learningSources.find(item => item.verdict === 'pass')
  assert.ok(source)
  return {
    expectedRevision: f.snapshot().revision,
    items: [{
      ruleKey: 'announcement-quality',
      statement: '公告类交付必须保留一条可复核的独立验收证据。',
      actionKind: 'quality-requirement',
      risk: 'execution-affecting',
      trigger: { mode: 'exact', terms: ['公告'] },
      suggestedScope: 'preset',
      sourceEvidenceIds: [source.evidenceId],
      ...overrides,
    }],
  }
}

test('deposition uses one native decision and only accepted rules enter a later confirmation contract', async t => {
  const f = await delivered(t, learningAsk())
  assert.ok(f.delivery.learningSources.length > 0)
  const status = await f.controller.status(f.root)
  assert.deepEqual(
    f.delivery.learningSources.map(item => item.evidenceId).sort(),
    status.learning.sources.map(item => item.evidenceId).sort(),
  )
  const beforeQuestions = f.questions.length
  const learned = await f.controller.learn(f.root, learningInput(f), signal)
  assert.equal(f.questions.length, beforeQuestions + 1)
  assert.equal(learned.accepted.length, 1)
  const ruleId = learned.accepted[0].ruleId
  assert.equal(f.snapshot().run.learning.reviewed, true)
  assert.equal(f.snapshot().run.learning.candidates[0].status, 'accepted')
  assert.equal(f.snapshot().run.learning.candidates[0].scope, 'preset')
  assert.deepEqual(learned.decisionAudit, {
    authority: 'user', channel: 'native-question', operator: 'unverified',
    requestId: learned.decisionAudit.requestId,
  })
  assert.deepEqual(f.snapshot().run.learning.decisionAudit, learned.decisionAudit)

  await f.controller.propose(f.root, {
    ...proposal(f.snapshot().revision),
    title: '第二轮公告',
    goal: '生成第二轮测试公告',
  }, signal)
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  const requirement = state.records['requirement:requirement']
  assert.ok(requirement.data.constraints.some(item => item.includes(ruleId) && item.includes('独立验收证据')))
  assert.deepEqual(requirement.data.permissionBoundaries, [...PILOT_BOUNDARIES])
  assert.ok(Object.values(state.records).filter(item => item.kind === 'task').every(item => item.data.writeScopes.length === 0))
  assert.deepEqual(state.appliedLearning.map(item => item.status), ['applied'])
  assert.equal(state.appliedLearning[0].sourceRunId, learned.snapshot.history[0].runId)
})

test('the native learning decision stays compact while durable evidence remains outside the card', async t => {
  const ask = async (_, requested) => {
    const questions = Array.isArray(requested) ? requested : [requested]
    if (questions.length === 1 && questions[0].header === '需求确认') {
      return { answers: [{ id: questions[0].id, selected: [CONFIRM_LABEL] }] }
    }
    if (questions.every(question => question.question === '这条规则的内容和生效范围是否正确？')) {
      return { answers: questions.map(question => ({ id: question.id, selected: ['不采纳'] })) }
    }
    throw new Error(`unexpected question batch: ${questions.map(question => question.header).join(',')}`)
  }
  const f = await delivered(t, ask)
  const base = learningInput(f).items[0]
  const statements = [
    '公告必须保留完整动作和适用边界；完成后使用独立证据验证结果。',
    '发布说明不得包含未经确认的时间承诺；交付前逐项核对约束。',
    '复盘只沉淀可追溯的稳定规则；临时故障保留为本轮记录。',
  ]
  await f.controller.learn(f.root, {
    expectedRevision: f.snapshot().revision,
    items: [0, 1, 2].map(index => ({
      ...base,
      ruleKey: `compact-rule-${String(index + 1)}`,
      statement: statements[index],
      trigger: { mode: 'exact', terms: [`场景-${String(index + 1)}`] },
    })),
  }, signal)
  const questions = f.questions.slice(-3)
  assert.equal(questions.length, 3)
  for (const [index, question] of questions.entries()) {
    assert.equal(question.question, '这条规则的内容和生效范围是否正确？')
    assert.equal(question.header, '质量规则 · 1 条证据')
    assert.equal(question.multiSelect, false)
    assert.doesNotMatch(question.detail, /依据：|evidenceId/i)
    assert.match(question.detail, /^> .+[。！？；;!?]  \n> .+[。！？!?]$/)
    const displayedStatement = question.detail
      .split('\n')
      .map(line => line.replace(/^> /u, '').trimEnd())
      .join('')
    assert.equal(displayedStatement, statements[index], 'the decision card must preserve the exact statement punctuation')
    assert.doesNotMatch(question.detail, /→|可能复用|判断依据|PowerShell、\.ps1/)
    assert.ok(question.detail.length < 220, `decision card is too long: ${String(question.detail.length)}`)
    assert.deepEqual(question.options.map(option => option.label), ['同类工作流（推荐）', '内容有误，退回修改', '不采纳'])
    assert.ok(question.options.every(option => option.description.length <= 14))
  }
})

test('statement preflight catches mechanical defects and unsupported operator claims before a native decision', () => {
  assert.match(learningStatementIssues('代码审查不得声称已验证券字节级编码属性。').join('；'), /疑似误输入/)
  assert.match(learningStatementIssues('用户亲手点击后保存规则。').join('；'), /不能证明实际操作者/)
  assert.match(learningStatementIssues('缺少结束标点').join('；'), /必须以完整句号/)
  assert.deepEqual(learningStatementIssues('工程检查必须保留真实退出码。'), [])

  const invalid = learningCommandSchema.safeParse({
    expectedRevision: 1,
    items: [{
      ruleKey: 'bad-byte-copy',
      statement: '代码审查不得声称已验证券字节级编码属性。',
      actionKind: 'quality-requirement',
      risk: 'low',
      trigger: { mode: 'exact', terms: ['BOM'] },
      suggestedScope: 'project',
      sourceEvidenceIds: ['evidence-1'],
    }],
  })
  assert.equal(invalid.success, false)
})

test('the observed BOM restatement is detected as a cross-key semantic overlap', () => {
  const existing = {
    ruleId: 'learning-existing', version: 1, ruleKey: 'powershell-bom-preservation',
    statement: 'Windows PowerShell 5.1 执行含中文等非 ASCII 内容的 .ps1 时须保留真实 UTF-8 BOM；全部文本编辑结束后再写 BOM，并由冻结工程测试以原始字节断言 EF BB BF。',
    basis: 'verified', scope: 'project', actionKind: 'quality-requirement', risk: 'execution-affecting',
    trigger: { mode: 'exact', terms: ['PowerShell 5.1', '.ps1', '中文'] },
    sourceEvidenceIds: ['evidence-1'], sourceSummaryHash: 'a'.repeat(64), sourceRunId: 'source-run',
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'project-a',
  }
  const found = findLearningRuleOverlap([existing], {
    ruleKey: 'ps1-bom-restore-after-edit',
    statement: '用原生 edit 改写含中文的 .ps1 后，后端可能以无 BOM 的 UTF-8 重写文件；改动完成后必须在文件起始处补回真实 U+FEFF，并确认首 3 字节为 EF BB BF 再交给工程检查。',
    actionKind: 'quality-requirement',
    trigger: { mode: 'exact', terms: ['.ps1', 'BOM', 'UTF-8'] },
  })
  assert.equal(found?.rule.ruleId, existing.ruleId)
  assert.equal(found?.overlap.kind, 'semantic-overlap')
  assert.ok(found?.overlap.sharedTechnicalTerms.includes('.ps1'))
  assert.ok(found?.overlap.sharedTechnicalTerms.includes('bom'))
})

test('revocation presents the user-visible change before audit metadata', () => {
  const retained = {
    ruleId: 'learning-project', version: 1, ruleKey: 'powershell-bom-preservation',
    statement: 'Windows PowerShell 5.1 执行含中文的 .ps1 时必须保留 UTF-8 BOM，并以原始字节断言 EF BB BF。',
    basis: 'verified project evidence', scope: 'project', actionKind: 'quality-requirement', risk: 'execution-affecting',
    trigger: { mode: 'exact', terms: ['PowerShell 5.1', '.ps1', 'BOM'] },
    sourceEvidenceIds: ['evidence-project'], sourceSummaryHash: 'a'.repeat(64), sourceRunId: 'project-run',
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'project-a',
  }
  const target = {
    ...retained,
    ruleId: 'learning-preset', ruleKey: 'ps1-bom-copy', scope: 'preset', projectKey: undefined,
    statement: '编辑含中文的 .ps1 后必须补回 UTF-8 BOM，并确认 EF BB BF 再交给工程检查。',
    sourceEvidenceIds: ['evidence-preset'], sourceRunId: 'preset-run',
  }
  const card = learningRevocationPresentation(target, [target, retained])
  assert.equal(card.header, '清理重叠规则')
  assert.equal(card.confirmLabel, '停用上方规则')
  assert.equal(card.retainedRule?.ruleId, retained.ruleId)
  assert.match(card.question, /同类工作流.*当前项目/)
  assert.match(card.detail, /将停用｜同类工作流/)
  assert.match(card.detail, /继续保留｜当前项目/)
  assert.match(card.detail, /当前项目继续受保留规则约束/)
  assert.match(card.detail, /其他同类工作流不再自动继承/)
  assert.ok(card.detail.indexOf('将停用') < card.detail.indexOf('继续保留'))
  assert.doesNotMatch(card.detail, /learning-project|learning-preset|project-run|preset-run|evidence-/)
})

test('revocation without a related rule states the direct scope and preserved history', () => {
  const target = {
    ruleId: 'learning-only', version: 2, ruleKey: 'announcement-quality',
    statement: '公告必须保留一条可复核的独立验收证据。', basis: 'verified',
    scope: 'preset', actionKind: 'quality-requirement', risk: 'execution-affecting',
    trigger: { mode: 'exact', terms: ['公告'] }, sourceEvidenceIds: ['ev'],
    sourceSummaryHash: 'a'.repeat(64), sourceRunId: 'run', workflowProfile: 'workflow-text-pilot/1',
  }
  const card = learningRevocationPresentation(target, [target])
  assert.equal(card.header, '停用历史规则')
  assert.equal(card.confirmLabel, '停止后续复用')
  assert.equal(card.retainedRule, undefined)
  assert.match(card.question, /同类工作流/)
  assert.match(card.detail, /不会撤销已经完成的工作/)
  assert.match(card.detail, /来源、采纳与停用历史仍会保留/)
})

test('the rule-cleanup card uses the shared contract and fails closed on a stale version', async () => {
  const cards = await import('../lib/workflow-control.js')
  const rule = {
    ruleId: 'learning-12345678-1234-1234-1234-123456789012', version: 2, ruleKey: 'independent-engineering-check',
    statement: '工程变更必须由独立工程测试角色运行冻结检查。', basis: 'verified evidence',
    scope: 'project', actionKind: 'quality-requirement', risk: 'execution-affecting',
    trigger: { mode: 'always', terms: [] }, sourceEvidenceIds: ['evidence-1234567890'],
    sourceSummaryHash: 'a'.repeat(64), sourceRunId: 'run-1234567890',
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'project-key-1234567890',
  }
  const presentation = cards.learningRevocationPresentation(rule, [rule])
  for (const field of cards.CONFIRMATION_REQUIRED_FIELDS) {
    assert.ok(presentation.detail.includes(`**${cards.CONFIRMATION_FIELD_LABELS[field]}**`), `missing required face ${field}`)
  }
  assert.equal(presentation.card.kind, 'rule-cleanup')
  assert.equal(presentation.card.auditPointer, cards.CONFIRMATION_AUDIT_POINTERS['rule-cleanup'])
  assert.equal(presentation.card.binding.revision, rule.version)
  assert.equal(presentation.card.binding.contractVersion, cards.CONFIRMATION_CARD_CONTRACT_VERSION)
  assert.equal(presentation.card.approveLabel, presentation.confirmLabel)
  assert.deepEqual(presentation.card.options.map(option => option.label), [presentation.confirmLabel, presentation.cancelLabel])
  assert.doesNotMatch(presentation.detail, new RegExp(rule.ruleId))
  assert.doesNotMatch(presentation.detail, new RegExp(rule.ruleKey))

  assert.equal(cards.assertConfirmationCardCurrent(presentation.card, {
    revision: rule.version, retained: cards.retainedSnapshotFromRule(rule),
  }), undefined)
  assert.throws(() => cards.assertConfirmationCardCurrent(presentation.card, {
    revision: rule.version + 1, retained: cards.retainedSnapshotFromRule({ ...rule, version: rule.version + 1 }),
  }), /过期/)
  assert.throws(() => cards.assertConfirmationCardCurrent(presentation.card, {
    revision: rule.version, retained: cards.retainedSnapshotFromRule({ ...rule, scope: 'preset' }),
  }), /保留项/)
})

test('return-for-edit preserves other decisions and reopens only the corrected candidate', async t => {
  let learningRound = 0
  const ask = async (_, requested) => {
    const questions = Array.isArray(requested) ? requested : [requested]
    if (questions.length === 1 && questions[0].header === '需求确认') {
      return { answers: [{ id: questions[0].id, selected: [CONFIRM_LABEL] }] }
    }
    learningRound += 1
    return { answers: questions.map((question, index) => ({
      id: question.id,
      selected: [learningRound === 1 && index === 1
        ? '内容有误，退回修改'
        : question.options.find(option => option.label.includes('同类工作流')).label],
    })) }
  }
  const f = await delivered(t, ask)
  const base = learningInput(f).items[0]
  const before = f.snapshot().revision
  const returned = await f.controller.learn(f.root, {
    expectedRevision: before,
    items: [base, {
      ...base,
      ruleKey: 'announcement-time-claim',
      statement: '对外发布时间不得在未经确认时写成确定承诺。',
      trigger: { mode: 'exact', terms: ['发布时间'] },
    }],
  }, signal)
  assert.equal(returned.snapshot.revision, before + 2)
  assert.equal(returned.accepted.length, 1)
  assert.equal(returned.revisionRequired.length, 1)
  assert.equal(f.snapshot().run.learning.reviewed, true)
  assert.equal(f.snapshot().run.learning.decisionRecorded, false)
  assert.deepEqual(f.snapshot().run.learning.candidates.map(item => item.status), ['accepted', 'revision-required'])
  assert.equal(collectActiveLearningRules(f.journal.readAllRunStates()).length, 1)
  const status = await f.controller.status(f.root)
  assert.match(status.hint, /原生输入框/)

  const questionsBeforeRevision = f.questions.length
  const candidateId = returned.revisionRequired[0].candidateId
  const learned = await f.controller.reviseLearning(f.root, {
    expectedRevision: f.snapshot().revision,
    candidateId,
    statement: '对外发布说明中的时间承诺必须先取得明确确认。',
    reason: '原候选没有明确指出需要先确认时间承诺。',
  }, signal)
  assert.equal(learned.accepted.length, 1)
  assert.equal(f.questions.length, questionsBeforeRevision + 1, 'only the corrected candidate is asked again')
  assert.equal(f.snapshot().run.learning.decisionRecorded, true)
  assert.deepEqual(f.snapshot().run.learning.candidates.map(item => item.status), ['accepted', 'accepted'])
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(learningDecisionComplete(state), true)
  assert.deepEqual(state.learningRevisions, [{
    candidateId,
    previousStatement: '对外发布时间不得在未经确认时写成确定承诺。',
    statement: '对外发布说明中的时间承诺必须先取得明确确认。',
    reason: '原候选没有明确指出需要先确认时间承诺。',
    attempt: 1,
  }])
  assert.equal(state.learningDecision.acceptedIds.includes(returned.accepted[0].ruleId), true, 'the earlier acceptance remains saved')
})

test('an active rule cannot be resubmitted under another key before the decision card opens', async t => {
  const f = await delivered(t, learningAsk())
  const learned = await f.controller.learn(f.root, learningInput(f), signal)
  const ruleId = learned.accepted[0].ruleId
  await f.controller.propose(f.root, {
    ...proposal(f.snapshot().revision), title: '第二轮公告', goal: '生成第二轮公告',
  }, signal)
  await f.controller.confirm(f.root, f.revision(), signal)
  // The applied rule reaches the requirement text, but its identity stays in the
  // durable record and out of the first screen.
  const cardQuestion = f.questions.at(-1)
  assert.ok(cardQuestion.detail.includes('独立验收证据'), 'the applied rule text must stay visible')
  assert.doesNotMatch(cardQuestion.detail, new RegExp(ruleId))
  assert.doesNotMatch(cardQuestion.detail, /@v\d/u)
  const requirementRecord = f.journal.readRunState(f.root.id, f.snapshot().run.runId).records['requirement:requirement']
  assert.ok(requirementRecord.data.constraints.some(item => item.includes(ruleId) && item.includes('独立验收证据')))
  await f.author('第二轮测试公告')
  await f.qa(true)
  const delivery = await f.advance()
  const source = delivery.learningSources.find(item => item.verdict === 'pass')
  assert.ok(source)
  const beforeQuestions = f.questions.length
  await assert.rejects(f.controller.learn(f.root, {
    expectedRevision: f.snapshot().revision,
    items: [{
      ruleKey: 'announcement-quality-copy',
      statement: '公告类交付必须保留一条可复核的独立验收证据。',
      actionKind: 'quality-requirement', risk: 'execution-affecting',
      trigger: { mode: 'exact', terms: ['公告'] }, suggestedScope: 'preset',
      sourceEvidenceIds: [source.evidenceId],
    }],
  }, signal), /文字重复/)
  assert.equal(f.questions.length, beforeQuestions)
  assert.equal(f.snapshot().run.learning.reviewed, false)
})

test('current instructions can explicitly override a matched rule without deleting or widening it', async t => {
  const f = await delivered(t, learningAsk())
  const learned = await f.controller.learn(f.root, learningInput(f), signal)
  const ruleId = learned.accepted[0].ruleId
  await assert.rejects(f.controller.propose(f.root, {
    ...proposal(f.snapshot().revision), goal: '生成公告',
    learningOverrides: [{ ruleId: 'not-active', reason: '测试未知引用' }],
  }, signal), /只能覆盖.*活动规则/)
  await f.controller.propose(f.root, {
    ...proposal(f.snapshot().revision),
    goal: '生成公告，但本次已有更严格的人工验收安排',
    learningOverrides: [{ ruleId, reason: '本次使用用户刚刚给出的更严格验收安排' }],
  }, signal)
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(state.appliedLearning[0].status, 'overridden')
  assert.match(state.appliedLearning[0].reason, /当前草案明确覆盖/)
  assert.ok(!state.records['requirement:requirement'].data.constraints.some(item => item.includes(ruleId)))
})

test('a no-candidate review completes deposition without another user question', async t => {
  const f = await delivered(t, learningAsk())
  const beforeQuestions = f.questions.length
  await f.controller.learn(f.root, { expectedRevision: f.snapshot().revision, items: [] }, signal)
  assert.equal(f.questions.length, beforeQuestions)
  assert.equal(f.snapshot().run.learning.reviewed, true)
  assert.deepEqual(f.snapshot().run.learning.candidates, [])
  const projection = displayWorkflowState({ status: 'ready', snapshot: f.snapshot() }, [], stages)
  assert.equal(projection.stageDetails[6].label, '本轮无候选')
  assert.match(projection.completionNotice, /本轮无沉淀候选/)
  assert.equal(projection.learning.summary, '已检查本轮证据，没有生成长期候选。')
})

test('revocation requires a native user decision and prevents future matching while preserving history', async t => {
  const f = await delivered(t, learningAsk({ revoke: true }))
  const learned = await f.controller.learn(f.root, learningInput(f), signal)
  const ruleId = learned.accepted[0].ruleId
  const revoked = await f.controller.revokeLearning(f.root, {
    expectedRevision: f.snapshot().revision, ruleId,
  }, signal)
  assert.equal(revoked.revoked, true)
  const question = f.questions.at(-1)
  assert.equal(question.header, '停用历史规则')
  assert.equal(question.question, '是否停止在后续新任务中复用这条“同类工作流”规则？')
  assert.deepEqual(question.options.map(option => option.label), ['停止后续复用', '暂不更改'])
  assert.doesNotMatch(question.detail, new RegExp(ruleId))
  const sourceState = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(sourceState.learningDecision.acceptedIds[0], ruleId)
  assert.equal(sourceState.learningRevocations[0].ruleId, ruleId)
  const row = f.table.rows.get(f.root.id)
  assert.equal(row.events.at(-1).data.actor.kind, 'user')
  assert.deepEqual(collectActiveLearningRules(f.journal.readAllRunStates()), [])

  await f.controller.propose(f.root, { ...proposal(f.snapshot().revision), goal: '再次生成公告' }, signal)
  const nextState = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.deepEqual(nextState.appliedLearning, [])
})

function learnedState({ runId, ruleId, ruleKey, scope, projectKey, terms = [] }) {
  const state = emptyWorkflowRunState(runId)
  state.proposedLearning = [{
    id: ruleId, version: 1, ruleKey, statement: `${ruleKey} statement`, basis: 'evidence basis',
    proposedScope: scope, actionKind: 'planning-hint', risk: 'low',
    trigger: { mode: terms.length ? 'exact' : 'always', terms }, sourceEvidenceIds: ['ev'],
    sourceSummaryHash: 'a'.repeat(64), workflowProfile: 'workflow-project-pilot/1', projectKey,
  }]
  state.learningDecision = { acceptedIds: [ruleId], rejectedIds: [], acceptedScopes: [{ id: ruleId, scope }] }
  return state
}

test('retrieval hard-filters projects, matches exact terms, and fails closed on same-scope conflicts', () => {
  const projectA = learnedState({ runId: 'a', ruleId: 'rule-a', ruleKey: 'project-a', scope: 'project', projectKey: 'A' })
  const preset = learnedState({ runId: 'p', ruleId: 'rule-p', ruleKey: 'windows-script', scope: 'preset', projectKey: 'A', terms: ['PowerShell 5.1', '.ps1'] })
  assert.deepEqual(matchLearningRules([projectA, preset], {
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'B', proposalText: '普通 JavaScript 任务',
  }), [])
  assert.deepEqual(matchLearningRules([projectA, preset], {
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'A', proposalText: '普通 JavaScript 任务',
  }).map(item => item.ruleId), ['rule-a'])
  assert.deepEqual(matchLearningRules([projectA, preset], {
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'B', proposalText: '使用 PowerShell 5.1 生成 .ps1 文件',
  }).map(item => item.ruleId), ['rule-p'])

  const conflict = learnedState({ runId: 'c', ruleId: 'rule-c', ruleKey: 'windows-script', scope: 'preset', projectKey: 'C', terms: ['PowerShell 5.1', '.ps1'] })
  assert.throws(() => matchLearningRules([preset, conflict], {
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'B', proposalText: 'PowerShell 5.1 与 .ps1',
  }), error => error instanceof LearningRuleConflictError && error.code === 'RULE_CONFLICT')
})

test('learning replay requires evidence, a complete user partition, and one decision', () => {
  const runId = 'learning-replay'
  const base = emptyWorkflowRunState(runId)
  base.created = { presetId: 'workflow-agent-signal-lab', rootSessionId: 'root', title: 'learning' }
  base.outcome = { outcome: 'PASS', reason: 'done', ledger: { pass: 1, fail: 0, waived: 0, pending: 0, hardOutcome: 'PASS' } }
  base.currentStage = 'delivery'
  base.evidence = { ev: { evidenceId: 'ev', kind: 'verification', verdict: 'pass', summary: 'verified', producedBy: 'qa', artifactRefs: [] } }
  const sourceSummaryHash = createHash('sha256').update(JSON.stringify([
    { evidenceId: 'ev', kind: 'verification', verdict: 'pass', summary: 'verified', taskId: null },
  ]), 'utf8').digest('hex')
  const candidate = {
    id: 'rule-1', version: 1, ruleKey: 'verified-output', statement: 'retain verification', basis: 'ev: verified',
    proposedScope: 'preset', actionKind: 'quality-requirement', risk: 'low', trigger: { mode: 'always', terms: [] },
    sourceEvidenceIds: ['ev'], sourceSummaryHash, workflowProfile: 'workflow-text-pilot/1',
  }
  const stored = (seq, name, payload, actor = { kind: 'pm', id: 'pm' }) => ({
    type: 'workflow/event', seq, time: seq + 1,
    data: { version: 1, runId, eventId: `event-${seq}-${name}`, name, actor, payload },
  })
  const proposed = applyWorkflowStoredEvent(base, stored(0, 'learning/proposed', { items: [candidate] }))
  assert.throws(() => applyWorkflowStoredEvent(proposed, stored(1, 'learning/decided', {
    acceptedIds: [], rejectedIds: [], acceptedScopes: [],
  }, { kind: 'user', id: 'user' })), /accept or reject every proposed item/)
  assert.throws(() => applyWorkflowStoredEvent(proposed, stored(1, 'learning/decided', {
    acceptedIds: ['rule-1'], rejectedIds: [], acceptedScopes: [{ id: 'rule-1', scope: 'preset' }],
  })), /requires a user decision/)
  assert.throws(() => applyWorkflowStoredEvent(proposed, stored(1, 'learning/decided', {
    acceptedIds: ['rule-1'], rejectedIds: [], acceptedScopes: [{ id: 'rule-1', scope: 'preset' }],
    decisionAudit: { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: 'request-1' },
  }, { kind: 'user', id: 'native-question:another-request' })), /audit must match/)
  const decided = applyWorkflowStoredEvent(proposed, stored(1, 'learning/decided', {
    acceptedIds: ['rule-1'], rejectedIds: [], acceptedScopes: [{ id: 'rule-1', scope: 'preset' }],
    decisionAudit: { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: 'request-1' },
  }, { kind: 'user', id: 'native-question:request-1' }))
  assert.equal(decided.learningDecision.acceptedIds[0], 'rule-1')
  assert.equal(decided.learningDecision.decisionAudit.operator, 'unverified')
  assert.throws(() => applyWorkflowStoredEvent(decided, stored(2, 'learning/decided', {
    acceptedIds: ['rule-1'], rejectedIds: [], acceptedScopes: [{ id: 'rule-1', scope: 'preset' }],
  }, { kind: 'user', id: 'user' })), /one undecided proposal/)
})

test('learning replay persists a returned candidate, its revision audit, and a later one-item decision', () => {
  const runId = 'learning-revision-replay'
  const base = emptyWorkflowRunState(runId)
  base.created = { presetId: 'workflow-agent-signal-lab', rootSessionId: 'root', title: 'learning revision' }
  base.outcome = { outcome: 'PASS', reason: 'done', ledger: { pass: 1, fail: 0, waived: 0, pending: 0, hardOutcome: 'PASS' } }
  base.currentStage = 'delivery'
  base.evidence = { ev: { evidenceId: 'ev', kind: 'verification', verdict: 'pass', summary: 'verified', producedBy: 'qa', artifactRefs: [] } }
  const sourceSummaryHash = createHash('sha256').update(JSON.stringify([
    { evidenceId: 'ev', kind: 'verification', verdict: 'pass', summary: 'verified', taskId: null },
  ]), 'utf8').digest('hex')
  const candidate = {
    id: 'rule-revise', version: 1, ruleKey: 'verified-output', statement: '交付需要验证。', basis: 'ev: verified',
    proposedScope: 'preset', actionKind: 'quality-requirement', risk: 'low', trigger: { mode: 'always', terms: [] },
    sourceEvidenceIds: ['ev'], sourceSummaryHash, workflowProfile: 'workflow-text-pilot/1',
  }
  const stored = (seq, name, payload, actor = { kind: 'pm', id: 'pm' }) => ({
    type: 'workflow/event', seq, time: seq + 1,
    data: { version: 1, runId, eventId: `revision-event-${seq}-${name}`, name, actor, payload },
  })
  let state = applyWorkflowStoredEvent(base, stored(0, 'learning/proposed', { items: [candidate] }))
  state = applyWorkflowStoredEvent(state, stored(1, 'learning/decided', {
    acceptedIds: [], rejectedIds: [], revisionRequiredIds: ['rule-revise'], acceptedScopes: [],
    decisionAudit: { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: 'return-1' },
  }, { kind: 'user', id: 'native-question:return-1' }))
  assert.equal(learningDecisionComplete(state), false)
  state = applyWorkflowStoredEvent(state, stored(2, 'learning/revised', {
    candidateId: 'rule-revise', previousStatement: '交付需要验证。',
    statement: '交付必须保留一条可复核的独立验证证据。', reason: '补足可执行的验证口径。', attempt: 1,
  }))
  assert.equal(state.proposedLearning[0].statement, '交付必须保留一条可复核的独立验证证据。')
  state = applyWorkflowStoredEvent(state, stored(3, 'learning/decided', {
    acceptedIds: ['rule-revise'], rejectedIds: [], revisionRequiredIds: [],
    acceptedScopes: [{ id: 'rule-revise', scope: 'preset' }],
    decisionAudit: { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: 'accept-2' },
  }, { kind: 'user', id: 'native-question:accept-2' }))
  assert.equal(learningDecisionComplete(state), true)
  assert.deepEqual(state.learningDecision.revisionRequiredIds, [])
  assert.equal(state.learningRevisions[0].attempt, 1)
})
