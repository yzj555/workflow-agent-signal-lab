/**
 * Versioned business records shared by the Workflow Agent control plane.
 *
 * These values are deliberately independent from DSH runtime classes. They
 * must survive JSON persistence, process boundaries, and cold replay.
 */

export const WORKFLOW_SCHEMA_VERSION = 1 as const
export const WORKFLOW_SESSION_EVENT_TYPE = 'workflow/event' as const

export const WORKFLOW_STAGES = [
  'requirements',
  'planning',
  'implementation',
  'verification',
  'review',
  'delivery',
  'learning',
] as const

export const WORKFLOW_ROLES = [
  'pm',
  'researcher',
  'architect',
  'engineer',
  'test_engineer',
  'code_engineer',
  'qa',
  'acceptance_qa',
  'code_reviewer',
  'security_reviewer',
  'doc_reviewer',
] as const

export const WORKFLOW_CONTEXT_DOMAINS = ['C0', 'C1', 'C2', 'C3', 'C4'] as const
export const WORKFLOW_RISK_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const
export const WORKFLOW_RECORD_KINDS = ['requirement', 'design', 'task', 'acceptance', 'artifact'] as const
export const WORKFLOW_ACCEPTANCE_STATUSES = ['PASS', 'FAIL', 'WAIVED'] as const

export type WorkflowStage = typeof WORKFLOW_STAGES[number]
export type WorkflowRole = typeof WORKFLOW_ROLES[number]
export type ContextDomain = typeof WORKFLOW_CONTEXT_DOMAINS[number]
export type RiskLevel = typeof WORKFLOW_RISK_LEVELS[number]
export type WorkflowRecordKind = typeof WORKFLOW_RECORD_KINDS[number]
export type AcceptanceStatus = typeof WORKFLOW_ACCEPTANCE_STATUSES[number]
export type AgentLifecycle = 'one-shot' | 'continuable'

export interface VersionRef {
  readonly kind: WorkflowRecordKind
  readonly recordId: string
  readonly version: number
}

export interface VersionedRecordBase<K extends WorkflowRecordKind> {
  readonly schemaVersion: typeof WORKFLOW_SCHEMA_VERSION
  readonly kind: K
  readonly runId: string
  readonly recordId: string
  readonly version: number
  readonly createdAt: number
  readonly createdBy: string
  readonly contentHash?: string
  readonly supersedes?: VersionRef
}

export interface RequirementQuestion {
  readonly id: string
  readonly question: string
  readonly material: boolean
  readonly status: 'open' | 'resolved'
  readonly resolution?: string
}

export interface RequirementSnapshot extends VersionedRecordBase<'requirement'> {
  readonly data: {
    readonly goal: string
    readonly inScope: readonly string[]
    readonly outOfScope: readonly string[]
    readonly constraints: readonly string[]
    readonly assumptions: readonly string[]
    readonly permissionBoundaries: readonly string[]
    readonly questions: readonly RequirementQuestion[]
    readonly acceptanceIds: readonly string[]
  }
}

export interface DesignSnapshot extends VersionedRecordBase<'design'> {
  readonly data: {
    readonly summary: string
    readonly decisions: readonly {
      readonly id: string
      readonly decision: string
      readonly rationale: string
    }[]
    readonly affectedAreas: readonly string[]
    readonly interfaces: readonly string[]
    readonly migration: readonly string[]
    readonly rollback: readonly string[]
  }
}

export interface TaskBrief extends VersionedRecordBase<'task'> {
  readonly data: {
    readonly title: string
    readonly goal: string
    readonly stage: WorkflowStage
    readonly role: Exclude<WorkflowRole, 'pm'>
    readonly riskLevel: RiskLevel
    readonly requiresActionGate: boolean
    readonly lifecycle: AgentLifecycle
    readonly contextDomains: readonly ContextDomain[]
    readonly inScope: readonly string[]
    readonly outOfScope: readonly string[]
    readonly dependsOn: readonly string[]
    readonly inputs: readonly VersionRef[]
    readonly allowedActions: readonly string[]
    readonly forbiddenActions: readonly string[]
    readonly writeScopes: readonly string[]
    readonly acceptanceIds: readonly string[]
    readonly outputContract: {
      readonly artifacts: readonly string[]
      readonly evidence: readonly string[]
      readonly reportSchema?: string
    }
  }
}

export interface AcceptanceCriterion {
  readonly id: string
  readonly statement: string
  readonly criticality: 'hard' | 'advisory'
  readonly verifier: 'pm' | 'user' | 'test_engineer' | 'qa' | 'acceptance_qa' | 'security_reviewer'
  readonly evidenceRequired: readonly string[]
}

