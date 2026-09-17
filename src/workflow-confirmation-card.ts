/**
 * One deterministic confirmation-card information contract.
 *
 * Every native state-change confirmation (requirement understanding, execution
 * authorization, rule deactivation / overlap cleanup, workspace file rollback)
 * is produced from this single render path. The input is the Host's current
 * structured state plus one kind-specific adapter; the output carries the same
 * five required faces, a fixed run-independent audit pointer, an optional
 * extension list and a (revision, contract version, retained-snapshot) binding.
 *
 * A required field that is missing, blank, over-long or line-injected fails
 * closed instead of degrading to model-authored wording, and a first screen
 * that leaks a run, rule or evidence identifier is never shown.
 */

import { createHash } from 'node:crypto'
import type { WorkflowRunState } from './workflow-events.ts'
import { ROLLBACK_CANCEL_LABEL, ROLLBACK_CONFIRM_LABEL } from './workflow-ui-contract.ts'

export const CONFIRMATION_CARD_CONTRACT_VERSION = 'workflow-confirmation-card/1'

export const CONFIRMATION_CARD_KINDS = ['requirements', 'execution', 'rule-cleanup', 'rollback'] as const
export type ConfirmationCardKind = typeof CONFIRMATION_CARD_KINDS[number]

/** The five required faces. Identical for all four confirmation kinds. */
export const CONFIRMATION_REQUIRED_FIELDS = ['whyNow', 'changes', 'preserved', 'impactAndNext', 'auditPointer'] as const
export type ConfirmationFieldId = typeof CONFIRMATION_REQUIRED_FIELDS[number]

export const CONFIRMATION_FIELD_LABELS: Readonly<Record<ConfirmationFieldId, string>> = {
  whyNow: '为什么需要决定',
  changes: '确认后改变什么',
  preserved: '明确保持什么',
  impactAndNext: '影响范围与后续动作',
  auditPointer: '完整审计信息在哪里查看',
}

/**
 * Run-independent audit guidance. Deliberately free of run ids, rule ids,
 * contract text and evidence ids: the durable Journal stays the audit source.
 */
export const CONFIRMATION_AUDIT_POINTERS: Readonly<Record<ConfirmationCardKind, string>> = {
  requirements: '完整合同、确认记录与证据保存在“工作流 → 完整计划”与审计层。',
  execution: '完整合同、确认记录与证据保存在“工作流 → 完整计划”与审计层；要修改，请选择“去聊天里说”。',
  'rule-cleanup': '规则来源、采纳与停用历史仍会保留；完整依据可在工作流记录与审计层查看。',
  rollback: '文件检查点、确认记录与撤销结果保存在工作流记录与审计层。',
}

/** The existing semantics a confirmation must keep, as a structured snapshot. */
export const RETAINED_SEMANTICS_KEYS = ['permissionIsolation', 'gateSemantics', 'journalCompatibility', 'nativeInput'] as const
export type RetainedSemanticsKey = typeof RETAINED_SEMANTICS_KEYS[number]
export type RetainedSemantics = Readonly<Record<RetainedSemanticsKey, string>>

/** First-screen wording for the retained snapshot. */
export const RETAINED_SEMANTICS_STATEMENT = '权限隔离、门禁语义、Journal 兼容与原生输入方式均保持现状。'

export type ConfirmationCardErrorCode = 'CONFIRMATION_CARD_INCOMPLETE' | 'CONFIRMATION_CARD_STALE'

export class ConfirmationCardError extends Error {
  override name = 'ConfirmationCardError'

  constructor(readonly code: ConfirmationCardErrorCode, message: string) {
    super(message)
  }
}

function incomplete(reason: string, field?: ConfirmationFieldId): ConfirmationCardError {
  const subject = field === undefined ? '必填信息' : `必填项“${CONFIRMATION_FIELD_LABELS[field]}”`
  return new ConfirmationCardError('CONFIRMATION_CARD_INCOMPLETE', `确认卡${subject}${reason}；没有生成可供决定的卡片`)
}

function stale(reason: string): ConfirmationCardError {
  return new ConfirmationCardError('CONFIRMATION_CARD_STALE', reason)
}

const MAX_FIELD_LENGTH = 600
/** Bounded by the Host checkpoint cap (100 files), not by a shorter display cap. */
const MAX_IMPACT_ITEMS = 100
/** Host identifiers are opaque UUID/hex tokens; short prose never collides. */
const MIN_IDENTIFIER_LENGTH = 8

