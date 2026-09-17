import { z } from 'zod'
import type { WorkflowRunState } from './workflow-events.ts'
import { WORKFLOW_EXECUTION_PROFILES } from './workflow-profiles.ts'
import type { PROJECT_PILOT, TEXT_PILOT } from './workflow-profiles.ts'
import {
  RETAINED_SEMANTICS_STATEMENT,
  renderConfirmationCard,
  retainedSnapshotFromRule,
} from './workflow-confirmation-card.ts'
import type { ConfirmationCard } from './workflow-confirmation-card.ts'

export const LEARNING_ACTION_KINDS = [
  'communication-preference',
  'planning-hint',
  'quality-requirement',
] as const
export const LEARNING_RISKS = ['low', 'execution-affecting'] as const
export const LEARNING_SCOPES = ['project', 'preset'] as const

const line = z.string().trim().min(1).max(2000)

const STATEMENT_PAIRS = [
  ['（', '）'], ['【', '】'], ['《', '》'], ['“', '”'], ['‘', '’'],
  ['(', ')'], ['[', ']'], ['{', '}'],
] as const

/**
 * Deterministic preflight for text defects the Host can prove without asking a
 * model to judge its own prose. Semantic correctness still belongs to the
 * native decision card, which offers an explicit return-for-edit path.
 */
export function learningStatementIssues(value: string): string[] {
  const issues: string[] = []
  if (/[\r\n]/u.test(value)) issues.push('候选规则必须是一段不换行的简短陈述')
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) issues.push('候选规则不能包含控制字符、不可见格式字符或非法代理字符')
  if (!/[。！？.!?]$/u.test(value.trim())) issues.push('候选规则必须以完整句号、问号或感叹号结束')
  for (const [open, close] of STATEMENT_PAIRS) {
    const opens = value.split(open).length - 1
    const closes = value.split(close).length - 1
    if (opens !== closes) issues.push(`候选规则的 ${open}${close} 必须成对出现`)
  }
  // This exact malformed phrase escaped the first live deposition. Keep the
  // lint narrow: a general Chinese spell-checker would create unverifiable
  // false positives, while the native “退回修改” path covers semantic typos.
  if (/[券卷劵]字节(?:级|编码|属性)/u.test(value)) issues.push('“券/卷/劵字节”疑似误输入；请核对是否应为“字节”')
  if (/(?:用户亲手|用户本人(?:点击|操作)|没有代理(?:操作)?|无代理操作)/u.test(value)) {
    issues.push('当前原生回答协议不能证明实际操作者，候选规则不得声称用户亲手操作或没有代理')
  }
  return [...new Set(issues)]
}

const learningStatement = z.string().trim().min(1).max(160).superRefine((value, context) => {
  for (const message of learningStatementIssues(value)) context.addIssue({ code: 'custom', message })
})
const ruleKey = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u, '规则键仅允许小写字母、数字以及单个 . _ - 分隔符')
const trigger = z.strictObject({
  mode: z.enum(['always', 'exact']),
  terms: z.array(z.string().trim().min(1).max(120)).max(8),
}).superRefine((value, context) => {
  if (value.mode === 'exact' && value.terms.length === 0) {
    context.addIssue({ code: 'custom', path: ['terms'], message: 'exact 触发必须至少包含一个词' })
  }
  if (value.mode === 'always' && value.terms.length !== 0) {
    context.addIssue({ code: 'custom', path: ['terms'], message: 'always 触发不能附带词项' })
  }
  const normalized = value.terms.map(normalizeLearningText)
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: 'custom', path: ['terms'], message: '触发词规范化后不能重复' })
  }
})

export const learningOverrideSchema = z.strictObject({
  ruleId: z.string().trim().min(1).max(256),
  reason: line,
})

export const learningOverridesSchema = z.array(learningOverrideSchema).max(10).superRefine((value, context) => {
  if (new Set(value.map(item => item.ruleId)).size !== value.length) {
    context.addIssue({ code: 'custom', message: '同一历史规则不能重复覆盖' })
  }
})

