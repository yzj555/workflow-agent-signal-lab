import { isAbsolute, posix } from 'node:path'
import { z } from 'zod'
import type {
  AcceptanceBrief,
  DesignSnapshot,
  RequirementSnapshot,
  TaskBrief,
  VersionRef,
  WorkflowRecord,
} from './workflow-contract.ts'
import { currentTaskBriefs, parseWorkflowRecord } from './workflow-contract.ts'
import type { WorkflowRunState } from './workflow-events.ts'
import { CONFIRM_LABEL, REQUIREMENTS_CONFIRM_LABEL, WORKFLOW_PRESET_ID, ref } from './workflow-pilot-contract.ts'
import { PROJECT_PILOT } from './workflow-profiles.ts'
import { learningOverridesSchema } from './workflow-learning.ts'
import {
  RETAINED_SEMANTICS_STATEMENT,
  displayRecordedRuleText,
  firstScreenIdentifiers,
  renderConfirmationCard,
  retainedSnapshotFromState,
} from './workflow-confirmation-card.ts'
import type { ConfirmationCard } from './workflow-confirmation-card.ts'

export { PROJECT_PILOT } from './workflow-profiles.ts'
export const PROJECT_CHANGE_CLASSES = ['localized', 'cross-module', 'architecture'] as const
export type ProjectChangeClass = typeof PROJECT_CHANGE_CLASSES[number]

const line = z.string().trim().min(1).max(2000)
const lines = z.array(line).max(20)
const checkId = z.string().regex(/^(?:ENG|ACC)-[1-9][0-9]*$/)
const relativePath = z.string().trim().min(1).max(500).superRefine((value, context) => {
  try { normalizeProjectRelative(value, false) }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }) }
})
const checkSchema = z.strictObject({
  id: checkId,
  command: z.string().trim().min(1).max(500).refine(isSupportedL1Command, '只允许受支持的 L1 构建、静态检查或测试命令'),
  workdir: z.string().trim().min(1).max(500).superRefine((value, context) => {
    try { normalizeProjectRelative(value, true) }
    catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }) }
  }),
  purpose: line,
})
const projectCriterionSchema = z.strictObject({
  statement: line,
  checkIds: z.array(z.string().regex(/^ACC-[1-9][0-9]*$/)).min(1).max(8),
})

export const projectProposalSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  kind: z.literal('project-change'),
  title: z.string().trim().min(1).max(100),
  goal: line,
  changeClass: z.enum(PROJECT_CHANGE_CLASSES),
  inScope: lines.min(1),
  outOfScope: lines,
  constraints: lines,
  assumptions: lines,
  unresolvedQuestions: lines,
  writeScopes: z.array(relativePath).min(1).max(20),
  engineeringChecks: z.array(checkSchema.extend({ id: z.string().regex(/^ENG-[1-9][0-9]*$/) })).min(1).max(8),
  acceptanceChecks: z.array(checkSchema.extend({ id: z.string().regex(/^ACC-[1-9][0-9]*$/) })).min(1).max(8),
  criteria: z.array(projectCriterionSchema).min(1).max(10),
  learningOverrides: learningOverridesSchema.optional(),
}).superRefine((value, context) => {
  const scopes = value.writeScopes.map(scope => normalizeProjectRelative(scope, false))
  if (new Set(scopes.map(scope => scope.toLocaleLowerCase('en-US'))).size !== scopes.length) {
    context.addIssue({ code: 'custom', path: ['writeScopes'], message: '写入范围规范化后不能重复' })
  }
  for (const [name, checks] of [['engineeringChecks', value.engineeringChecks], ['acceptanceChecks', value.acceptanceChecks]] as const) {
    if (new Set(checks.map(check => check.id)).size !== checks.length) {
      context.addIssue({ code: 'custom', path: [name], message: '检查 ID 不能重复' })
    }
  }
  const known = new Set(value.acceptanceChecks.map(check => check.id))
  for (const [index, criterion] of value.criteria.entries()) {
    const missing = criterion.checkIds.filter(id => !known.has(id))
    if (missing.length) context.addIssue({ code: 'custom', path: ['criteria', index, 'checkIds'], message: `引用了不存在的黑盒检查：${missing.join('、')}` })
    if (new Set(criterion.checkIds).size !== criterion.checkIds.length) {
      context.addIssue({ code: 'custom', path: ['criteria', index, 'checkIds'], message: '同一验收标准不能重复引用检查' })
    }
  }
})

