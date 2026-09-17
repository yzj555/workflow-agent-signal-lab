import { z } from 'zod'
import type { AcceptanceBrief, RequirementSnapshot, TaskBrief, VersionRef, WorkflowRecord } from './workflow-contract.ts'
import { parseWorkflowRecord } from './workflow-contract.ts'
import type { WorkflowRunState } from './workflow-events.ts'
import { TEXT_PILOT } from './workflow-profiles.ts'
import { learningOverridesSchema } from './workflow-learning.ts'
import { REQUIREMENTS_CONFIRM_LABEL } from './workflow-ui-contract.ts'
import {
  RETAINED_SEMANTICS_STATEMENT,
  displayRecordedRuleText,
  firstScreenIdentifiers,
  renderConfirmationCard,
  retainedSnapshotFromState,
} from './workflow-confirmation-card.ts'
import type { ConfirmationCard } from './workflow-confirmation-card.ts'

export const WORKFLOW_PRESET_ID = 'workflow-agent-signal-lab'
export { TEXT_PILOT } from './workflow-profiles.ts'
export { REQUIREMENTS_CONFIRM_LABEL } from './workflow-ui-contract.ts'
export { ROLLBACK_CANCEL_LABEL, ROLLBACK_CONFIRM_LABEL } from './workflow-ui-contract.ts'
export const CONFIRM_LABEL = '确认此版本并允许执行'
export const REVISE_LABEL = '需要修改'
export const ROOT_TOOLS = ['workflow_status', 'workflow_budget', 'workflow_propose', 'workflow_confirm', 'workflow_advance', 'workflow_return', 'workflow_learn', 'workflow_learning_revoke', 'workflow_rollback', 'workflow_reconcile', 'workflow_stop', 'ask_user_question'] as const
export const CHILD_TOOLS = ['workflow_packet', 'workflow_report'] as const
export const PILOT_BOUNDARIES = [
  '仅生成和验收文本交付物；文本由插件保存在自己的产物目录，不写入项目工作区。',
  '禁止 Shell、项目文件读取或改写、网络、进程操作、额外委派和发布。',
  '内容 Agent 与独立验收 Agent 串行运行；验收只接收确认合同和交付文本，不接收实现者对话。',
  '允许验收失败后在同一确认范围内返工一次；再次失败暂停，不自动扩大范围或权限。',
] as const

const line = z.string().trim().min(1).max(2000)
const lines = z.array(line).max(20)
export const proposalSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  kind: z.literal('text-deliverable'),
  title: z.string().trim().min(1).max(100),
  goal: line,
  inScope: lines.min(1),
  outOfScope: lines,
  constraints: lines,
  assumptions: lines,
  unresolvedQuestions: lines,
  criteria: lines.min(1).max(10),
  learningOverrides: learningOverridesSchema.optional(),
})
export const revisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() })
export const rollbackSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  checkpointId: z.string().trim().min(1).max(200).optional(),
})
export const emptySchema = z.strictObject({})
export const authorReportSchema = z.strictObject({
  role: z.literal('engineer'),
  text: z.string().trim().min(1).max(32000),
})
export const qaReportSchema = z.strictObject({
  role: z.literal('acceptance_qa'),
  results: z.array(z.strictObject({
    criterionId: z.string().regex(/^AC-[1-9][0-9]*$/),
    status: z.enum(['PASS', 'FAIL']),
    observation: line,
  })).min(1).max(10),
})
export type TextProposal = z.infer<typeof proposalSchema>
export type PilotReport = z.infer<typeof authorReportSchema> | z.infer<typeof qaReportSchema>

export function ref(record: WorkflowRecord): VersionRef {
  return { kind: record.kind, recordId: record.recordId, version: record.version }
}

/** Controller supplies all identity, role, permission, and version fields. */
export function pilotRecords(proposal: TextProposal, runId: string, actor: string, previous?: WorkflowRunState): WorkflowRecord[] {
  const make = <K extends WorkflowRecord['kind']>(kind: K, recordId: string, data: unknown) => {
    const prior = previous?.records[`${kind}:${recordId}`]
    return parseWorkflowRecord({
      schemaVersion: 1, kind, recordId, runId, version: (prior?.version ?? 0) + 1,
      createdAt: Date.now(), createdBy: actor, data,
      ...(prior ? { supersedes: ref(prior) } : {}),
    })
  }
  const ids = proposal.criteria.map((_, i) => `AC-${i + 1}`)
  const requirement = make('requirement', 'requirement', {
    goal: proposal.goal, inScope: [...new Set(proposal.inScope)], outOfScope: [...new Set(proposal.outOfScope)],
    constraints: [...new Set(proposal.constraints)], assumptions: [...new Set(proposal.assumptions)],
    permissionBoundaries: [...PILOT_BOUNDARIES], acceptanceIds: ids,
    questions: proposal.unresolvedQuestions.map((question, i) => ({ id: `Q-${i + 1}`, question, material: true, status: 'open' })),
  })
  const acceptance = make('acceptance', 'acceptance', {
    criteria: proposal.criteria.map((statement, i) => ({ id: ids[i], statement, criticality: 'hard', verifier: 'acceptance_qa', evidenceRequired: ['针对当前交付文本逐条记录观察结果'] })),
    surface: '插件内文本交付物', setup: [], forbiddenKnowledge: ['实现 Agent 的对话及思考', '工作区源码', '实现者的自评结论'],
  })
  const task = (id: 'author' | 'acceptance') => make('task', id, {
    title: id === 'author' ? '生成确认范围内的交付文本' : '独立逐条验收交付文本',
    goal: proposal.goal, stage: id === 'author' ? 'implementation' : 'verification',
    role: id === 'author' ? 'engineer' : 'acceptance_qa', riskLevel: 'L0', requiresActionGate: false,
    lifecycle: 'continuable', contextDomains: id === 'author' ? ['C0', 'C2'] : ['C0', 'C3'],
    inScope: [...new Set(proposal.inScope)], outOfScope: [...new Set(proposal.outOfScope)],
    dependsOn: id === 'author' ? [] : ['author'], inputs: [ref(requirement), ref(acceptance)],
    allowedActions: id === 'author' ? ['读取分配包', '提交文本'] : ['读取分配包与交付文本', '提交逐条验收观察'],
    forbiddenActions: ['访问项目文件', 'Shell', '网络', '操作进程', '委派', '批准门禁'], writeScopes: [],
    acceptanceIds: ids, outputContract: { artifacts: id === 'author' ? ['text-deliverable'] : [], evidence: ['结构化报告'], reportSchema: TEXT_PILOT },
  })
  return [requirement, acceptance, task('author'), task('acceptance')]
}