/** Field predicate: presence is not enough; blank, injected or oversized fails. */
function requiredText(value: unknown, field?: ConfirmationFieldId): string {
  if (typeof value !== 'string') throw incomplete('必须由 Host 结构化状态确定性生成', field)
  const text = value.replace(/\r\n?/gu, '\n').trim()
  if (text.length === 0) throw incomplete('为空或只有空白', field)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw incomplete('包含控制字符', field)
  if (/[\p{Cf}\p{Cs}\p{Co}]/u.test(text)) throw incomplete('包含不可见格式字符', field)
  if (text.length > MAX_FIELD_LENGTH) throw incomplete('过长，必须先由 Host 摘要', field)
  if (text.split('\n').some(line => line.startsWith('#'))) throw incomplete('包含标题注入', field)
  return text
}

function requiredImpact(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw incomplete('至少需要一条影响范围或后续动作', 'impactAndNext')
  if (value.length > MAX_IMPACT_ITEMS) throw incomplete('条目过多，必须先由 Host 摘要', 'impactAndNext')
  return value.map(item => {
    const text = requiredText(item, 'impactAndNext')
    return text.startsWith('- ') ? text : `- ${text}`
  })
}

function requiredOptions(value: unknown): readonly ConfirmationCardOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw incomplete('必须提供 1–4 个明确选项，且第一个是批准选项')
  }
  const labels = new Set<string>()
  return value.map(item => {
    const candidate = item as ConfirmationCardOption | undefined
    const label = requiredText(candidate?.label).replace(/\s+/gu, ' ')
    if (label.length > 80) throw incomplete('选项标签过长')
    if (labels.has(label)) throw incomplete(`选项标签重复：${label}`)
    labels.add(label)
    const description = requiredText(candidate?.description).replace(/\s+/gu, ' ')
    if (description.length > 200) throw incomplete('选项说明过长')
    return { label, description }
  })
}

/** Optional extension fields never block the required fail-closed decision. */
function optionalExtensions(value: unknown): readonly ConfirmationCardExtension[] {
  if (!Array.isArray(value)) return []
  const result: ConfirmationCardExtension[] = []
  for (const item of value) {
    const candidate = item as ConfirmationCardExtension | undefined
    const label = typeof candidate?.label === 'string' ? candidate.label.trim() : ''
    const text = typeof candidate?.value === 'string' ? candidate.value.replace(/\s+/gu, ' ').trim() : ''
    if (label.length === 0 || label.length > 80 || text.length === 0 || text.length > 200) continue
    result.push({ label, value: text })
  }
  return result
}

function requiredRetained(value: RetainedSemantics): RetainedSemantics {
  const entries = RETAINED_SEMANTICS_KEYS.map(key => [key, requiredText(value?.[key])] as const)
  return Object.fromEntries(entries) as unknown as RetainedSemantics
}