const learningItemSchema = z.strictObject({
  ruleKey,
  statement: learningStatement,
  actionKind: z.enum(LEARNING_ACTION_KINDS),
  risk: z.enum(LEARNING_RISKS),
  trigger,
  suggestedScope: z.enum(LEARNING_SCOPES),
  sourceEvidenceIds: z.array(z.string().trim().min(1).max(256)).min(1).max(12),
})

export const learningCommandSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  items: z.array(learningItemSchema).max(3),
}).superRefine((value, context) => {
  const keys = value.items.map(item => `${item.actionKind}:${item.ruleKey}`)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '同一批候选的动作类型与规则键不能重复' })
  }
  value.items.forEach((item, index) => {
    if (new Set(item.sourceEvidenceIds).size !== item.sourceEvidenceIds.length) {
      context.addIssue({ code: 'custom', path: ['items', index, 'sourceEvidenceIds'], message: '证据 ID 不能重复' })
    }
  })
  for (let left = 0; left < value.items.length; left += 1) {
    for (let right = left + 1; right < value.items.length; right += 1) {
      const overlap = compareLearningRuleDrafts(value.items[left]!, value.items[right]!)
      if (overlap?.kind === 'same-statement' || overlap?.kind === 'semantic-overlap') {
        context.addIssue({
          code: 'custom',
          path: ['items', right],
          message: `候选与本批第 ${String(left + 1)} 条${overlap.kind === 'same-statement' ? '文字重复' : '可能语义重叠'}；请合并或明确收窄`,
        })
      }
    }
  }
})

/**
 * A correction is supplied only after the user has returned one persisted
 * candidate for editing.  The original evidence, rule identity and trigger
 * remain bound by the Host; the native conversation supplies the corrected
 * statement and a durable explanation of what changed.
 */
export const learningRevisionCommandSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  candidateId: z.string().trim().min(1).max(256),
  statement: learningStatement,
  reason: line,
})

/** Keep the original proposal shape valid while allowing one-item revisions. */
export const learningToolCommandSchema = z.union([
  learningCommandSchema,
  learningRevisionCommandSchema,
])

export const learningRevokeSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  ruleId: z.string().trim().min(1).max(256),
})

export type LearningCommand = z.infer<typeof learningCommandSchema>
export type LearningRevisionCommand = z.infer<typeof learningRevisionCommandSchema>
export type LearningToolCommand = z.infer<typeof learningToolCommandSchema>
export type LearningOverride = z.infer<typeof learningOverrideSchema>
export type LearningActionKind = typeof LEARNING_ACTION_KINDS[number]
export type LearningScope = typeof LEARNING_SCOPES[number]
export type WorkflowExecutionProfile = typeof TEXT_PILOT | typeof PROJECT_PILOT

export interface ActiveLearningRule {
  readonly ruleId: string
  readonly version: number
  readonly ruleKey: string
  readonly statement: string
  readonly basis: string
  readonly scope: LearningScope
  readonly actionKind: LearningActionKind
  readonly risk: typeof LEARNING_RISKS[number]
  readonly trigger: { readonly mode: 'always' | 'exact'; readonly terms: readonly string[] }
  readonly sourceEvidenceIds: readonly string[]
  readonly sourceSummaryHash: string
  readonly sourceRunId: string
  readonly workflowProfile: WorkflowExecutionProfile
  readonly projectKey?: string
}

export interface LearningRuleDraft {
  readonly ruleKey: string
  readonly statement: string
  readonly actionKind: LearningActionKind
  readonly trigger: { readonly mode: 'always' | 'exact'; readonly terms: readonly string[] }
}

export interface LearningRuleOverlap {
  readonly kind: 'same-key' | 'same-statement' | 'semantic-overlap'
  readonly sharedTechnicalTerms: readonly string[]
}

export interface LearningRevocationPresentation {
  readonly header: '清理重叠规则' | '停用历史规则'
  readonly question: string
  readonly detail: string
  readonly confirmLabel: '停用上方规则' | '停止后续复用'
  readonly cancelLabel: '暂不更改'
  /** A still-active related rule shown as the retained side of the change. */
  readonly retainedRule?: ActiveLearningRule
  /** The same decision as structured confirmation-card fields plus its binding. */
  readonly card: ConfirmationCard
}

export class LearningRuleConflictError extends Error {
  override name = 'LearningRuleConflictError'
  readonly code = 'RULE_CONFLICT'
}