export function pilotContract(state: WorkflowRunState): { requirement: RequirementSnapshot; acceptance: AcceptanceBrief; author: TaskBrief; qa: TaskBrief } {
  const requirement = state.records['requirement:requirement']
  const acceptance = state.records['acceptance:acceptance']
  const author = state.records['task:author']
  const qa = state.records['task:acceptance']
  if (state.created?.presetId !== WORKFLOW_PRESET_ID || requirement?.kind !== 'requirement' || acceptance?.kind !== 'acceptance'
    || author?.kind !== 'task' || qa?.kind !== 'task' || author.data.outputContract.reportSchema !== TEXT_PILOT
    || qa.data.outputContract.reportSchema !== TEXT_PILOT || Object.keys(state.tasks).length !== 2
    || author.data.role !== 'engineer' || qa.data.role !== 'acceptance_qa'
    || JSON.stringify(requirement.data.permissionBoundaries) !== JSON.stringify(PILOT_BOUNDARIES)) {
    throw new Error('此运行不是受支持的文本闭环版本；不可从旧实验记录推定执行权限')
  }
  return { requirement, acceptance, author, qa }
}

/** Text-layer requirement card: the same five required faces as every other kind. */
export function textRequirementConfirmationCard(state: WorkflowRunState, revision: number): ConfirmationCard {
  const { requirement, acceptance } = pilotContract(state)
  // Recorded rule decorations keep their identity in the snapshot; the card shows
  // only the scope-preserving display form.
  const list = (values: readonly string[]) => values.length
    ? values.map(displayRecordedRuleText).join('；')
    : '无'
  return renderConfirmationCard({
    kind: 'requirements',
    revision,
    retained: retainedSnapshotFromState(state),
    headline: `需求确认 · 版本 ${String(requirement.version)}`,
    header: '需求确认',
    question: '以上合并需求和执行边界是否准确？',
    whyNow: '需要你确认这份合并需求与执行边界；确认前不会有任何角色开始工作。',
    changes: '确认后：内容 Agent → 独立验收 Agent → 通过交付／失败返回；不启动项目文件或系统操作。',
    preserved: `${RETAINED_SEMANTICS_STATEMENT}${PILOT_BOUNDARIES.join('；')}`,
    impactAndNext: [
      `- **本次包含** ${list(requirement.data.inScope)}`,
      `- **不包含** ${list(requirement.data.outOfScope)}`,
      `- **约束** ${list(requirement.data.constraints)}`,
      `- **待确认的假设** ${list(requirement.data.assumptions)}`,
      `- **验收标准** ${list(acceptance.data.criteria.map(item => `${item.id}：${item.statement}`))}`,
    ],
    extensions: [{ label: '本次目标', value: displayRecordedRuleText(requirement.data.goal) }],
    options: [
      { label: CONFIRM_LABEL, description: '批准这个版本及一次范围内返工，不批准其他系统操作。' },
      { label: REVISE_LABEL, description: '返回原生对话补充或纠正，暂不执行。' },
    ],
    forbiddenIdentifiers: firstScreenIdentifiers(state),
  })
}

/** A model's assertion, a stale form, or an ambiguous custom answer is not approval. */
export function explicitAnswer(value: unknown, questionId: string, approvalLabel = CONFIRM_LABEL): { approved: boolean; reason: string } {
  const parsed = z.strictObject({ answers: z.array(z.strictObject({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })).length(1) }).parse(value)
  const answer = parsed.answers[0]!
  if (answer.id !== questionId) throw new Error('原生确认回答未匹配本次门禁')
  const custom = answer.custom?.trim()
  const approved = custom ? answer.selected.length === 0 && custom === approvalLabel
    : answer.selected.length === 1 && answer.selected[0] === approvalLabel
  return { approved, reason: custom || answer.selected.join('；') || '没有给出明确确认' }
}