/** Canonical digest over the retained snapshot; fixed key order, never re-sorted. */
export function retainedSemanticsDigest(retained: RetainedSemantics): string {
  const canonical = RETAINED_SEMANTICS_KEYS.map(key => `${key}=${retained[key]}`)
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

/** Deterministic retained snapshot derived from the current committed records. */
export function retainedSnapshotFromState(state: WorkflowRunState): RetainedSemantics {
  const requirement = state.records['requirement:requirement']
  const acceptance = state.records['acceptance:acceptance']
  if (requirement?.kind !== 'requirement' || acceptance?.kind !== 'acceptance') {
    throw incomplete('缺少当前需求或验收记录，无法核对保留项')
  }
  return {
    permissionIsolation: `权限隔离与写入前缀声明：${String(requirement.data.permissionBoundaries.length)} 条 @requirement v${String(requirement.version)}`,
    gateSemantics: '门禁语义：授权只来自 DSH 原生问答通道的明确批准，模型转述不构成授权',
    journalCompatibility: `Journal 兼容：workflow/event v${String(state.schemaVersion)}，既有记录只追加不改写`,
    nativeInput: '原生输入方式：DSH 官方问答通道',
  }
}

/** Fixed retained snapshot for a decision that changes no run-scoped permission. */
export const CONTRACT_RETAINED_SEMANTICS: RetainedSemantics = Object.freeze({
  permissionIsolation: '权限隔离与写入前缀声明不变',
  gateSemantics: '门禁语义不变：授权仍只来自 DSH 原生问答通道',
  journalCompatibility: 'Journal 兼容不变：workflow/event v1',
  nativeInput: '原生输入方式不变：DSH 官方问答通道',
})

/** Retained snapshot of a rule-scoped decision: only later reuse may change. */
export function retainedSnapshotFromRule(rule: {
  readonly scope: 'project' | 'preset'
  readonly version: number
}): RetainedSemantics {
  const scope = rule.scope === 'project' ? '当前项目' : '同类工作流'
  return {
    ...CONTRACT_RETAINED_SEMANTICS,
    permissionIsolation: `权限隔离与写入前缀声明不变；只调整 1 条“${scope}”历史规则的后续复用（v${String(rule.version)}）`,
  }
}

/**
 * The Host decorates an applied historical rule inside a requirement snapshot as
 * `【已确认历史规则 <ruleId>@v<version> · <scope>】<statement>`. The identity belongs
 * to the durable record and the audit layer, never to the first screen: recorded
 * text is rewritten to a scope-only display form, and every identity the Host can
 * prove is recorded becomes a fail-closed guard input instead of silently leaking.
 */
const RULE_DECORATION = /【已确认历史规则([^】]*)】/gu

function ruleDecorationParts(inner: string): { readonly identity?: string; readonly scope?: string } {
  const [head = '', ...rest] = inner.split('·')
  const identity = head.trim().replace(/@v\d+$/u, '').trim()
  const scope = rest.join('·').trim()
  return { ...(identity.length === 0 ? {} : { identity }), ...(scope.length === 0 ? {} : { scope }) }
}

/** Rule identities recorded inside Host-decorated text. */
export function ruleIdentitiesInText(value: string): string[] {
  const identities: string[] = []
  for (const match of value.matchAll(RULE_DECORATION)) {
    const identity = ruleDecorationParts(match[1] ?? '').identity
    if (identity !== undefined) identities.push(identity)
  }
  return identities
}

/** Display form of recorded rule text: scope preserved, rule id and version dropped. */
export function displayRecordedRuleText(value: string): string {
  return value.replace(RULE_DECORATION, (_match, inner: string) => {
    const { scope } = ruleDecorationParts(inner)
    return scope === undefined ? '【已确认历史规则】' : `【已确认历史规则 · ${scope}】`
  })
}

/**
 * Every identity the Host can prove it recorded for this run: the run id, the
 * applied rules and their source runs, and the rule identities embedded in the
 * current requirement snapshot or run title. Adapters pass this to the renderer
 * so a leak fails closed instead of reaching the decision card.
 */
export function firstScreenIdentifiers(state: WorkflowRunState, extra: readonly string[] = []): string[] {
  const requirement = state.records['requirement:requirement']
  // Applied rules are folded into the requirement text; guard those identities too.
  const recorded = requirement?.kind === 'requirement'
    ? [
      requirement.data.goal, ...requirement.data.inScope, ...requirement.data.outOfScope,
      ...requirement.data.constraints, ...requirement.data.assumptions,
    ].flatMap(text => ruleIdentitiesInText(text))
    : []
  return [
    state.runId,
    ...state.appliedLearning.flatMap(item => [item.ruleId, item.sourceRunId]),
    ...recorded,
    ...ruleIdentitiesInText(state.created?.title ?? ''),
    ...extra,
  ]
}

export interface ConfirmationCardOption {
  readonly label: string
  readonly description: string
}

export interface ConfirmationCardExtension {
  readonly label: string
  readonly value: string
}

export interface ConfirmationCardBinding {
  readonly revision: number
  readonly contractVersion: string
  readonly retainedSnapshotDigest: string
}

export interface ConfirmationCard {
  readonly contractVersion: string
  readonly kind: ConfirmationCardKind
  /** First line of the card; the only heading line. */
  readonly headline: string
  readonly header: string
  readonly question: string
  readonly detail: string
  readonly whyNow: string
  readonly changes: string
  readonly preserved: string
  readonly impactAndNext: readonly string[]
  readonly auditPointer: string
  readonly extensions: readonly ConfirmationCardExtension[]
  readonly options: readonly ConfirmationCardOption[]
  readonly approveLabel: string
  readonly retained: RetainedSemantics
  readonly binding: ConfirmationCardBinding
}

/** What one kind adapter supplies; the renderer owns labels, checks and binding. */
export interface ConfirmationCardDraft {
  readonly kind: ConfirmationCardKind
  readonly revision: number
  readonly headline: string
  readonly header: string
  readonly question: string
  readonly whyNow: string
  readonly changes: string
  readonly preserved: string
  readonly impactAndNext: readonly string[]
  readonly options: readonly ConfirmationCardOption[]
  readonly retained: RetainedSemantics
  readonly extensions?: readonly ConfirmationCardExtension[]
  /** Identifiers that must never reach the first screen. */
  readonly forbiddenIdentifiers?: readonly string[]
}

function renderDetail(input: {
  readonly headline: string
  readonly whyNow: string
  readonly changes: string
  readonly preserved: string
  readonly impactAndNext: readonly string[]
  readonly auditPointer: string
  readonly extensions: readonly ConfirmationCardExtension[]
}): string {
  const changes = input.changes.includes('\n') ? input.changes : `> ${input.changes}`
  return [
    `## ${input.headline}`,
    `**${CONFIRMATION_FIELD_LABELS.whyNow}**\n${input.whyNow}`,
    `**${CONFIRMATION_FIELD_LABELS.changes}**\n${changes}`,
    `**${CONFIRMATION_FIELD_LABELS.preserved}**\n${input.preserved}`,
    `**${CONFIRMATION_FIELD_LABELS.impactAndNext}**\n${input.impactAndNext.join('\n')}`,
    ...(input.extensions.length ? [input.extensions.map(item => `- **${item.label}** ${item.value}`).join('\n')] : []),
    `**${CONFIRMATION_FIELD_LABELS.auditPointer}**\n${input.auditPointer}`,
  ].join('\n\n')
}

/** Deterministic post-conditions on the rendered first screen. */
function assertFirstScreen(input: {
  readonly headline: string
  readonly header: string
  readonly question: string
  readonly detail: string
  readonly options: readonly ConfirmationCardOption[]
  readonly forbidden: readonly string[]
}): void {
  if (input.detail.split('\n').filter(line => line.startsWith('#')).length !== 1) {
    throw incomplete('首屏必须只有一行标题')
  }
  for (const field of CONFIRMATION_REQUIRED_FIELDS) {
    if (!input.detail.includes(CONFIRMATION_FIELD_LABELS[field])) {
      throw incomplete(`首屏缺少字段“${CONFIRMATION_FIELD_LABELS[field]}”`, field)
    }
  }
  const surface = [
    input.headline, input.header, input.question, input.detail,
    ...input.options.flatMap(option => [option.label, option.description]),
  ].join('\n')
  const leaked = input.forbidden.filter(identifier => typeof identifier === 'string'
    && identifier.trim().length >= MIN_IDENTIFIER_LENGTH
    && surface.includes(identifier))
  if (leaked.length) {
    throw incomplete('首屏出现了运行标识、规则标识、证据或完整合同内容；请改为在工作流记录与审计层查看')
  }
}

/** The single render path for all four confirmation kinds. */
export function renderConfirmationCard(draft: ConfirmationCardDraft): ConfirmationCard {
  if (!CONFIRMATION_CARD_KINDS.includes(draft.kind)) throw incomplete(`类型不受支持：${String(draft.kind)}`)
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 0) throw stale('确认卡必须绑定一次已提交的 revision／合同版本')
  const auditPointer = CONFIRMATION_AUDIT_POINTERS[draft.kind]
  if (typeof auditPointer !== 'string' || auditPointer.trim().length === 0) {
    throw incomplete('缺少与单次运行无关的审计指引', 'auditPointer')
  }
  const headline = requiredText(draft.headline)
  const header = requiredText(draft.header)
  const question = requiredText(draft.question)
  const whyNow = requiredText(draft.whyNow, 'whyNow')
  const changes = requiredText(draft.changes, 'changes')
  const preserved = requiredText(draft.preserved, 'preserved')
  const impactAndNext = requiredImpact(draft.impactAndNext)
  const retained = requiredRetained(draft.retained)
  const options = requiredOptions(draft.options)
  const extensions = optionalExtensions(draft.extensions)
  const detail = renderDetail({ headline, whyNow, changes, preserved, impactAndNext, auditPointer, extensions })
  assertFirstScreen({
    headline, header, question, detail, options,
    forbidden: draft.forbiddenIdentifiers ?? [],
  })
  return {
    contractVersion: CONFIRMATION_CARD_CONTRACT_VERSION,
    kind: draft.kind,
    headline,
    header,
    question,
    detail,
    whyNow,
    changes,
    preserved,
    impactAndNext,
    auditPointer,
    extensions,
    options,
    approveLabel: options[0]!.label,
    retained,
    binding: {
      revision: draft.revision,
      contractVersion: CONFIRMATION_CARD_CONTRACT_VERSION,
      retainedSnapshotDigest: retainedSemanticsDigest(retained),
    },
  }
}