export function normalizeLearningText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

const TECHNICAL_STOP_WORDS = new Set([
  'agent', 'workflow', 'host', 'user', 'true', 'false', 'must', 'should', 'only', 'after', 'before',
])

function technicalTerms(value: string): Set<string> {
  const normalized = normalizeLearningText(value)
  const tokens = normalized.match(/u\+[0-9a-f]{2,6}|(?:[0-9a-f]{2}\s+){2,}[0-9a-f]{2}|\.[a-z][a-z0-9]{0,11}|[a-z][a-z0-9]*(?:[._+-][a-z0-9]+)+|[a-z][a-z0-9]{2,}/giu) ?? []
  return new Set(tokens.map(token => token.replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'))
    .filter(token => !TECHNICAL_STOP_WORDS.has(token)))
}

function semanticCharacters(value: string): string {
  return normalizeLearningText(value).replace(/[^\p{L}\p{N}]+/gu, '')
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>()
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2))
  return result
}

function dice(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  for (const value of left) if (right.has(value)) common += 1
  return (2 * common) / (left.size + right.size)
}

function triggersOverlap(left: LearningRuleDraft['trigger'], right: LearningRuleDraft['trigger']): boolean {
  if (left.mode === 'always' || right.mode === 'always') return true
  const rightTerms = new Set(right.terms.map(normalizeLearningText))
  return left.terms.some(term => rightTerms.has(normalizeLearningText(term)))
}

/**
 * Conservative deterministic overlap signal. It blocks only same-action rules
 * whose applicability intersects and whose wording is either identical,
 * strongly similar, or shares at least three distinctive technical anchors.
 */
export function compareLearningRuleDrafts(left: LearningRuleDraft, right: LearningRuleDraft): LearningRuleOverlap | undefined {
  if (left.actionKind !== right.actionKind) return undefined
  const leftTechnical = technicalTerms(`${left.statement} ${left.trigger.terms.join(' ')}`)
  const rightTechnical = technicalTerms(`${right.statement} ${right.trigger.terms.join(' ')}`)
  const sharedTechnicalTerms = [...leftTechnical].filter(term => rightTechnical.has(term)).sort()
  if (left.ruleKey === right.ruleKey) return { kind: 'same-key', sharedTechnicalTerms }
  if (normalizeLearningText(left.statement) === normalizeLearningText(right.statement)) {
    return { kind: 'same-statement', sharedTechnicalTerms }
  }
  if (!triggersOverlap(left.trigger, right.trigger)) return undefined
  const characterSimilarity = dice(bigrams(semanticCharacters(left.statement)), bigrams(semanticCharacters(right.statement)))
  const technicalRatio = sharedTechnicalTerms.length / Math.max(1, Math.min(leftTechnical.size, rightTechnical.size))
  if (characterSimilarity >= 0.58 || (sharedTechnicalTerms.length >= 3 && technicalRatio >= 0.45)) {
    return { kind: 'semantic-overlap', sharedTechnicalTerms }
  }
  return undefined
}

export function findLearningRuleOverlap(rules: readonly ActiveLearningRule[], candidate: LearningRuleDraft): {
  readonly rule: ActiveLearningRule
  readonly overlap: LearningRuleOverlap
} | undefined {
  for (const rule of rules) {
    const overlap = compareLearningRuleDrafts(rule, candidate)
    if (overlap) return { rule, overlap }
  }
  return undefined
}

function learningScopeLabel(scope: LearningScope): '当前项目' | '同类工作流' {
  return scope === 'project' ? '当前项目' : '同类工作流'
}

/**
 * Build the decision layer for one revocation without leaking audit metadata
 * into the first-read surface. The durable Journal remains the source for IDs,
 * versions, evidence and provenance.
 *
 * The card itself comes from the shared, deterministic confirmation-card
 * generator: same required faces, same run-independent audit pointer, and the
 * rule id／key／evidence stay outside the first screen.
 */