export type ProjectProposal = z.infer<typeof projectProposalSchema>
export type WorkflowCheck = ProjectProposal['engineeringChecks'][number]

export const projectArchitectReportSchema = z.strictObject({
  role: z.literal('architect'),
  summary: line,
  decisions: z.array(z.strictObject({ id: z.string().trim().min(1).max(80), decision: line, rationale: line })).min(1).max(20),
  affectedAreas: lines.min(1),
  interfaces: lines,
  rollback: lines.min(1),
})

export const projectEngineerReportSchema = z.strictObject({
  role: z.literal('engineer'),
  summary: line,
  changedFiles: z.array(relativePath).min(1).max(100),
  notes: lines,
})

export const projectTestReportSchema = z.strictObject({
  role: z.literal('test_engineer'),
  checks: z.array(z.strictObject({
    checkId: z.string().regex(/^ENG-[1-9][0-9]*$/),
    status: z.enum(['PASS', 'FAIL']),
    observation: line,
  })).min(1).max(8),
})

export const projectReviewReportSchema = z.strictObject({
  role: z.literal('code_reviewer'),
  status: z.enum(['PASS', 'FAIL']),
  summary: line,
  findings: z.array(z.strictObject({
    severity: z.enum(['blocking', 'advisory']),
    observation: line,
    file: relativePath.optional(),
  })).max(20),
})

export const projectQaReportSchema = z.strictObject({
  role: z.literal('acceptance_qa'),
  results: z.array(z.strictObject({
    criterionId: z.string().regex(/^AC-[1-9][0-9]*$/),
    status: z.enum(['PASS', 'FAIL']),
    checkIds: z.array(z.string().regex(/^ACC-[1-9][0-9]*$/)).min(1).max(8),
    observation: line,
  })).min(1).max(10),
})

export const projectReportSchema = z.discriminatedUnion('role', [
  projectArchitectReportSchema,
  projectEngineerReportSchema,
  projectTestReportSchema,
  projectReviewReportSchema,
  projectQaReportSchema,
])

export type ProjectReport = z.infer<typeof projectReportSchema>

const CHECK_PREFIX = 'workflow-check/1:'
const CRITERION_CHECK_PREFIX = 'workflow-check-id:'
const BLOCKED_SCOPE_SEGMENTS = new Set(['.git', '.dsh', 'node_modules'])