/** Attach the revision committed with the gate request to an already-validated card. */
export function bindConfirmationCard(card: ConfirmationCard, revision: number): ConfirmationCard {
  if (!Number.isSafeInteger(revision) || revision < 0) throw stale('确认卡必须绑定一次已提交的 revision／合同版本')
  return { ...card, binding: { ...card.binding, revision } }
}

/** Decision-time revalidation: a stale card never authorizes anything. */
export function assertConfirmationCardCurrent(card: ConfirmationCard, current: {
  readonly revision: number
  readonly retained: RetainedSemantics
}): void {
  if (card.contractVersion !== CONFIRMATION_CARD_CONTRACT_VERSION
    || card.binding.contractVersion !== CONFIRMATION_CARD_CONTRACT_VERSION) {
    throw stale('确认卡合同版本已过期；请重新发起确认')
  }
  if (card.binding.revision !== current.revision) {
    throw stale(`确认卡绑定的版本（${String(card.binding.revision)}）已过期（当前 ${String(current.revision)}）；授权不被采纳`)
  }
  if (card.binding.retainedSnapshotDigest !== retainedSemanticsDigest(requiredRetained(current.retained))) {
    throw stale('确认卡记录的保留项与当前结构化状态不一致；授权不被采纳')
  }
}

export interface RollbackConfirmationSource {
  readonly state: WorkflowRunState
  readonly revision: number
  readonly checkpointId: string
  readonly gateId: string
  readonly recovery?: readonly { readonly path: string; readonly status: 'untouched' | 'backed-up' | 'restored' }[]
  readonly files: readonly {
    readonly path: string
    readonly action: 'restore' | 'remove'
  }[]
}