export function learningRevocationPresentation(
  target: ActiveLearningRule,
  activeRules: readonly ActiveLearningRule[],
): LearningRevocationPresentation {
  const retainedRule = findLearningRuleOverlap(
    activeRules.filter(rule => rule.ruleId !== target.ruleId),
    target,
  )?.rule
  const targetScope = learningScopeLabel(target.scope)
  const preserved = `${RETAINED_SEMANTICS_STATEMENT}不会撤销已经完成的工作；当前任务、文件和既有结果不会改变。`

  if (retainedRule === undefined) {
    const header = '停用历史规则' as const
    const confirmLabel = '停止后续复用' as const
    const cancelLabel = '暂不更改' as const
    const card = renderConfirmationCard({
      kind: 'rule-cleanup',
      revision: target.version,
      retained: retainedSnapshotFromRule(target),
      headline: header,
      header,
      question: `是否停止在后续新任务中复用这条“${targetScope}”规则？`,
      whyNow: `后续新任务仍会自动复用这条“${targetScope}”规则；是否继续复用需要你决定。`,
      changes: [`**将停用｜${targetScope}**`, `> ${target.statement}`].join('\n'),
      preserved,
      impactAndNext: [`- 这条规则不再进入新的${targetScope === '当前项目' ? '当前项目任务' : '同类工作流任务'}。`],
      options: [
        { label: confirmLabel, description: '停止后续复用，但保留完整历史。' },
        { label: cancelLabel, description: '本次不改变任何规则。' },
      ],
      forbiddenIdentifiers: ruleIdentifiers(target),
    })
    return { header, question: card.question, detail: card.detail, confirmLabel, cancelLabel, card }
  }

  const retainedScope = learningScopeLabel(retainedRule.scope)
  const scopeImpact = target.scope === 'preset' && retainedRule.scope === 'project'
    ? '当前项目继续受保留规则约束；其他同类工作流不再自动继承被停用规则。'
    : `保留规则继续按“${retainedScope}”作用域和原触发条件生效。`
  const question = targetScope === retainedScope
    ? '是否停用上方规则，并继续保留下方的相近规则？'
    : `是否只停用“${targetScope}”规则，并继续保留“${retainedScope}”规则？`
  const header = '清理重叠规则' as const
  const confirmLabel = '停用上方规则' as const
  const cancelLabel = '暂不更改' as const
  const card = renderConfirmationCard({
    kind: 'rule-cleanup',
    revision: target.version,
    retained: retainedSnapshotFromRule(target),
    headline: header,
    header,
    question,
    whyNow: '系统检测到两条规则约束同一类风险：本次只停用第一条，不修改第二条，被保留的那条仍然按原作用域生效。',
    changes: [
      `**将停用｜${targetScope}**`,
      `> ${target.statement}`,
      `**继续保留｜${retainedScope}**`,
      `> ${retainedRule.statement}`,
    ].join('\n'),
    preserved,
    impactAndNext: [`- ${scopeImpact}`],
    options: [
      { label: confirmLabel, description: '保留下方规则，停止重复复用。' },
      { label: cancelLabel, description: '本次不改变任何规则。' },
    ],
    forbiddenIdentifiers: [...ruleIdentifiers(target), ...ruleIdentifiers(retainedRule)],
  })
  return { header, question: card.question, detail: card.detail, confirmLabel, cancelLabel, retainedRule, card }
}

/** Rule identity, key, run and evidence ids never belong on the first screen. */
function ruleIdentifiers(rule: ActiveLearningRule): string[] {
  return [rule.ruleId, rule.ruleKey, rule.sourceRunId, ...rule.sourceEvidenceIds]
}

type Candidate = WorkflowRunState['proposedLearning'][number]
type RichCandidate = Candidate & Required<Pick<Candidate,
  'version' | 'ruleKey' | 'actionKind' | 'risk' | 'trigger' | 'sourceEvidenceIds'
  | 'sourceSummaryHash' | 'workflowProfile'>>

function richCandidate(candidate: Candidate): candidate is RichCandidate {
  return candidate.version !== undefined && candidate.ruleKey !== undefined
    && candidate.actionKind !== undefined && candidate.risk !== undefined
    && candidate.trigger !== undefined && candidate.sourceEvidenceIds !== undefined
    && candidate.sourceSummaryHash !== undefined && candidate.workflowProfile !== undefined
    && WORKFLOW_EXECUTION_PROFILES.includes(candidate.workflowProfile)
}