/** Normalize a user-confirmed workspace-relative scope without resolving it on the host. */
export function normalizeProjectRelative(value: string, allowRoot: boolean): string {
  if (value.includes('\0')) throw new Error('路径不能包含 NUL')
  const slash = value.trim().replaceAll('\\', '/')
  if (isAbsolute(value) || /^[a-z]:/iu.test(slash) || slash.startsWith('//')) throw new Error('路径必须相对于当前 DSH 工作区')
  const normalized = posix.normalize(slash).replace(/^\.\//u, '').replace(/\/$/u, '')
  if (normalized === '' || normalized === '.') {
    if (allowRoot) return '.'
    throw new Error('写入范围不能是整个工作区根目录')
  }
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('路径不能离开当前 DSH 工作区')
  const segments = normalized.split('/').map(segment => segment.toLocaleLowerCase('en-US'))
  if (segments.some(segment => BLOCKED_SCOPE_SEGMENTS.has(segment))) throw new Error('不能把 .git、.dsh 或 node_modules 放入工程任务范围')
  return normalized
}

/** A deliberately narrow command grammar for the first controlled project slice. */
export function isSupportedL1Command(value: string): boolean {
  const command = value.trim().replace(/\s+/gu, ' ')
  if (command.length === 0 || /[\r\n;&|><`]/u.test(command) || /\$\s*\(/u.test(command)) return false
  // A frozen check stays rooted in its separately validated workdir. Do not
  // let a command token smuggle an absolute or parent-relative target into it.
  if (/(?:^|[\s=])(?:[a-z]:[\\/]|\\\\|\/)/iu.test(command)
    || /(?:^|[\\/\s=])\.\.(?:[\\/]|$)/u.test(command)) return false
  if (/\b(?:install|uninstall|publish|deploy|serve|start|stop|kill|remove|delete|invoke-webrequest|curl|wget)\b/iu.test(command)) return false
  const token = String.raw`[\w.\\/,:=+@%-]+`
  return [
    new RegExp(String.raw`^(?:python|python3|py)(?:\.exe)? -m (?:unittest|pytest|compileall)(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^(?:pytest|ruff|mypy)(?:\.exe)?(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^(?:npm|npm\.cmd|pnpm|yarn) (?:test|run (?:test|typecheck|lint|build))(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^(?:node|node\.exe) --test(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^dotnet (?:test|build)(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^go (?:test|vet)(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^cargo (?:test|check|clippy|build)(?: ${token})*$`, 'iu'),
    new RegExp(String.raw`^git (?:status --short|diff --check|diff --name-only)$`, 'iu'),
  ].some(pattern => pattern.test(command))
}

export function encodeWorkflowCheck(check: WorkflowCheck): string {
  return CHECK_PREFIX + JSON.stringify({
    id: check.id,
    command: check.command.trim().replace(/\s+/gu, ' '),
    workdir: normalizeProjectRelative(check.workdir, true),
    purpose: check.purpose,
  })
}

export function decodeWorkflowChecks(actions: readonly string[]): WorkflowCheck[] {
  return actions.filter(action => action.startsWith(CHECK_PREFIX)).map(action =>
    checkSchema.parse(JSON.parse(action.slice(CHECK_PREFIX.length))))
}

export function criterionCheckIds(criterion: AcceptanceBrief['data']['criteria'][number]): string[] {
  return criterion.evidenceRequired
    .filter(item => item.startsWith(CRITERION_CHECK_PREFIX))
    .map(item => item.slice(CRITERION_CHECK_PREFIX.length))
}

export function projectBoundaries(proposal: ProjectProposal, workspaceRoot: string): string[] {
  const scopes = proposal.writeScopes.map(scope => normalizeProjectRelative(scope, false))
  return [
    `工作区根固定为：${workspaceRoot}。`,
    `仅允许写入已确认前缀：${scopes.join('、')}。`,
    '实现 Agent 可读工程上下文并在上述范围内使用原生 read/write/edit；协调、架构、测试、审查与验收角色均不能改写文件。',
    '实现 Agent 不获得 Shell 或工程检查能力；冻结的 L1 前台工程检查只由独立工程测试 Agent 执行，黑盒检查只由独立验收 Agent 执行。禁止后台运行、权限升级、安装依赖、显式联网命令、发布和进程控制。',
    '残余边界：DSH 的 Windows 沙箱约束文件写入，但不隔离读取、网络或进程可见性；工作流能禁止 Agent 替换命令，不能证明项目脚本内部绝不联网、启动子进程或产生其他非文件副作用。只应确认已知、本地、可重复的检查命令。',
    '工程测试与代码审查在实现后可并行；独立验收等待二者完成，模型侧只获得验收合同、冻结命令及其输出，不提供源码读取工具、源码正文或实现者对话；命令输出仍可能含项目生成的路径或堆栈。',
    '验证失败后只允许在相同合同和写入范围内返工一次；再次失败、扩大范围或提高风险必须暂停并重新取得用户决定。',
    '实现 Agent 第一次改写每个文件前，由 Host 保存内容检查点（单文件最多 16 MiB、单次实现最多 100 个文件且原始内容合计 64 MiB）；无法可靠留底时拒绝写入。',
    '文件撤销不是静默自动触发：活动运行需先停止，用户明确要求后展示最新检查点的恢复／删除清单，并在原生门禁再次确认；文件摘要冲突时整体拒绝覆盖。撤销只覆盖受控 write/edit 记录的工作区文件内容，不覆盖冻结脚本产生的网络、进程、缓存、数据库或其他外部副作用。',
  ]
}

function makeRecordFactory(runId: string, actor: string, previous?: WorkflowRunState) {
  return <K extends WorkflowRecord['kind']>(kind: K, recordId: string, data: unknown) => {
    const prior = previous?.records[`${kind}:${recordId}`]
    return parseWorkflowRecord({
      schemaVersion: 1,
      kind,
      recordId,
      runId,
      version: (prior?.version ?? 0) + 1,
      createdAt: Date.now(),
      createdBy: actor,
      data,
      ...(prior ? { supersedes: ref(prior) } : {}),
    })
  }
}

/** Compile the user-confirmed project proposal into a fixed role/DAG contract. */
export function projectRecords(proposal: ProjectProposal, runId: string, actor: string,
  workspaceRoot: string, previous?: WorkflowRunState): WorkflowRecord[] {
  const parsed = projectProposalSchema.parse(proposal)
  const make = makeRecordFactory(runId, actor, previous)
  const acceptanceIds = parsed.criteria.map((_, index) => `AC-${index + 1}`)
  const boundaries = projectBoundaries(parsed, workspaceRoot)
  const requirement = make('requirement', 'requirement', {
    goal: parsed.goal,
    inScope: [...new Set(parsed.inScope)],
    outOfScope: [...new Set(parsed.outOfScope)],
    constraints: [...new Set(parsed.constraints)],
    assumptions: [...new Set(parsed.assumptions)],
    permissionBoundaries: boundaries,
    questions: parsed.unresolvedQuestions.map((question, index) => ({ id: `Q-${index + 1}`, question, material: true, status: 'open' })),
    acceptanceIds,
  }) as RequirementSnapshot
  const acceptance = make('acceptance', 'acceptance', {
    criteria: parsed.criteria.map((criterion, index) => ({
      id: acceptanceIds[index],
      statement: criterion.statement,
      criticality: 'hard',
      verifier: 'acceptance_qa',
      evidenceRequired: criterion.checkIds.map(id => `${CRITERION_CHECK_PREFIX}${id}`),
    })),
    surface: '确认工作区中的工程交付物与冻结黑盒检查',
    setup: parsed.acceptanceChecks.map(encodeWorkflowCheck),
    forbiddenKnowledge: ['实现 Agent 的对话及思考', '工作区源码', '实现者自评', '代码审查 Agent 的内部对话'],
  }) as AcceptanceBrief
  const baseInputs = [ref(requirement), ref(acceptance)]
  const common = {
    goal: parsed.goal,
    inScope: [...new Set(parsed.inScope)],
    outOfScope: [...new Set(parsed.outOfScope)],
    inputs: baseInputs,
    requiresActionGate: false,
    lifecycle: 'continuable',
    outputContract: { artifacts: [], evidence: ['结构化角色报告'], reportSchema: PROJECT_PILOT },
  } as const
  const records: WorkflowRecord[] = [requirement, acceptance]
  const needsArchitecture = parsed.changeClass !== 'localized'
  if (needsArchitecture) records.push(make('task', 'architecture', {
    ...common,
    title: parsed.changeClass === 'architecture' ? '评估架构影响并形成设计约束' : '核对跨模块影响并形成执行方案',
    stage: 'planning', role: 'architect', riskLevel: 'L0', contextDomains: ['C0', 'C1'],
    dependsOn: [], allowedActions: ['读取工作区源码', '检索工程结构', '提交架构决策与回滚方案'],
    forbiddenActions: ['改写文件', 'Shell', '网络', '进程操作', '委派', '批准门禁'], writeScopes: [], acceptanceIds: [],
  }))
  records.push(make('task', 'implementation', {
    ...common,
    title: '在确认范围内实现工程变更',
    stage: 'implementation', role: 'engineer', riskLevel: 'L1', contextDomains: ['C0', 'C1', 'C2'],
    dependsOn: needsArchitecture ? ['architecture'] : [],
    allowedActions: ['读取与检索工作区源码', '在确认写入前缀内改写文件'],
    forbiddenActions: ['项目外写入', '任何 Shell 或工程检查（由独立工程测试 Agent 执行）', '后台命令', '权限升级', '网络', '外部进程操作', '委派', '批准门禁'],
    writeScopes: parsed.writeScopes.map(scope => normalizeProjectRelative(scope, false)), acceptanceIds,
    outputContract: { artifacts: ['workspace-file'], evidence: ['Host 核对的变更文件摘要'], reportSchema: PROJECT_PILOT },
  }))
  records.push(make('task', 'engineering-test', {
    ...common,
    title: '执行源码可见的工程验证',
    stage: 'verification', role: 'test_engineer', riskLevel: 'L1', contextDomains: ['C0', 'C2'],
    dependsOn: ['implementation'],
    allowedActions: ['读取与检索当前源码', ...parsed.engineeringChecks.map(encodeWorkflowCheck)],
    forbiddenActions: ['改写文件', '未冻结 Shell 命令', '后台命令', '权限升级', '网络', '外部进程操作', '委派', '批准门禁'],
    writeScopes: [], acceptanceIds: [],
  }))
  records.push(make('task', 'code-review', {
    ...common,
    title: '独立审查当前代码变更',
    stage: 'review', role: 'code_reviewer', riskLevel: 'L0', contextDomains: ['C0', 'C2'],
    dependsOn: ['implementation'],
    allowedActions: ['读取与检索当前源码', '提交阻塞项与建议项'],
    forbiddenActions: ['改写文件', 'Shell', '网络', '进程操作', '委派', '批准门禁'], writeScopes: [], acceptanceIds: [],
  }))
  records.push(make('task', 'acceptance', {
    ...common,
    title: '在模型侧源码隔离下执行独立黑盒验收',
    stage: 'review', role: 'acceptance_qa', riskLevel: 'L1', contextDomains: ['C0', 'C3'],
    dependsOn: ['engineering-test', 'code-review'],
    allowedActions: ['读取验收合同与交付摘要', ...parsed.acceptanceChecks.map(encodeWorkflowCheck)],
    forbiddenActions: ['读取或检索源码', '改写文件', '未冻结 Shell 命令', '后台命令', '权限升级', '网络', '外部进程操作', '委派', '批准门禁'],
    writeScopes: [], acceptanceIds,
  }))
  return records
}

export interface ProjectContract {
  readonly profile: typeof PROJECT_PILOT
  readonly requirement: RequirementSnapshot
  readonly acceptance: AcceptanceBrief
  readonly architecture?: TaskBrief
  readonly implementation: TaskBrief
  readonly verification: TaskBrief
  readonly review: TaskBrief
  readonly qa: TaskBrief
  readonly tasks: readonly TaskBrief[]
  readonly workspaceRoot: string
  readonly engineeringChecks: readonly WorkflowCheck[]
  readonly acceptanceChecks: readonly WorkflowCheck[]
}

/** Strictly recognize only the fixed project profile; mixed or guessed runs fail closed. */
export function projectContract(state: WorkflowRunState, expectedWorkspaceRoot?: string): ProjectContract {
  const requirement = state.records['requirement:requirement']
  const acceptance = state.records['acceptance:acceptance']
  const implementation = state.records['task:implementation']
  const verification = state.records['task:engineering-test']
  const review = state.records['task:code-review']
  const qa = state.records['task:acceptance']
  const architecture = state.records['task:architecture']
  const tasks = currentTaskBriefs(state.records)
  const rootBoundary = requirement?.kind === 'requirement'
    ? requirement.data.permissionBoundaries.find(item => item.startsWith('工作区根固定为：')) : undefined
  const workspaceRoot = rootBoundary?.slice('工作区根固定为：'.length).replace(/。$/u, '')
  if (state.created?.presetId !== WORKFLOW_PRESET_ID || requirement?.kind !== 'requirement' || acceptance?.kind !== 'acceptance'
    || implementation?.kind !== 'task' || verification?.kind !== 'task' || review?.kind !== 'task' || qa?.kind !== 'task'
    || workspaceRoot === undefined || (expectedWorkspaceRoot !== undefined && workspaceRoot !== expectedWorkspaceRoot)
    || tasks.some(task => task.data.outputContract.reportSchema !== PROJECT_PILOT)
    || tasks.length !== (architecture?.kind === 'task' ? 5 : 4)
    || implementation.data.role !== 'engineer' || implementation.data.stage !== 'implementation'
    || verification.data.role !== 'test_engineer' || verification.data.stage !== 'verification'
    || review.data.role !== 'code_reviewer' || review.data.stage !== 'review'
    || qa.data.role !== 'acceptance_qa' || qa.data.stage !== 'review'
    || JSON.stringify(verification.data.dependsOn) !== JSON.stringify(['implementation'])
    || JSON.stringify(review.data.dependsOn) !== JSON.stringify(['implementation'])
    || JSON.stringify(qa.data.dependsOn) !== JSON.stringify(['engineering-test', 'code-review'])
    || (architecture?.kind === 'task' && (architecture.data.role !== 'architect' || architecture.data.stage !== 'planning'
      || JSON.stringify(implementation.data.dependsOn) !== JSON.stringify(['architecture'])))
    || (architecture?.kind !== 'task' && implementation.data.dependsOn.length !== 0)) {
    throw new Error('此运行不是受支持的工程闭环版本；不可从普通任务或旧记录推定项目执行权限')
  }
  const engineeringChecks = decodeWorkflowChecks(verification.data.allowedActions)
  const acceptanceChecks = decodeWorkflowChecks(qa.data.allowedActions)
  if (!engineeringChecks.length || !acceptanceChecks.length
    || acceptance.data.criteria.some(criterion => {
      const ids = criterionCheckIds(criterion)
      return !ids.length || ids.some(id => !acceptanceChecks.some(check => check.id === id))
    })) throw new Error('工程闭环的冻结检查与验收标准不完整')
  return {
    profile: PROJECT_PILOT,
    requirement,
    acceptance,
    ...(architecture?.kind === 'task' ? { architecture } : {}),
    implementation,
    verification,
    review,
    qa,
    tasks,
    workspaceRoot,
    engineeringChecks,
    acceptanceChecks,
  }
}

function compactDecisionText(value: string, maxLength = 140): string {
  const normalized = value.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const window = normalized.slice(0, maxLength)
  const boundary = Math.max(...['。', '！', '？', '；'].map(mark => window.lastIndexOf(mark)))
  return boundary >= Math.min(48, Math.floor(maxLength / 2))
    ? window.slice(0, boundary + 1)
    : `${window.slice(0, maxLength - 1).trimEnd()}…`
}

function markdownInline(value: string, maxLength?: number): string {
  return compactDecisionText(value, maxLength).replace(/([\\`*_{}\[\]<>#|])/gu, '\\$1')
}

function inlineCode(value: string): string {
  const normalized = value.replace(/[\r\n]+/gu, ' ').trim()
  const longestTicks = Math.max(0, ...Array.from(normalized.matchAll(/`+/gu), match => match[0].length))
  const fence = '`'.repeat(longestTicks + 1)
  const padding = normalized.startsWith('`') || normalized.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${normalized}${padding}${fence}`
}

function checkGrant(checks: readonly WorkflowCheck[]): string {
  return checks.map(check => `${inlineCode(check.command)}${check.workdir === '.' ? '' : `（目录 ${inlineCode(check.workdir)}）`}`).join(' · ')
}

function changeDecisionSummary(contract: ProjectContract): string {
  const raw = contract.requirement.data.inScope[0] ?? contract.requirement.data.goal
  // Same record／first-screen split as summarizedItems: a recorded rule decoration
  // shows its scope without leaking the rule identity.
  const source = displayRecordedRuleText(raw)
  const path = source.match(/(?:[\w.-]+[\\/])+[\w.-]+/u)?.[0]?.replaceAll('\\', '/')
  const quoted = source.match(/[「“]([^」”]{1,80})[」”]/u)?.[1]
  if (path !== undefined && quoted !== undefined) {
    const verb = /输出|打印/iu.test(source) ? '输出' : /显示/iu.test(source) ? '显示' : '使用'
    return `${inlineCode(path)}：${verb}「${markdownInline(quoted, 56)}」`
  }
  return markdownInline(source, 78)
}

function summarizedItems(values: readonly string[], maxItems = 2, maxLength = 68): string {
  if (!values.length) return '无'
  // Recorded rule decorations keep their identity in the snapshot; the decision
  // card shows only the scope-preserving display form.
  const shown = values.slice(0, maxItems).map(value => markdownInline(displayRecordedRuleText(value), maxLength))
  return `${shown.join('；')}${values.length > shown.length ? `；另 ${values.length - shown.length} 项见完整计划` : ''}`
}

/**
 * Display the applied rule's own recorded statement. No task name, rule wording
 * or rule id is hardcoded here: the statement is run-time data from the Journal.
 */
function learningSummary(state: WorkflowRunState): string | undefined {
  if (!state.appliedLearning.length) return undefined
  const shown = state.appliedLearning.slice(0, 2).map(item => {
    const action = item.status === 'overridden' ? '本次覆盖' : '已带入'
    const scope = item.scope === 'project' ? '当前项目' : '同类工作流'
    return `${action}“${markdownInline(item.statement, 46)}”（${scope}）`
  })
  return `${shown.join('；')}${state.appliedLearning.length > shown.length ? `；另 ${state.appliedLearning.length - shown.length} 条见记录` : ''}`
}

function materialExecutionNote(contract: ProjectContract): string | undefined {
  const combined = [
    ...contract.requirement.data.assumptions,
    ...contract.acceptanceChecks.map(check => check.purpose),
    ...contract.acceptance.data.criteria.map(criterion => criterion.statement),
  ].join(' ')
  const effects = [
    /监听|端口占用|哑进程/iu.test(combined) ? '短暂启动验收监听进程' : undefined,
    /GUI|窗口/iu.test(combined) ? '短暂显示 GUI 窗口' : undefined,
    /结束后|随后清理|立即清理|退出后/iu.test(combined) ? '结束后清理' : undefined,
  ].filter((item): item is string => item !== undefined)
  if (effects.length) return effects.join('、')
  const signals: readonly (readonly [RegExp, number])[] = [
    [/副作用/iu, 12], [/GUI|窗口/iu, 6], [/监听|端口占用|哑进程/iu, 5],
    [/进程/iu, 2], [/网络|缓存|数据库/iu, 1],
  ]
  const score = (value: string) => signals.reduce((total, [pattern, weight]) => total + (pattern.test(value) ? weight : 0), 0)
  const noteworthy = contract.requirement.data.assumptions
    .map((value, index) => ({ value, index, score: score(value) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.value
  return noteworthy === undefined ? undefined : markdownInline(displayRecordedRuleText(noteworthy), 68)
}

/**
 * First gate for a layered project: approve understanding and read-only planning,
 * never implementation. Rendered by the shared confirmation-card generator.
 */
export function projectRequirementConfirmationCard(state: WorkflowRunState, expectedWorkspaceRoot: string,
  revision: number): ConfirmationCard {
  const contract = projectContract(state, expectedWorkspaceRoot)
  if (contract.architecture === undefined) throw new Error('局部变更不需要单独的只读规划确认')
  const requirement = contract.requirement.data
  const criteria = contract.acceptance.data.criteria
  const title = markdownInline(displayRecordedRuleText(state.created?.title ?? requirement.goal), 82)
  const learning = learningSummary(state)
  const impactAndNext = [
    `- **这次包含** ${summarizedItems(requirement.inScope)}`,
    `- **明确不做** ${summarizedItems(requirement.outOfScope)}`,
    ...(requirement.constraints.length
      ? [`- **关键约束** ${summarizedItems(requirement.constraints)}`]
      : []),
    `- **完成口径** ${String(criteria.length)} 项硬标准；${markdownInline(criteria[0]?.statement ?? '全部标准均需独立验收', 72)}`,
    ...(requirement.assumptions.length
      ? [`- **当前假设** ${summarizedItems(requirement.assumptions)}`]
      : []),
    ...(learning === undefined ? [] : [`- **历史规则** ${learning}`]),
  ]
  return renderConfirmationCard({
    kind: 'requirements',
    revision,
    retained: retainedSnapshotFromState(state),
    headline: `先确认理解 · ${title}`,
    header: '需求理解',
    question: '当前目标、范围和成功条件是否理解正确，并可开始只读方案评估？',
    whyNow: '这是分层执行的第一道门禁：需要你先确认需求理解，之后才允许一次只读方案评估；执行授权仍会单独再问一次。',
    changes: '确认后只启动只读方案 Agent，不会写文件或运行检查命令。',
    preserved: `${RETAINED_SEMANTICS_STATEMENT}本次不批准任何文件写入、检查命令或系统级操作。`,
    impactAndNext,
    extensions: [{ label: '本次需求目标', value: markdownInline(displayRecordedRuleText(requirement.goal), 112) }],
    options: [{
      label: REQUIREMENTS_CONFIRM_LABEL,
      description: '只确认当前需求理解，并允许一个只读方案 Agent 分析；不批准文件写入或检查命令。',
    }],
    forbiddenIdentifiers: firstScreenIdentifiers(state),
  })
}

/** A decision summary for the native plan-review card; the full contract stays in durable records. */
export function projectExecutionConfirmationCard(state: WorkflowRunState, expectedWorkspaceRoot: string,
  revision: number): ConfirmationCard {
  const contract = projectContract(state, expectedWorkspaceRoot)
  const title = markdownInline(displayRecordedRuleText(state.created?.title ?? contract.requirement.data.goal), 86)
  const change = changeDecisionSummary(contract)
  const scopes = contract.implementation.data.writeScopes.map(inlineCode).join(' · ')
  const learning = learningSummary(state)
  const note = materialExecutionNote(contract)
  const design = state.records['design:design']
  const flow = `${contract.architecture ? '只读方案 → ' : ''}实现 → 工程测试 ∥ 代码审查 → 独立验收`
  const criteria = contract.acceptance.data.criteria
  const impactAndNext = [
    ...(design?.kind === 'design'
      ? [`- **方案** ${markdownInline(design.data.summary, 74)}（${String(design.data.decisions.length)} 项决策 · ${String(design.data.affectedAreas.length)} 个影响区域 · ${String(design.data.rollback.length)} 步回滚）`]
      : []),
    `- **范围** 仅可写 ${scopes}；范围外写入、未列命令和系统级操作均不授权。`,
    `- **检查 · ${String(criteria.length)} 项硬标准** 工程 ${checkGrant(contract.engineeringChecks)}；黑盒 ${checkGrant(contract.acceptanceChecks)}`,
    `- **路径** ${flow}；失败仅同范围返工 1 次。`,
    ...(learning === undefined ? [] : [`- **历史规则** ${learning}`]),
    ...(note === undefined ? [] : [`- **受控副作用** ${note}`]),
  ]
  return renderConfirmationCard({
    kind: 'execution',
    revision,
    retained: retainedSnapshotFromState(state),
    headline: `${state.risk?.level ?? 'L1'} · ${contract.architecture ? '执行授权' : '准备执行'} · ${title}`,
    header: '执行授权',
    question: '是否授权按当前完整计划开始执行？',
    whyNow: contract.architecture
      ? '只读方案已经完成并与当前合同绑定；在你明确批准前不会写入文件，也不会运行检查命令。'
      : '计划已经冻结；在你明确批准前不会写入任何文件，也不会运行检查命令。',
    changes: change,
    preserved: `${RETAINED_SEMANTICS_STATEMENT}范围外写入、未列命令和系统级操作均不授权；模型转述不构成授权。`,
    impactAndNext,
    options: [{
      label: CONFIRM_LABEL,
      description: '仅批准卡片列出的写入范围、冻结检查和一次同范围返工。',
    }],
    extensions: [{ label: '本次允许的写入前缀', value: contract.implementation.data.writeScopes.join(' · ') }],
    forbiddenIdentifiers: firstScreenIdentifiers(state),
  })
}

export function projectDesignRecord(state: WorkflowRunState, report: z.infer<typeof projectArchitectReportSchema>, actor: string): DesignSnapshot {
  const prior = state.records['design:design']
  return parseWorkflowRecord({
    schemaVersion: 1,
    kind: 'design',
    recordId: 'design',
    runId: state.runId,
    version: (prior?.version ?? 0) + 1,
    createdAt: Date.now(),
    createdBy: actor,
    ...(prior ? { supersedes: ref(prior) } : {}),
    data: {
      summary: report.summary,
      decisions: report.decisions,
      affectedAreas: report.affectedAreas,
      interfaces: report.interfaces,
      migration: [],
      rollback: report.rollback,
    },
  }) as DesignSnapshot
}

export function refsWithCurrentDesign(state: WorkflowRunState, task: TaskBrief, design: DesignSnapshot): TaskBrief {
  return parseWorkflowRecord({
    ...task,
    version: task.version + 1,
    createdAt: Date.now(),
    createdBy: PROJECT_PILOT,
    supersedes: ref(task),
    data: { ...task.data, inputs: [...task.data.inputs.filter(input => input.kind !== 'design'), ref(design)] },
  }) as TaskBrief
}

export function removeArtifactInputs(task: TaskBrief): TaskBrief {
  return parseWorkflowRecord({
    ...task,
    version: task.version + 1,
    createdAt: Date.now(),
    createdBy: PROJECT_PILOT,
    supersedes: ref(task),
    data: { ...task.data, inputs: task.data.inputs.filter(input => input.kind !== 'artifact') },
  }) as TaskBrief
}

export function addArtifactInputs(task: TaskBrief, artifacts: readonly WorkflowRecord[]): TaskBrief {
  const refs: VersionRef[] = artifacts.filter(record => record.kind === 'artifact').map(ref)
  return parseWorkflowRecord({
    ...task,
    version: task.version + 1,
    createdAt: Date.now(),
    createdBy: PROJECT_PILOT,
    supersedes: ref(task),
    data: { ...task.data, inputs: [...task.data.inputs.filter(input => input.kind !== 'artifact'), ...refs] },
  }) as TaskBrief
}