/** File-rollback adapter: exact restore／remove list, no checkpoint id on the first screen. */
export function rollbackConfirmationCard(source: RollbackConfirmationSource): ConfirmationCard {
  if (source.files.length === 0) throw incomplete('撤销预览没有任何文件变化，不能要求用户确认')
  const restore = source.files.filter(file => file.action === 'restore').length
  const remove = source.files.length - restore
  return renderConfirmationCard({
    kind: 'rollback',
    revision: source.revision,
    retained: retainedSnapshotFromState(source.state),
    headline: source.recovery ? '继续撤销 · 核对中断后的文件状态' : '撤销确认 · 恢复本次实现前的文件状态',
    header: '撤销确认',
    question: source.recovery ? '是否按核对结果继续完成这次中断的撤销？' : '是否按以上预览撤销本次实现的文件变化？',
    whyNow: source.recovery ? '此前撤销中断，部分文件可能已恢复；本次重新核对并等待你的新确认，不沿用旧回答。已恢复项不重复执行；任何冲突都会保留现场并停止。'
      : '撤销不是静默自动触发的：活动运行必须先停止，并由你明确要求后才会展示最新检查点的恢复／删除清单。',
    changes: source.recovery ? `本次事务涉及 ${String(restore)} 个已有文件和 ${String(remove)} 个新增文件；已达到目标状态的条目只核对，不重复改动。`
      : `将恢复 ${String(restore)} 个已有文件，删除 ${String(remove)} 个本轮新增文件。`,
    preserved: `${RETAINED_SEMANTICS_STATEMENT}仅撤销受控写入记录的工作区文件内容；冻结脚本产生的网络、进程、缓存、数据库或其他外部副作用不在恢复范围内。`,
    impactAndNext: source.files.map(file => {
      const status = source.recovery?.find(item => item.path === file.path)?.status
      const observed = status === 'restored' ? '（已达到目标，不重复改动）' : status === 'backed-up' ? '（原文件在备份中，待恢复）' : status === 'untouched' ? '（尚未改动）' : ''
      return `- ${file.action === 'restore' ? '恢复原内容' : '删除本轮新增文件'}：${file.path}${observed}`
    }),
    options: [
      { label: ROLLBACK_CONFIRM_LABEL, description: '按记录恢复原文件并删除本轮新增文件；不处理外部副作用。' },
      { label: ROLLBACK_CANCEL_LABEL, description: '不修改当前文件，保留现状。' },
    ],
    forbiddenIdentifiers: [...firstScreenIdentifiers(source.state), source.checkpointId, source.gateId],
  })
}