/** Rebuild the active rule set from immutable run events; rejected and revoked rules never enter it. */
export function collectActiveLearningRules(states: readonly WorkflowRunState[]): ActiveLearningRule[] {
  const revoked = new Set(states.flatMap(state => state.learningRevocations.map(item => item.ruleId)))
  const result: ActiveLearningRule[] = []
  for (const state of states) {
    const decision = state.learningDecision
    if (!decision) continue
    for (const candidate of state.proposedLearning) {
      if (!decision.acceptedIds.includes(candidate.id) || revoked.has(candidate.id) || !richCandidate(candidate)) continue
      const scope = decision.acceptedScopes?.find(item => item.id === candidate.id)?.scope
        ?? (candidate.proposedScope === 'run' ? undefined : candidate.proposedScope)
      if (scope === undefined || (scope === 'project' && candidate.projectKey === undefined)) continue
      result.push({
        ruleId: candidate.id,
        version: candidate.version,
        ruleKey: candidate.ruleKey,
        statement: candidate.statement,
        basis: candidate.basis,
        scope,
        actionKind: candidate.actionKind,
        risk: candidate.risk,
        trigger: candidate.trigger,
        sourceEvidenceIds: candidate.sourceEvidenceIds,
        sourceSummaryHash: candidate.sourceSummaryHash,
        sourceRunId: state.runId,
        workflowProfile: candidate.workflowProfile,
        ...(candidate.projectKey === undefined ? {} : { projectKey: candidate.projectKey }),
      })
    }
  }
  return result.sort((left, right) => left.ruleId.localeCompare(right.ruleId))
}

/** Apply hard scope filters before any trigger matching. */
export function learningRulesForContext(states: readonly WorkflowRunState[], context: {
  readonly workflowProfile: WorkflowExecutionProfile
  readonly projectKey?: string
}): ActiveLearningRule[] {
  return collectActiveLearningRules(states).filter(rule => rule.workflowProfile === context.workflowProfile
    && (rule.scope === 'preset' || (context.projectKey !== undefined && rule.projectKey === context.projectKey)))
}

function triggerMatches(rule: ActiveLearningRule, proposalText: string): boolean {
  if (rule.trigger.mode === 'always') return true
  const haystack = normalizeLearningText(proposalText)
  return rule.trigger.terms.every(term => haystack.includes(normalizeLearningText(term)))
}

/**
 * Deterministic v1 retrieval. Project rules override same-key preset rules;
 * competing rules at the same specificity fail closed instead of silently choosing.
 */
export function matchLearningRules(states: readonly WorkflowRunState[], context: {
  readonly workflowProfile: WorkflowExecutionProfile
  readonly projectKey?: string
  readonly proposalText: string
}): ActiveLearningRule[] {
  const grouped = new Map<string, ActiveLearningRule[]>()
  for (const rule of learningRulesForContext(states, context).filter(item => triggerMatches(item, context.proposalText))) {
    const key = `${rule.actionKind}:${rule.ruleKey}`
    grouped.set(key, [...(grouped.get(key) ?? []), rule])
  }
  const selected: ActiveLearningRule[] = []
  for (const [key, candidates] of grouped) {
    const project = candidates.filter(item => item.scope === 'project')
    const precise = project.length ? project : candidates.filter(item => item.scope === 'preset')
    if (precise.length !== 1) {
      throw new LearningRuleConflictError(`历史规则 ${key} 在同一作用域有 ${String(precise.length)} 个活动版本；已停止自动复用，请先撤销冲突规则`)
    }
    selected.push(precise[0]!)
  }
  return selected.sort((left, right) => `${left.actionKind}:${left.ruleKey}`.localeCompare(`${right.actionKind}:${right.ruleKey}`))
}

export function nextLearningVersion(states: readonly WorkflowRunState[], workflowProfile: WorkflowExecutionProfile,
  ruleKeyValue: string, actionKind: LearningActionKind): number {
  let version = 0
  for (const state of states) {
    for (const candidate of state.proposedLearning) {
      if (richCandidate(candidate) && candidate.workflowProfile === workflowProfile
        && candidate.ruleKey === ruleKeyValue && candidate.actionKind === actionKind) {
        version = Math.max(version, candidate.version)
      }
    }
  }
  return version + 1
}