export interface AcceptanceBrief extends VersionedRecordBase<'acceptance'> {
  readonly data: {
    readonly criteria: readonly AcceptanceCriterion[]
    readonly surface: string
    readonly setup: readonly string[]
    readonly forbiddenKnowledge: readonly string[]
  }
}

export interface ArtifactRecord extends VersionedRecordBase<'artifact'> {
  readonly data: {
    readonly name: string
    readonly artifactType: string
    readonly locator: string
    readonly digest: string
    readonly domain: ContextDomain
    readonly producedByTaskId: string
  }
}

export type WorkflowRecord =
  | RequirementSnapshot
  | DesignSnapshot
  | TaskBrief
  | AcceptanceBrief
  | ArtifactRecord

type UnknownRecord = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new Error(`invalid workflow contract at ${path}: ${message}`)
}

function object(value: unknown, path: string, keys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  const result = value as UnknownRecord
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a declared field')
  }
  return result
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail(path, allowEmpty ? 'must be a string' : 'must be a non-empty string')
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `must be a safe integer >= ${String(minimum)}`)
  }
  return value as number
}

function enumeration<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail(path, `must be one of ${values.join(', ')}`)
  }
  return value as T
}

function array<T>(value: unknown, path: string, decode: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  return value.map((item, index) => decode(item, `${path}[${String(index)}]`))
}

function stringArray(value: unknown, path: string, requireOne = false): string[] {
  const result = array(value, path, text)
  if (requireOne && result.length === 0) fail(path, 'must contain at least one item')
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicates')
  return result
}

function enumArray<T extends string>(value: unknown, path: string, values: readonly T[]): T[] {
  const result = array(value, path, (item, itemPath) => enumeration(item, itemPath, values))
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicates')
  return result
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path)
}

/** Stable key used by the version index and stale-input calculation. */
export function workflowVersionKey(ref: Pick<VersionRef, 'kind' | 'recordId'>): string {
  return `${ref.kind}:${ref.recordId}`
}

/** Strictly decode a persisted version reference. */
export function parseVersionRef(value: unknown, path = 'versionRef'): VersionRef {
  const ref = object(value, path, ['kind', 'recordId', 'version'])
  return {
    kind: enumeration(ref.kind, `${path}.kind`, WORKFLOW_RECORD_KINDS),
    recordId: text(ref.recordId, `${path}.recordId`),
    version: safeInteger(ref.version, `${path}.version`, 1),
  }
}

function parseBase(value: unknown, path: string, kind: WorkflowRecordKind): UnknownRecord {
  const record = object(value, path, [
    'schemaVersion',
    'kind',
    'runId',
    'recordId',
    'version',
    'createdAt',
    'createdBy',
    'contentHash',
    'supersedes',
    'data',
  ])
  if (record.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `unsupported version ${String(record.schemaVersion)}`)
  }
  if (record.kind !== kind) fail(`${path}.kind`, `must be ${kind}`)
  text(record.runId, `${path}.runId`)
  text(record.recordId, `${path}.recordId`)
  safeInteger(record.version, `${path}.version`, 1)
  safeInteger(record.createdAt, `${path}.createdAt`)
  text(record.createdBy, `${path}.createdBy`)
  optionalText(record.contentHash, `${path}.contentHash`)
  if (record.supersedes !== undefined) {
    const prior = parseVersionRef(record.supersedes, `${path}.supersedes`)
    if (prior.kind !== kind || prior.recordId !== record.recordId || prior.version !== (record.version as number) - 1) {
      fail(`${path}.supersedes`, 'must reference the immediately preceding version of this record')
    }
  } else if (record.version !== 1) {
    fail(`${path}.supersedes`, 'is required after version 1')
  }
  return record
}

function parseRequirementQuestion(value: unknown, path: string): RequirementQuestion {
  const question = object(value, path, ['id', 'question', 'material', 'status', 'resolution'])
  const status = enumeration(question.status, `${path}.status`, ['open', 'resolved'] as const)
  const resolution = optionalText(question.resolution, `${path}.resolution`)
  if (status === 'resolved' && resolution === undefined) fail(`${path}.resolution`, 'is required when resolved')
  if (status === 'open' && resolution !== undefined) fail(`${path}.resolution`, 'must be absent while open')
  return {
    id: text(question.id, `${path}.id`),
    question: text(question.question, `${path}.question`),
    material: boolean(question.material, `${path}.material`),
    status,
    ...(resolution === undefined ? {} : { resolution }),
  }
}

function parseRequirement(value: unknown, path: string): RequirementSnapshot {
  const record = parseBase(value, path, 'requirement')
  const data = object(record.data, `${path}.data`, [
    'goal', 'inScope', 'outOfScope', 'constraints', 'assumptions',
    'permissionBoundaries', 'questions', 'acceptanceIds',
  ])
  const questions = array(data.questions, `${path}.data.questions`, parseRequirementQuestion)
  if (new Set(questions.map(item => item.id)).size !== questions.length) {
    fail(`${path}.data.questions`, 'question ids must be unique')
  }
  text(data.goal, `${path}.data.goal`)
  stringArray(data.inScope, `${path}.data.inScope`, true)
  stringArray(data.outOfScope, `${path}.data.outOfScope`)
  stringArray(data.constraints, `${path}.data.constraints`)
  stringArray(data.assumptions, `${path}.data.assumptions`)
  stringArray(data.permissionBoundaries, `${path}.data.permissionBoundaries`, true)
  stringArray(data.acceptanceIds, `${path}.data.acceptanceIds`, true)
  return value as RequirementSnapshot
}

function parseDesign(value: unknown, path: string): DesignSnapshot {
  const record = parseBase(value, path, 'design')
  const data = object(record.data, `${path}.data`, [
    'summary', 'decisions', 'affectedAreas', 'interfaces', 'migration', 'rollback',
  ])
  text(data.summary, `${path}.data.summary`)
  const decisions = array(data.decisions, `${path}.data.decisions`, (item, itemPath) => {
    const decision = object(item, itemPath, ['id', 'decision', 'rationale'])
    text(decision.id, `${itemPath}.id`)
    text(decision.decision, `${itemPath}.decision`)
    text(decision.rationale, `${itemPath}.rationale`)
    return decision
  })
  if (new Set(decisions.map(item => item.id)).size !== decisions.length) {
    fail(`${path}.data.decisions`, 'decision ids must be unique')
  }
  stringArray(data.affectedAreas, `${path}.data.affectedAreas`, true)
  stringArray(data.interfaces, `${path}.data.interfaces`)
  stringArray(data.migration, `${path}.data.migration`)
  stringArray(data.rollback, `${path}.data.rollback`, true)
  return value as DesignSnapshot
}

function parseTask(value: unknown, path: string): TaskBrief {
  const record = parseBase(value, path, 'task')
  const data = object(record.data, `${path}.data`, [
    'title', 'goal', 'stage', 'role', 'riskLevel', 'requiresActionGate', 'lifecycle', 'contextDomains',
    'inScope', 'outOfScope', 'dependsOn', 'inputs', 'allowedActions',
    'forbiddenActions', 'writeScopes', 'acceptanceIds', 'outputContract',
  ])
  text(data.title, `${path}.data.title`)
  text(data.goal, `${path}.data.goal`)
  enumeration(data.stage, `${path}.data.stage`, WORKFLOW_STAGES)
  const role = enumeration(data.role, `${path}.data.role`, WORKFLOW_ROLES)
  if (role === 'pm') fail(`${path}.data.role`, 'PM owns orchestration and cannot be a delegated task role')
  enumeration(data.riskLevel, `${path}.data.riskLevel`, WORKFLOW_RISK_LEVELS)
  boolean(data.requiresActionGate, `${path}.data.requiresActionGate`)
  enumeration(data.lifecycle, `${path}.data.lifecycle`, ['one-shot', 'continuable'] as const)
  enumArray(data.contextDomains, `${path}.data.contextDomains`, WORKFLOW_CONTEXT_DOMAINS)
  stringArray(data.inScope, `${path}.data.inScope`, true)
  stringArray(data.outOfScope, `${path}.data.outOfScope`)
  const dependencies = stringArray(data.dependsOn, `${path}.data.dependsOn`)
  if (dependencies.includes(record.recordId as string)) fail(`${path}.data.dependsOn`, 'a task cannot depend on itself')
  const inputs = array(data.inputs, `${path}.data.inputs`, parseVersionRef)
  if (new Set(inputs.map(workflowVersionKey)).size !== inputs.length) {
    fail(`${path}.data.inputs`, 'may reference each record only once')
  }
  stringArray(data.allowedActions, `${path}.data.allowedActions`, true)
  stringArray(data.forbiddenActions, `${path}.data.forbiddenActions`, true)
  stringArray(data.writeScopes, `${path}.data.writeScopes`)
  stringArray(data.acceptanceIds, `${path}.data.acceptanceIds`)
  const output = object(data.outputContract, `${path}.data.outputContract`, ['artifacts', 'evidence', 'reportSchema'])
  stringArray(output.artifacts, `${path}.data.outputContract.artifacts`)
  stringArray(output.evidence, `${path}.data.outputContract.evidence`, true)
  optionalText(output.reportSchema, `${path}.data.outputContract.reportSchema`)
  return value as TaskBrief
}

function parseAcceptanceCriterion(value: unknown, path: string): AcceptanceCriterion {
  const criterion = object(value, path, ['id', 'statement', 'criticality', 'verifier', 'evidenceRequired'])
  return {
    id: text(criterion.id, `${path}.id`),
    statement: text(criterion.statement, `${path}.statement`),
    criticality: enumeration(criterion.criticality, `${path}.criticality`, ['hard', 'advisory'] as const),
    verifier: enumeration(criterion.verifier, `${path}.verifier`, [
      'pm', 'user', 'test_engineer', 'qa', 'acceptance_qa', 'security_reviewer',
    ] as const),
    evidenceRequired: stringArray(criterion.evidenceRequired, `${path}.evidenceRequired`, true),
  }
}

function parseAcceptance(value: unknown, path: string): AcceptanceBrief {
  const record = parseBase(value, path, 'acceptance')
  const data = object(record.data, `${path}.data`, ['criteria', 'surface', 'setup', 'forbiddenKnowledge'])
  const criteria = array(data.criteria, `${path}.data.criteria`, parseAcceptanceCriterion)
  if (criteria.length === 0) fail(`${path}.data.criteria`, 'must contain at least one criterion')
  if (!criteria.some(item => item.criticality === 'hard')) {
    fail(`${path}.data.criteria`, 'must contain at least one hard criterion')
  }
  if (new Set(criteria.map(item => item.id)).size !== criteria.length) {
    fail(`${path}.data.criteria`, 'criterion ids must be unique')
  }
  text(data.surface, `${path}.data.surface`)
  stringArray(data.setup, `${path}.data.setup`)
  stringArray(data.forbiddenKnowledge, `${path}.data.forbiddenKnowledge`)
  return value as AcceptanceBrief
}

function parseArtifact(value: unknown, path: string): ArtifactRecord {
  const record = parseBase(value, path, 'artifact')
  const data = object(record.data, `${path}.data`, [
    'name', 'artifactType', 'locator', 'digest', 'domain', 'producedByTaskId',
  ])
  text(data.name, `${path}.data.name`)
  text(data.artifactType, `${path}.data.artifactType`)
  text(data.locator, `${path}.data.locator`)
  text(data.digest, `${path}.data.digest`)
  enumeration(data.domain, `${path}.data.domain`, WORKFLOW_CONTEXT_DOMAINS)
  text(data.producedByTaskId, `${path}.data.producedByTaskId`)
  return value as ArtifactRecord
}

/**
 * Strictly decode one persisted business record.
 * Unknown fields and unknown schema versions fail closed.
 */
export function parseWorkflowRecord(value: unknown, path = 'record'): WorkflowRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  const kind = (value as UnknownRecord).kind
  switch (kind) {
    case 'requirement': return parseRequirement(value, path)
    case 'design': return parseDesign(value, path)
    case 'task': return parseTask(value, path)
    case 'acceptance': return parseAcceptance(value, path)
    case 'artifact': return parseArtifact(value, path)
    default: fail(`${path}.kind`, `unsupported kind ${String(kind)}`)
  }
}

/** Return the current task packets from a latest-record index. */
export function currentTaskBriefs(records: Readonly<Record<string, WorkflowRecord>>): TaskBrief[] {
  return Object.values(records).filter((record): record is TaskBrief => record.kind === 'task')
}

/**
 * Validate task dependencies and return deterministic parallel execution waves.
 * Every item in one wave may run after all preceding waves have completed.
 */
export function planTaskWaves(tasks: readonly TaskBrief[]): string[][] {
  const byId = new Map(tasks.map(task => [task.recordId, task]))
  if (byId.size !== tasks.length) throw new Error('workflow task graph reuses a task id')
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const task of tasks) {
    indegree.set(task.recordId, task.data.dependsOn.length)
    for (const dependency of task.data.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`workflow task ${task.recordId} depends on missing task ${dependency}`)
      const targets = outgoing.get(dependency) ?? []
      targets.push(task.recordId)
      outgoing.set(dependency, targets)
    }
  }

  let ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id).sort()
  const waves: string[][] = []
  let visited = 0
  while (ready.length > 0) {
    const wave = ready
    waves.push(wave)
    visited += wave.length
    const next: string[] = []
    for (const id of wave) {
      for (const target of outgoing.get(id) ?? []) {
        const count = (indegree.get(target) ?? 0) - 1
        indegree.set(target, count)
        if (count === 0) next.push(target)
      }
    }
    ready = next.sort()
  }
  if (visited !== tasks.length) {
    const cyclic = [...indegree].filter(([, count]) => count > 0).map(([id]) => id).sort()
    throw new Error(`workflow task graph contains a cycle: ${cyclic.join(', ')}`)
  }
  return waves
}
