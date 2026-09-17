/** Durable event vocabulary and strict replay for Workflow Agent runs. */

import { createHash } from 'node:crypto'

import {
  WORKFLOW_ACCEPTANCE_STATUSES,
  WORKFLOW_CONTEXT_DOMAINS,
  WORKFLOW_RISK_LEVELS,
  WORKFLOW_ROLES,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_SESSION_EVENT_TYPE,
  WORKFLOW_STAGES,
  currentTaskBriefs,
  parseVersionRef,
  parseWorkflowRecord,
  planTaskWaves,
  workflowVersionKey,
} from './workflow-contract.ts'
import type {
  AcceptanceBrief,
  AcceptanceStatus,
  ContextDomain,
  RiskLevel,
  TaskBrief,
  VersionRef,
  WorkflowRecord,
  WorkflowRole,
  WorkflowStage,
} from './workflow-contract.ts'
import { PROJECT_PILOT, WORKFLOW_EXECUTION_PROFILES } from './workflow-profiles.ts'
import type { LearningActionKind, LearningScope } from './workflow-learning.ts'
import { assertManualCloseScope, manualCloseRequestSchema } from './workflow-reconciliation.ts'
import type { ManualCloseRequest } from './workflow-reconciliation.ts'

export const WORKFLOW_EVENT_NAMES = [
  'run/created',
  'risk/classified',
  'gate/requested',
  'gate/decided',
  'record/published',
  'task/status-changed',
  'agent/assigned',
  'agent/resumed',
  'agent/settled',
  'agent/runtime-interrupted',
  'command/started',
  'command/finished',
  'evidence/recorded',
  'acceptance/recorded',
  'checkpoint/file-captured',
  'checkpoint/file-observed',
  'return/routed',
  'outcome/declared',
  'rollback/applied',
  'rollback/prepared',
  'rollback/interrupted',
  'rollback/cleaned',
  'learning/applied',
  'learning/proposed',
  'learning/revised',
  'learning/decided',
  'learning/revoked',
  'runtime/stall-detected',
  'runtime/recovery-settled',
  'runtime/manual-close-requested',
  'runtime/manual-close-recorded',
] as const

/** Reserved Journal lane for root turns before an explicit workflow run exists. */
export const WORKFLOW_INGRESS_RUN_ID = '@workflow-ingress'

export type WorkflowEventName = typeof WORKFLOW_EVENT_NAMES[number]
export type GateKind = 'signal' | 'plan' | 'execution' | 'product' | 'review' | 'delivery' | 'learning' | 'action' | 'rollback' | 'runtime-recovery'
export type TaskStatus = 'pending' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'invalidated'
export type WorkflowOutcomeCode = 'PASS' | 'QUALIFIED' | 'FAIL' | 'CANCELLED' | 'ABANDONED'

export interface WorkflowActor {
  readonly kind: 'user' | 'pm' | 'agent' | 'system'
  readonly id: string
  readonly role?: WorkflowRole
}

/**
 * What the Host can actually prove about a decision received from DSH's
 * native question channel. The channel enforces user authority, but the
 * current answer protocol carries no trustworthy physical-operator identity.
 */
export interface WorkflowDecisionAudit {
  readonly authority: 'user'
  readonly channel: 'native-question'
  readonly operator: 'unverified'
  readonly requestId: string
}

/** Durable root-coordinator recovery state. It never grants user authority. */
export interface WorkflowRuntimeRecoveryState {
  readonly incidentId: string
  readonly status: 'recovering' | 'needs-attention'
  readonly attempt: number
  readonly turn: number
  readonly stage: WorkflowStage
  readonly noProgressMs: number
  readonly journalRevision: number
  readonly reason: string
  readonly preserved: readonly string[]
  readonly resumeFrom: string
}

export interface EvidenceRecord {
  readonly evidenceId: string
  readonly kind: 'research' | 'implementation' | 'verification' | 'review' | 'product' | 'runtime'
  readonly verdict: 'pass' | 'fail' | 'informational'
  readonly summary: string
  readonly producedBy: string
  readonly taskId?: string
  readonly acceptanceId?: string
  readonly artifactRefs: readonly VersionRef[]
}

export interface AcceptanceResult {
  readonly criterionId: string
  readonly briefVersion: number
  readonly status: AcceptanceStatus
  readonly evidenceIds: readonly string[]
  readonly rationale: string
  readonly userApprovalRef?: string
}

export type WorkflowFileState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly digest: string; readonly bytes: number }

export interface WorkflowCheckpointFile {
  readonly path: string
  readonly before: WorkflowFileState
  readonly after: WorkflowFileState
}

export interface WorkflowCheckpointState {
  readonly checkpointId: string
  readonly taskId: string
  readonly taskVersion: number
  readonly files: Readonly<Record<string, WorkflowCheckpointFile>>
}

export interface WorkflowEventPayloadMap {
  readonly 'runtime/manual-close-requested': ManualCloseRequest
  readonly 'runtime/manual-close-recorded': { readonly gateId: string }
  readonly 'run/created': {
    readonly presetId: string
    readonly rootSessionId: string
    readonly title: string
  }
  readonly 'risk/classified': {
    readonly level: RiskLevel
    readonly reasons: readonly string[]
    readonly actionGateRequired: boolean
    readonly actionTypes: readonly string[]
  }
  readonly 'gate/requested': {
    readonly gateId: string
    readonly kind: GateKind
    readonly stage: WorkflowStage
    readonly summary: string
    readonly requiredActor: 'user' | 'pm' | 'acceptance_qa'
    readonly scopeTaskIds: readonly string[]
    readonly inputRefs: readonly VersionRef[]
  }
  readonly 'gate/decided': {
    readonly gateId: string
    readonly decision: 'approved' | 'rejected' | 'cancelled'
    readonly reason: string
    readonly decisionAudit?: WorkflowDecisionAudit
  }
  readonly 'record/published': { readonly record: WorkflowRecord }
  readonly 'task/status-changed': {
    readonly taskId: string
    readonly taskVersion: number
    readonly expectedStatus: TaskStatus
    readonly status: TaskStatus
    readonly reason: string
  }
  readonly 'agent/assigned': {
    readonly assignmentId: string
    readonly taskId: string
    readonly taskVersion: number
    readonly agentSessionId: string
    readonly role: Exclude<WorkflowRole, 'pm'>
    readonly lifecycle: 'one-shot' | 'continuable'
    readonly contextDomains: readonly ContextDomain[]
  }
  readonly 'agent/resumed': {
    readonly assignmentId: string
    readonly taskVersion: number
    readonly reason: string
  }
  readonly 'agent/settled': {
    readonly assignmentId: string
    readonly outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    readonly summary: string
  }
  readonly 'agent/runtime-interrupted': ChildRuntimeIssue
  readonly 'command/started': {
    readonly commandId: string
    readonly assignmentId: string
    readonly taskVersion: number
    readonly checkId: string
    readonly timeoutMs: number
  }
  readonly 'command/finished': {
    readonly commandId: string
    readonly status: 'completed' | 'interrupted' | 'unknown'
    readonly elapsedMs: number
    readonly processCount: number
    readonly exitConfirmed: boolean
    readonly toolSettled: boolean
    readonly exitCode: number | null
    readonly diagnostic?: string
  }
  readonly 'evidence/recorded': { readonly evidence: EvidenceRecord }
  readonly 'acceptance/recorded': { readonly result: AcceptanceResult }
  readonly 'checkpoint/file-captured': {
    readonly checkpointId: string
    readonly taskId: string
    readonly taskVersion: number
    readonly path: string
    readonly before: WorkflowFileState
  }
  readonly 'checkpoint/file-observed': {
    readonly checkpointId: string
    readonly path: string
    readonly expectedBefore: WorkflowFileState
    readonly after: WorkflowFileState
  }
  readonly 'return/routed': {
    readonly fromStage: WorkflowStage
    readonly toStage: WorkflowStage
    readonly responsibleTaskId?: string
    readonly reason: string
    readonly attempt: number
  }
  readonly 'outcome/declared': {
    readonly outcome: WorkflowOutcomeCode
    readonly reason: string
    readonly ledger: AcceptanceLedgerSummary
  }
  readonly 'rollback/applied': {
    readonly rollbackId: string
    readonly checkpointId: string
    readonly gateId: string
    readonly files: readonly {
      readonly path: string
      readonly action: 'restore' | 'remove'
    }[]
    readonly reason: string
  }
  readonly 'rollback/prepared': WorkflowEventPayloadMap['rollback/applied']
  readonly 'rollback/interrupted': { readonly rollbackId: string; readonly reason: string }
  readonly 'rollback/cleaned': { readonly rollbackId: string }
  readonly 'learning/proposed': {
    readonly items: readonly {
      readonly id: string
      readonly statement: string
      readonly basis: string
      readonly proposedScope: 'run' | 'project' | 'preset'
      /** Optional only so journals from the initial skeleton remain readable. */
      readonly version?: number
      readonly ruleKey?: string
      readonly actionKind?: LearningActionKind
      readonly risk?: 'low' | 'execution-affecting'
      readonly trigger?: { readonly mode: 'always' | 'exact'; readonly terms: readonly string[] }
      readonly sourceEvidenceIds?: readonly string[]
      readonly sourceSummaryHash?: string
      readonly workflowProfile?: typeof WORKFLOW_EXECUTION_PROFILES[number]
      readonly projectKey?: string
    }[]
  }
  readonly 'learning/revised': {
    readonly candidateId: string
    readonly previousStatement: string
    readonly statement: string
    readonly reason: string
    readonly attempt: number
  }
  readonly 'learning/decided': {
    readonly acceptedIds: readonly string[]
    readonly rejectedIds: readonly string[]
    readonly revisionRequiredIds?: readonly string[]
    readonly acceptedScopes?: readonly { readonly id: string; readonly scope: LearningScope }[]
    readonly decisionAudit?: WorkflowDecisionAudit
  }
  readonly 'learning/applied': {
    readonly items: readonly {
      readonly ruleId: string
      readonly version: number
      readonly sourceRunId: string
      readonly statement: string
      readonly scope: LearningScope
      readonly actionKind: LearningActionKind
      readonly reason: string
      readonly status: 'applied' | 'overridden'
    }[]
  }
  readonly 'learning/revoked': {
    readonly ruleId: string
    readonly version: number
    readonly reason: string
    readonly decisionAudit?: WorkflowDecisionAudit
  }
  readonly 'runtime/stall-detected': {
    readonly incidentId: string
    readonly turn: number
    readonly stage: WorkflowStage
    readonly noProgressMs: number
    /** Journal revision observed before this event was appended. */
    readonly journalRevision: number
    readonly attempt: number
    readonly disposition: 'auto-continue' | 'needs-attention'
    readonly reason: string
    readonly preserved: readonly string[]
    readonly resumeFrom: string
  }
  readonly 'runtime/recovery-settled': {
    readonly incidentId: string
    readonly outcome: 'resumed' | 'needs-attention'
    readonly summary: string
  }
}

export type WorkflowEventData<N extends WorkflowEventName = WorkflowEventName> = {
  [K in N]: {
    readonly version: typeof WORKFLOW_SCHEMA_VERSION
    readonly runId: string
    readonly eventId: string
    readonly name: K
    readonly actor: WorkflowActor
    readonly correlationId?: string
    readonly causationId?: string
    readonly payload: WorkflowEventPayloadMap[K]
  }
}[N]

/** Plugin-journal envelope. seq/time are allocated by the Host Journal, not DSH Session.append. */
export interface WorkflowStoredEvent {
  readonly type: typeof WORKFLOW_SESSION_EVENT_TYPE
  readonly seq: number
  readonly time: number
  readonly data: WorkflowEventData
}

export type GateRuntimeState = WorkflowEventPayloadMap['gate/requested'] & {
  readonly status: 'waiting' | 'approved' | 'rejected' | 'cancelled'
  readonly decidedBy?: WorkflowActor
  readonly decisionAudit?: WorkflowDecisionAudit
  readonly reason?: string
}

export interface TaskRuntimeState {
  readonly briefVersion: number
  readonly status: TaskStatus
  readonly reason: string
}

export interface ChildRuntimeIssue {
  readonly incidentId: string
  readonly assignmentId: string
  readonly taskVersion: number
  readonly cause: 'admission-timeout' | 'admission-failed' | 'no-progress' | 'deadline' | 'report-timeout' | 'disposed' | 'host-restart' | 'stop-requested'
    | 'command-timeout' | 'command-cancelled' | 'command-exit-unknown' | 'command-execution-error' | 'run-budget'
  readonly status: 'stopping' | 'stopped' | 'unknown'
  readonly budgetMs: number
  readonly elapsedMs: number
  readonly reason: string
}

export type AssignmentRuntimeState = WorkflowEventPayloadMap['agent/assigned'] & {
  readonly status: 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly lastSummary?: string
  readonly runtimeIssue?: ChildRuntimeIssue
}

export interface AcceptanceLedgerSummary {
  readonly pass: number
  readonly fail: number
  readonly waived: number
  readonly pending: number
  readonly hardOutcome: 'PASS' | 'QUALIFIED' | 'FAIL' | 'PENDING'
}

export interface WorkflowRunState {
  readonly schemaVersion: typeof WORKFLOW_SCHEMA_VERSION
  readonly runId: string
  readonly created?: WorkflowEventPayloadMap['run/created']
  readonly risk?: WorkflowEventPayloadMap['risk/classified']
  readonly currentStage: WorkflowStage
  readonly gates: Readonly<Record<string, GateRuntimeState>>
  readonly records: Readonly<Record<string, WorkflowRecord>>
  readonly latestVersions: Readonly<Record<string, number>>
  readonly tasks: Readonly<Record<string, TaskRuntimeState>>
  readonly assignments: Readonly<Record<string, AssignmentRuntimeState>>
  readonly commands: Readonly<Record<string, WorkflowEventPayloadMap['command/started'] & {
    readonly status: 'running' | 'completed' | 'interrupted' | 'unknown'
    readonly observation?: WorkflowEventPayloadMap['command/finished']
  }>>
  readonly evidence: Readonly<Record<string, EvidenceRecord>>
  readonly acceptance: Readonly<Record<string, AcceptanceResult>>
  readonly checkpoints: Readonly<Record<string, WorkflowCheckpointState>>
  readonly rollbacks: readonly WorkflowEventPayloadMap['rollback/applied'][]
  /** Present only for the crash-safe protocol. Legacy applied events remain readable. */
  readonly rollbackTransaction?: WorkflowEventPayloadMap['rollback/prepared'] & {
    readonly phase: 'prepared' | 'interrupted' | 'applied' | 'cleaned'
  }
  readonly staleTaskIds: readonly string[]
  readonly staleGateIds: readonly string[]
  readonly returns: readonly WorkflowEventPayloadMap['return/routed'][]
  readonly appliedLearning: readonly WorkflowEventPayloadMap['learning/applied']['items'][number][]
  readonly learningProposalRecorded: boolean
  readonly proposedLearning: readonly WorkflowEventPayloadMap['learning/proposed']['items'][number][]
  readonly learningDecision?: WorkflowEventPayloadMap['learning/decided']
  readonly learningRevisions: readonly WorkflowEventPayloadMap['learning/revised'][]
  readonly learningRevisionReadyIds: readonly string[]
  readonly learningRevocations: readonly WorkflowEventPayloadMap['learning/revoked'][]
  readonly runtimeRecovery?: WorkflowRuntimeRecoveryState
  readonly manualCloseRequests: Readonly<Record<string, ManualCloseRequest & { readonly requestedAtSeq: number }>>
  readonly manualClose?: { readonly gateId: string; readonly recordedAt: number; readonly decisionAudit: WorkflowDecisionAudit }
  readonly outcome?: WorkflowEventPayloadMap['outcome/declared']
  readonly eventIds: Readonly<Record<string, true>>
  readonly lastSeq: number
  readonly lastTime: number
}

/** True only when every persisted candidate has a final accept/reject result. */
export function learningDecisionComplete(state: WorkflowRunState): boolean {
  if (!state.learningProposalRecorded) return false
  if (state.proposedLearning.length === 0) return true
  const decision = state.learningDecision
  if (!decision || (decision.revisionRequiredIds?.length ?? 0) > 0) return false
  const finalIds = [...decision.acceptedIds, ...decision.rejectedIds]
  return finalIds.length === state.proposedLearning.length
    && new Set(finalIds).size === finalIds.length
    && state.proposedLearning.every(item => finalIds.includes(item.id))
}

type MutableWorkflowRunState = {
  -readonly [K in keyof WorkflowRunState]: WorkflowRunState[K]
}

type UnknownRecord = Record<string, unknown>

function invalid(path: string, message: string): never {
  throw new Error(`invalid workflow event at ${path}: ${message}`)
}

function object(value: unknown, path: string, keys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be an object')
  const result = value as UnknownRecord
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) invalid(`${path}.${key}`, 'is not a declared field')
  }
  return result
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(path, 'must be a non-empty string')
  return value
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(path, `must be a safe integer >= ${String(minimum)}`)
  return value as number
}

function enumeration<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(path, `must be one of ${values.join(', ')}`)
  return value as T
}

function array<T>(value: unknown, path: string, decode: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) invalid(path, 'must be an array')
  return value.map((item, index) => decode(item, `${path}[${String(index)}]`))
}

function strings(value: unknown, path: string): string[] {
  const result = array(value, path, text)
  if (new Set(result).size !== result.length) invalid(path, 'must not contain duplicates')
  return result
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path)
}

function workflowPath(value: unknown, path: string): string {
  const result = text(value, path)
  if (result.includes('\0') || result.includes('\\') || result.startsWith('/') || result.endsWith('/') || /^[a-z]:/iu.test(result)
    || result.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    invalid(path, 'must be a normalized workspace-relative path')
  }
  return result
}

function fileState(value: unknown, path: string): WorkflowFileState {
  const source = object(value, path, ['kind', 'digest', 'bytes'])
  const kind = enumeration(source.kind, `${path}.kind`, ['absent', 'file'] as const)
  if (kind === 'absent') {
    if (source.digest !== undefined || source.bytes !== undefined) invalid(path, 'absent state cannot contain file fields')
    return { kind }
  }
  const digest = text(source.digest, `${path}.digest`)
  if (!/^[a-f0-9]{64}$/u.test(digest)) invalid(`${path}.digest`, 'must be a lowercase SHA-256 digest')
  const bytes = integer(source.bytes, `${path}.bytes`)
  if (bytes > 16 * 1024 * 1024) invalid(`${path}.bytes`, 'exceeds the 16 MiB pilot limit')
  return { kind, digest, bytes }
}

export function sameWorkflowFileState(left: WorkflowFileState, right: WorkflowFileState): boolean {
  return left.kind === right.kind && (left.kind === 'absent'
    || (right.kind === 'file' && left.digest === right.digest && left.bytes === right.bytes))
}

function actor(value: unknown, path: string): WorkflowActor {
  const source = object(value, path, ['kind', 'id', 'role'])
  const kind = enumeration(source.kind, `${path}.kind`, ['user', 'pm', 'agent', 'system'] as const)
  const role = source.role === undefined ? undefined : enumeration(source.role, `${path}.role`, WORKFLOW_ROLES)
  if (kind === 'pm' && role !== undefined && role !== 'pm') invalid(`${path}.role`, 'PM actor may only use the pm role')
  if (kind === 'agent' && (role === undefined || role === 'pm')) invalid(`${path}.role`, 'delegated agent must declare a non-PM role')
  if ((kind === 'user' || kind === 'system') && role !== undefined) invalid(`${path}.role`, `must be absent for ${kind}`)
  return { kind, id: text(source.id, `${path}.id`), ...(role === undefined ? {} : { role }) }
}

function decisionAudit(value: unknown, path: string): WorkflowDecisionAudit {
  const source = object(value, path, ['authority', 'channel', 'operator', 'requestId'])
  return {
    authority: enumeration(source.authority, `${path}.authority`, ['user'] as const),
    channel: enumeration(source.channel, `${path}.channel`, ['native-question'] as const),
    operator: enumeration(source.operator, `${path}.operator`, ['unverified'] as const),
    requestId: text(source.requestId, `${path}.requestId`),
  }
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean')
  return value
}

function parseLedger(value: unknown, path: string): AcceptanceLedgerSummary {
  const ledger = object(value, path, ['pass', 'fail', 'waived', 'pending', 'hardOutcome'])
  return {
    pass: integer(ledger.pass, `${path}.pass`),
    fail: integer(ledger.fail, `${path}.fail`),
    waived: integer(ledger.waived, `${path}.waived`),
    pending: integer(ledger.pending, `${path}.pending`),
    hardOutcome: enumeration(ledger.hardOutcome, `${path}.hardOutcome`, ['PASS', 'QUALIFIED', 'FAIL', 'PENDING'] as const),
  }
}

function parseEvidence(value: unknown, path: string): EvidenceRecord {
  const evidence = object(value, path, [
    'evidenceId', 'kind', 'verdict', 'summary', 'producedBy', 'taskId', 'acceptanceId', 'artifactRefs',
  ])
  return {
    evidenceId: text(evidence.evidenceId, `${path}.evidenceId`),
    kind: enumeration(evidence.kind, `${path}.kind`, ['research', 'implementation', 'verification', 'review', 'product', 'runtime'] as const),
    verdict: enumeration(evidence.verdict, `${path}.verdict`, ['pass', 'fail', 'informational'] as const),
    summary: text(evidence.summary, `${path}.summary`),
    producedBy: text(evidence.producedBy, `${path}.producedBy`),
    ...(evidence.taskId === undefined ? {} : { taskId: text(evidence.taskId, `${path}.taskId`) }),
    ...(evidence.acceptanceId === undefined ? {} : { acceptanceId: text(evidence.acceptanceId, `${path}.acceptanceId`) }),
    artifactRefs: array(evidence.artifactRefs, `${path}.artifactRefs`, parseVersionRef),
  }
}

function parseAcceptanceResult(value: unknown, path: string): AcceptanceResult {
  const result = object(value, path, ['criterionId', 'briefVersion', 'status', 'evidenceIds', 'rationale', 'userApprovalRef'])
  const status = enumeration(result.status, `${path}.status`, WORKFLOW_ACCEPTANCE_STATUSES)
  const userApprovalRef = optionalText(result.userApprovalRef, `${path}.userApprovalRef`)
  if (status === 'WAIVED' && userApprovalRef === undefined) invalid(`${path}.userApprovalRef`, 'is required for WAIVED')
  if (status !== 'WAIVED' && userApprovalRef !== undefined) invalid(`${path}.userApprovalRef`, 'is only valid for WAIVED')
  const evidenceIds = strings(result.evidenceIds, `${path}.evidenceIds`)
  if (evidenceIds.length === 0) invalid(`${path}.evidenceIds`, 'must contain evidence')
  return {
    criterionId: text(result.criterionId, `${path}.criterionId`),
    briefVersion: integer(result.briefVersion, `${path}.briefVersion`, 1),
    status,
    evidenceIds,
    rationale: text(result.rationale, `${path}.rationale`),
    ...(userApprovalRef === undefined ? {} : { userApprovalRef }),
  }
}

function parsePayload(name: WorkflowEventName, value: unknown, path: string): WorkflowEventPayloadMap[WorkflowEventName] {
  switch (name) {
    case 'runtime/manual-close-requested':
      return manualCloseRequestSchema.parse(value)
    case 'runtime/manual-close-recorded': {
      const payload = object(value, path, ['gateId'])
      return { gateId: text(payload.gateId, `${path}.gateId`) }
    }
    case 'run/created': {
      const payload = object(value, path, ['presetId', 'rootSessionId', 'title'])
      text(payload.presetId, `${path}.presetId`)
      text(payload.rootSessionId, `${path}.rootSessionId`)
      text(payload.title, `${path}.title`)
      return value as WorkflowEventPayloadMap['run/created']
    }
    case 'risk/classified': {
      const payload = object(value, path, ['level', 'reasons', 'actionGateRequired', 'actionTypes'])
      enumeration(payload.level, `${path}.level`, WORKFLOW_RISK_LEVELS)
      const reasons = strings(payload.reasons, `${path}.reasons`)
      if (reasons.length === 0) invalid(`${path}.reasons`, 'must contain at least one reason')
      boolean(payload.actionGateRequired, `${path}.actionGateRequired`)
      strings(payload.actionTypes, `${path}.actionTypes`)
      return value as WorkflowEventPayloadMap['risk/classified']
    }
    case 'gate/requested': {
      const payload = object(value, path, ['gateId', 'kind', 'stage', 'summary', 'requiredActor', 'scopeTaskIds', 'inputRefs'])
      text(payload.gateId, `${path}.gateId`)
      enumeration(payload.kind, `${path}.kind`, ['signal', 'plan', 'execution', 'product', 'review', 'delivery', 'learning', 'action', 'rollback', 'runtime-recovery'] as const)
      enumeration(payload.stage, `${path}.stage`, WORKFLOW_STAGES)
      text(payload.summary, `${path}.summary`)
      enumeration(payload.requiredActor, `${path}.requiredActor`, ['user', 'pm', 'acceptance_qa'] as const)
      strings(payload.scopeTaskIds, `${path}.scopeTaskIds`)
      const refs = array(payload.inputRefs, `${path}.inputRefs`, parseVersionRef)
      if (new Set(refs.map(workflowVersionKey)).size !== refs.length) invalid(`${path}.inputRefs`, 'may reference each record only once')
      return value as WorkflowEventPayloadMap['gate/requested']
    }
    case 'gate/decided': {
      const payload = object(value, path, ['gateId', 'decision', 'reason', 'decisionAudit'])
      return {
        gateId: text(payload.gateId, `${path}.gateId`),
        decision: enumeration(payload.decision, `${path}.decision`, ['approved', 'rejected', 'cancelled'] as const),
        reason: text(payload.reason, `${path}.reason`),
        ...(payload.decisionAudit === undefined ? {} : { decisionAudit: decisionAudit(payload.decisionAudit, `${path}.decisionAudit`) }),
      }
    }
    case 'record/published': {
      const payload = object(value, path, ['record'])
      return { record: parseWorkflowRecord(payload.record, `${path}.record`) }
    }
    case 'task/status-changed': {
      const payload = object(value, path, ['taskId', 'taskVersion', 'expectedStatus', 'status', 'reason'])
      text(payload.taskId, `${path}.taskId`)
      integer(payload.taskVersion, `${path}.taskVersion`, 1)
      const statuses = ['pending', 'ready', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'invalidated'] as const
      enumeration(payload.expectedStatus, `${path}.expectedStatus`, statuses)
      enumeration(payload.status, `${path}.status`, statuses)
      text(payload.reason, `${path}.reason`)
      return value as WorkflowEventPayloadMap['task/status-changed']
    }
    case 'agent/assigned': {
      const payload = object(value, path, [
        'assignmentId', 'taskId', 'taskVersion', 'agentSessionId', 'role', 'lifecycle', 'contextDomains',
      ])
      text(payload.assignmentId, `${path}.assignmentId`)
      text(payload.taskId, `${path}.taskId`)
      integer(payload.taskVersion, `${path}.taskVersion`, 1)
      text(payload.agentSessionId, `${path}.agentSessionId`)
      const role = enumeration(payload.role, `${path}.role`, WORKFLOW_ROLES)
      if (role === 'pm') invalid(`${path}.role`, 'cannot assign the PM as a child')
      enumeration(payload.lifecycle, `${path}.lifecycle`, ['one-shot', 'continuable'] as const)
      const domains = array(payload.contextDomains, `${path}.contextDomains`, (item, itemPath) => enumeration(item, itemPath, WORKFLOW_CONTEXT_DOMAINS))
      if (domains.length === 0 || new Set(domains).size !== domains.length) invalid(`${path}.contextDomains`, 'must be non-empty and unique')
      return value as WorkflowEventPayloadMap['agent/assigned']
    }
    case 'agent/resumed': {
      const payload = object(value, path, ['assignmentId', 'taskVersion', 'reason'])
      text(payload.assignmentId, `${path}.assignmentId`)
      integer(payload.taskVersion, `${path}.taskVersion`, 1)
      text(payload.reason, `${path}.reason`)
      return value as WorkflowEventPayloadMap['agent/resumed']
    }
    case 'agent/settled': {
      const payload = object(value, path, ['assignmentId', 'outcome', 'summary'])
      text(payload.assignmentId, `${path}.assignmentId`)
      enumeration(payload.outcome, `${path}.outcome`, ['completed', 'failed', 'cancelled', 'interrupted'] as const)
      text(payload.summary, `${path}.summary`)
      return value as WorkflowEventPayloadMap['agent/settled']
    }
    case 'agent/runtime-interrupted': {
      const payload = object(value, path, ['incidentId', 'assignmentId', 'taskVersion', 'cause', 'status', 'budgetMs', 'elapsedMs', 'reason'])
      text(payload.incidentId, `${path}.incidentId`)
      text(payload.assignmentId, `${path}.assignmentId`)
      integer(payload.taskVersion, `${path}.taskVersion`, 1)
      enumeration(payload.cause, `${path}.cause`, ['admission-timeout', 'admission-failed', 'no-progress', 'deadline', 'report-timeout', 'disposed', 'host-restart', 'stop-requested', 'command-timeout', 'command-cancelled', 'command-exit-unknown', 'command-execution-error', 'run-budget'] as const)
      enumeration(payload.status, `${path}.status`, ['stopping', 'stopped', 'unknown'] as const)
      integer(payload.budgetMs, `${path}.budgetMs`)
      integer(payload.elapsedMs, `${path}.elapsedMs`)
      text(payload.reason, `${path}.reason`)
      return value as ChildRuntimeIssue
    }
    case 'command/started': {
      const payload = object(value, path, ['commandId', 'assignmentId', 'taskVersion', 'checkId', 'timeoutMs'])
      for (const key of ['commandId', 'assignmentId', 'checkId']) text(payload[key], `${path}.${key}`)
      integer(payload.taskVersion, `${path}.taskVersion`, 1)
      integer(payload.timeoutMs, `${path}.timeoutMs`, 1)
      if ((payload.timeoutMs as number) > 120_000) invalid(path, 'command budget exceeds the workflow ceiling')
      return value as WorkflowEventPayloadMap['command/started']
    }
    case 'command/finished': {
      const payload = object(value, path, ['commandId', 'status', 'elapsedMs', 'processCount', 'exitConfirmed', 'toolSettled', 'exitCode', 'diagnostic'])
      text(payload.commandId, `${path}.commandId`)
      enumeration(payload.status, `${path}.status`, ['completed', 'interrupted', 'unknown'] as const)
      integer(payload.elapsedMs, `${path}.elapsedMs`)
      integer(payload.processCount, `${path}.processCount`)
      if (typeof payload.exitConfirmed !== 'boolean' || typeof payload.toolSettled !== 'boolean') invalid(path, 'command exit facts must be booleans')
      if (payload.exitCode !== null && !Number.isSafeInteger(payload.exitCode)) invalid(path, 'exitCode must be a safe integer or null')
      if (payload.diagnostic !== undefined) text(payload.diagnostic, `${path}.diagnostic`)
      const known = payload.processCount === 1 && payload.exitConfirmed && payload.toolSettled
      if ((payload.status === 'unknown') === !!known) invalid(path, 'command status contradicts its exit facts')
      if (payload.status === 'completed' && payload.exitCode === null) invalid(path, 'completed command requires a direct exit code')
      return value as WorkflowEventPayloadMap['command/finished']
    }
    case 'evidence/recorded': {
      const payload = object(value, path, ['evidence'])
      return { evidence: parseEvidence(payload.evidence, `${path}.evidence`) }
    }
    case 'acceptance/recorded': {
      const payload = object(value, path, ['result'])
      return { result: parseAcceptanceResult(payload.result, `${path}.result`) }
    }
    case 'checkpoint/file-captured': {
      const payload = object(value, path, ['checkpointId', 'taskId', 'taskVersion', 'path', 'before'])
      text(payload.checkpointId, `${path}.checkpointId`)
      text(payload.taskId, `${path}.taskId`)
      integer(payload.taskVersion, `${path}.taskVersion`, 1)
      workflowPath(payload.path, `${path}.path`)
      return { ...payload, before: fileState(payload.before, `${path}.before`) } as WorkflowEventPayloadMap['checkpoint/file-captured']
    }
    case 'checkpoint/file-observed': {
      const payload = object(value, path, ['checkpointId', 'path', 'expectedBefore', 'after'])
      text(payload.checkpointId, `${path}.checkpointId`)
      workflowPath(payload.path, `${path}.path`)
      return {
        ...payload,
        expectedBefore: fileState(payload.expectedBefore, `${path}.expectedBefore`),
        after: fileState(payload.after, `${path}.after`),
      } as WorkflowEventPayloadMap['checkpoint/file-observed']
    }
    case 'return/routed': {
      const payload = object(value, path, ['fromStage', 'toStage', 'responsibleTaskId', 'reason', 'attempt'])
      enumeration(payload.fromStage, `${path}.fromStage`, WORKFLOW_STAGES)
      enumeration(payload.toStage, `${path}.toStage`, WORKFLOW_STAGES)
      optionalText(payload.responsibleTaskId, `${path}.responsibleTaskId`)
      text(payload.reason, `${path}.reason`)
      integer(payload.attempt, `${path}.attempt`, 1)
      return value as WorkflowEventPayloadMap['return/routed']
    }
    case 'outcome/declared': {
      const payload = object(value, path, ['outcome', 'reason', 'ledger'])
      enumeration(payload.outcome, `${path}.outcome`, ['PASS', 'QUALIFIED', 'FAIL', 'CANCELLED', 'ABANDONED'] as const)
      text(payload.reason, `${path}.reason`)
      return { ...payload, ledger: parseLedger(payload.ledger, `${path}.ledger`) } as WorkflowEventPayloadMap['outcome/declared']
    }
    case 'rollback/prepared':
    case 'rollback/applied': {
      const payload = object(value, path, ['rollbackId', 'checkpointId', 'gateId', 'files', 'reason'])
      const rollbackId = text(payload.rollbackId, `${path}.rollbackId`)
      if (name === 'rollback/prepared' && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(rollbackId)) invalid(`${path}.rollbackId`, 'must be a UUID')
      const checkpointId = text(payload.checkpointId, `${path}.checkpointId`)
      const gateId = text(payload.gateId, `${path}.gateId`)
      const reason = text(payload.reason, `${path}.reason`)
      const files = array(payload.files, `${path}.files`, (item, itemPath) => {
        const entry = object(item, itemPath, ['path', 'action'])
        return {
          path: workflowPath(entry.path, `${itemPath}.path`),
          action: enumeration(entry.action, `${itemPath}.action`, ['restore', 'remove'] as const),
        }
      })
      if (files.length === 0 || new Set(files.map(item => item.path.toLocaleLowerCase('en-US'))).size !== files.length) {
        invalid(`${path}.files`, 'must be non-empty and unique')
      }
      return { rollbackId, checkpointId, gateId, files, reason }
    }
    case 'rollback/interrupted': {
      const payload = object(value, path, ['rollbackId', 'reason'])
      return { rollbackId: text(payload.rollbackId, `${path}.rollbackId`), reason: text(payload.reason, `${path}.reason`) }
    }
    case 'rollback/cleaned': {
      const payload = object(value, path, ['rollbackId'])
      return { rollbackId: text(payload.rollbackId, `${path}.rollbackId`) }
    }
    case 'learning/applied': {
      const payload = object(value, path, ['items'])
      const items = array(payload.items, `${path}.items`, (item, itemPath) => {
        const entry = object(item, itemPath, [
          'ruleId', 'version', 'sourceRunId', 'statement', 'scope', 'actionKind', 'reason', 'status',
        ])
        return {
          ruleId: text(entry.ruleId, `${itemPath}.ruleId`),
          version: integer(entry.version, `${itemPath}.version`, 1),
          sourceRunId: text(entry.sourceRunId, `${itemPath}.sourceRunId`),
          statement: text(entry.statement, `${itemPath}.statement`),
          scope: enumeration(entry.scope, `${itemPath}.scope`, ['project', 'preset'] as const),
          actionKind: enumeration(entry.actionKind, `${itemPath}.actionKind`, [
            'communication-preference', 'planning-hint', 'quality-requirement',
          ] as const),
          reason: text(entry.reason, `${itemPath}.reason`),
          status: enumeration(entry.status, `${itemPath}.status`, ['applied', 'overridden'] as const),
        }
      })
      if (new Set(items.map(item => item.ruleId)).size !== items.length) invalid(`${path}.items`, 'rule ids must be unique')
      return { items }
    }
    case 'learning/proposed': {
      const payload = object(value, path, ['items'])
      const items = array(payload.items, `${path}.items`, (item, itemPath) => {
        const richKeys = [
          'version', 'ruleKey', 'actionKind', 'risk', 'trigger', 'sourceEvidenceIds',
          'sourceSummaryHash', 'workflowProfile',
        ] as const
        const entry = object(item, itemPath, [
          'id', 'statement', 'basis', 'proposedScope', ...richKeys, 'projectKey',
        ])
        const result: WorkflowEventPayloadMap['learning/proposed']['items'][number] = {
          id: text(entry.id, `${itemPath}.id`),
          statement: text(entry.statement, `${itemPath}.statement`),
          basis: text(entry.basis, `${itemPath}.basis`),
          proposedScope: enumeration(entry.proposedScope, `${itemPath}.proposedScope`, ['run', 'project', 'preset'] as const),
        }
        const present = richKeys.filter(key => entry[key] !== undefined)
        if (present.length !== 0 && present.length !== richKeys.length) {
          invalid(itemPath, 'versioned learning metadata must be complete')
        }
        if (present.length === 0) {
          if (entry.projectKey !== undefined) invalid(`${itemPath}.projectKey`, 'requires versioned learning metadata')
          return result
        }
        const triggerValue = object(entry.trigger, `${itemPath}.trigger`, ['mode', 'terms'])
        const mode = enumeration(triggerValue.mode, `${itemPath}.trigger.mode`, ['always', 'exact'] as const)
        const terms = strings(triggerValue.terms, `${itemPath}.trigger.terms`)
        if ((mode === 'exact' && terms.length === 0) || (mode === 'always' && terms.length !== 0)) {
          invalid(`${itemPath}.trigger.terms`, mode === 'exact' ? 'must contain at least one exact term' : 'must be empty for always')
        }
        const sourceEvidenceIds = strings(entry.sourceEvidenceIds, `${itemPath}.sourceEvidenceIds`)
        if (sourceEvidenceIds.length === 0) invalid(`${itemPath}.sourceEvidenceIds`, 'must contain source evidence')
        const sourceSummaryHash = text(entry.sourceSummaryHash, `${itemPath}.sourceSummaryHash`)
        if (!/^[a-f0-9]{64}$/u.test(sourceSummaryHash)) invalid(`${itemPath}.sourceSummaryHash`, 'must be a lowercase SHA-256 digest')
        const workflowProfile = enumeration(entry.workflowProfile, `${itemPath}.workflowProfile`, WORKFLOW_EXECUTION_PROFILES)
        const projectKey = optionalText(entry.projectKey, `${itemPath}.projectKey`)
        if (workflowProfile === 'workflow-project-pilot/1' && projectKey === undefined) {
          invalid(`${itemPath}.projectKey`, 'is required for project workflow learning')
        }
        if (workflowProfile === 'workflow-text-pilot/1' && projectKey !== undefined) {
          invalid(`${itemPath}.projectKey`, 'is not valid for text workflow learning')
        }
        return {
          ...result,
          version: integer(entry.version, `${itemPath}.version`, 1),
          ruleKey: text(entry.ruleKey, `${itemPath}.ruleKey`),
          actionKind: enumeration(entry.actionKind, `${itemPath}.actionKind`, [
            'communication-preference', 'planning-hint', 'quality-requirement',
          ] as const),
          risk: enumeration(entry.risk, `${itemPath}.risk`, ['low', 'execution-affecting'] as const),
          trigger: { mode, terms }, sourceEvidenceIds, sourceSummaryHash, workflowProfile,
          ...(projectKey === undefined ? {} : { projectKey }),
        }
      })
      if (new Set(items.map(item => item.id)).size !== items.length) invalid(`${path}.items`, 'ids must be unique')
      for (const [index, item] of items.entries()) {
        if (item.ruleKey !== undefined && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(item.ruleKey)) {
          invalid(`${path}.items[${String(index)}].ruleKey`, 'must be a stable lowercase rule key')
        }
      }
      return { items }
    }
    case 'learning/revised': {
      const payload = object(value, path, ['candidateId', 'previousStatement', 'statement', 'reason', 'attempt'])
      const previousStatement = text(payload.previousStatement, `${path}.previousStatement`)
      const statement = text(payload.statement, `${path}.statement`)
      if (previousStatement.length > 160 || statement.length > 160) invalid(path, 'learning statements must not exceed 160 characters')
      return {
        candidateId: text(payload.candidateId, `${path}.candidateId`),
        previousStatement,
        statement,
        reason: text(payload.reason, `${path}.reason`),
        attempt: integer(payload.attempt, `${path}.attempt`, 1),
      }
    }
    case 'learning/decided': {
      const payload = object(value, path, ['acceptedIds', 'rejectedIds', 'revisionRequiredIds', 'acceptedScopes', 'decisionAudit'])
      const accepted = strings(payload.acceptedIds, `${path}.acceptedIds`)
      const rejected = strings(payload.rejectedIds, `${path}.rejectedIds`)
      const revisionRequired = payload.revisionRequiredIds === undefined
        ? undefined : strings(payload.revisionRequiredIds, `${path}.revisionRequiredIds`)
      const selected = [...accepted, ...rejected, ...(revisionRequired ?? [])]
      if (new Set(selected).size !== selected.length) invalid(path, 'one learning item cannot have more than one decision')
      const acceptedScopes = payload.acceptedScopes === undefined ? undefined
        : array(payload.acceptedScopes, `${path}.acceptedScopes`, (item, itemPath) => {
          const entry = object(item, itemPath, ['id', 'scope'])
          return {
            id: text(entry.id, `${itemPath}.id`),
            scope: enumeration(entry.scope, `${itemPath}.scope`, ['project', 'preset'] as const),
          }
        })
      if (acceptedScopes && new Set(acceptedScopes.map(item => item.id)).size !== acceptedScopes.length) {
        invalid(`${path}.acceptedScopes`, 'ids must be unique')
      }
      return {
        acceptedIds: accepted,
        rejectedIds: rejected,
        ...(revisionRequired === undefined ? {} : { revisionRequiredIds: revisionRequired }),
        ...(acceptedScopes === undefined ? {} : { acceptedScopes }),
        ...(payload.decisionAudit === undefined ? {} : { decisionAudit: decisionAudit(payload.decisionAudit, `${path}.decisionAudit`) }),
      }
    }
    case 'learning/revoked': {
      const payload = object(value, path, ['ruleId', 'version', 'reason', 'decisionAudit'])
      return {
        ruleId: text(payload.ruleId, `${path}.ruleId`),
        version: integer(payload.version, `${path}.version`, 1),
        reason: text(payload.reason, `${path}.reason`),
        ...(payload.decisionAudit === undefined ? {} : { decisionAudit: decisionAudit(payload.decisionAudit, `${path}.decisionAudit`) }),
      }
    }
    case 'runtime/stall-detected': {
      const payload = object(value, path, [
        'incidentId', 'turn', 'stage', 'noProgressMs', 'journalRevision', 'attempt',
        'disposition', 'reason', 'preserved', 'resumeFrom',
      ])
      const attempt = integer(payload.attempt, `${path}.attempt`, 1)
      if (attempt > 2) invalid(`${path}.attempt`, 'must not exceed the single automatic recovery attempt')
      const disposition = enumeration(payload.disposition, `${path}.disposition`, ['auto-continue', 'needs-attention'] as const)
      if (disposition === 'auto-continue' && attempt !== 1) {
        invalid(`${path}.disposition`, 'only the first stall may auto-continue')
      }
      const preserved = strings(payload.preserved, `${path}.preserved`)
      if (preserved.length === 0) invalid(`${path}.preserved`, 'must describe what remains intact')
      return {
        incidentId: text(payload.incidentId, `${path}.incidentId`),
        turn: integer(payload.turn, `${path}.turn`, 1),
        stage: enumeration(payload.stage, `${path}.stage`, WORKFLOW_STAGES),
        noProgressMs: integer(payload.noProgressMs, `${path}.noProgressMs`, 1),
        journalRevision: integer(payload.journalRevision, `${path}.journalRevision`, 0),
        attempt,
        disposition,
        reason: text(payload.reason, `${path}.reason`),
        preserved,
        resumeFrom: text(payload.resumeFrom, `${path}.resumeFrom`),
      }
    }
    case 'runtime/recovery-settled': {
      const payload = object(value, path, ['incidentId', 'outcome', 'summary'])
      return {
        incidentId: text(payload.incidentId, `${path}.incidentId`),
        outcome: enumeration(payload.outcome, `${path}.outcome`, ['resumed', 'needs-attention'] as const),
        summary: text(payload.summary, `${path}.summary`),
      }
    }
  }
}

/** Strictly decode persisted event data before replay. */
export function parseWorkflowEventData(value: unknown, path = 'event.data'): WorkflowEventData {
  const event = object(value, path, ['version', 'runId', 'eventId', 'name', 'actor', 'correlationId', 'causationId', 'payload'])
  if (event.version !== WORKFLOW_SCHEMA_VERSION) invalid(`${path}.version`, `unsupported version ${String(event.version)}`)
  const name = enumeration(event.name, `${path}.name`, WORKFLOW_EVENT_NAMES)
  const result = {
    version: WORKFLOW_SCHEMA_VERSION,
    runId: text(event.runId, `${path}.runId`),
    eventId: text(event.eventId, `${path}.eventId`),
    name,
    actor: actor(event.actor, `${path}.actor`),
    ...(event.correlationId === undefined ? {} : { correlationId: text(event.correlationId, `${path}.correlationId`) }),
    ...(event.causationId === undefined ? {} : { causationId: text(event.causationId, `${path}.causationId`) }),
    payload: parsePayload(name, event.payload, `${path}.payload`),
  }
  return result as WorkflowEventData
}

/** Create an empty replay target for one exact run. */
export function emptyWorkflowRunState(runId: string): WorkflowRunState {
  if (runId.trim().length === 0) throw new Error('workflow run id must not be empty')
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    runId,
    currentStage: 'requirements',
    gates: {},
    records: {},
    latestVersions: {},
    tasks: {},
    assignments: {},
    commands: {},
    evidence: {},
    acceptance: {},
    checkpoints: {},
    rollbacks: [],
    staleTaskIds: [],
    staleGateIds: [],
    returns: [],
    appliedLearning: [],
    learningProposalRecorded: false,
    proposedLearning: [],
    learningRevisions: [],
    learningRevisionReadyIds: [],
    learningRevocations: [],
    manualCloseRequests: {},
    eventIds: {},
    lastSeq: -1,
    lastTime: 0,
  }
}

function latestRecord<T extends WorkflowRecord['kind']>(state: WorkflowRunState, kind: T): Extract<WorkflowRecord, { kind: T }> | undefined {
  return Object.values(state.records).find((record): record is Extract<WorkflowRecord, { kind: T }> => record.kind === kind)
}

function recalculateStaleTasks(state: WorkflowRunState): string[] {
  return currentTaskBriefs(state.records)
    .filter(task => task.data.inputs.some(ref => state.latestVersions[workflowVersionKey(ref)] !== ref.version))
    .map(task => task.recordId)
    .sort()
}

function refsAreCurrent(state: WorkflowRunState, refs: readonly VersionRef[]): boolean {
  return refs.every(ref => state.latestVersions[workflowVersionKey(ref)] === ref.version)
}

/**
 * An approved execution gate authorizes a fixed task scope plus the stable
 * requirement/design contract. The Host may subsequently add or remove only
 * runtime artifact inputs on those tasks (for verification and one bounded
 * rework), so those derived task packet versions do not invalidate the user's
 * authorization. Waiting gates and every other gate still require every exact
 * input version to remain current.
 */
function gateRefsAreCurrent(state: WorkflowRunState, gate: GateRuntimeState): boolean {
  const refs = gate.kind === 'execution' && gate.status === 'approved'
    ? gate.inputRefs.filter(input => input.kind !== 'task')
    : gate.inputRefs
  return refsAreCurrent(state, refs)
}

function recalculateStaleGates(state: WorkflowRunState): string[] {
  return Object.values(state.gates)
    .filter(gate => !gateRefsAreCurrent(state, gate))
    .map(gate => gate.gateId)
    .sort()
}

function signalGateApproved(state: WorkflowRunState): boolean {
  return Object.values(state.gates).some(gate => gate.kind === 'signal'
    && gate.status === 'approved'
    && refsAreCurrent(state, gate.inputRefs))
}

function projectPlanningSignalApproved(state: WorkflowRunState, taskId: string): boolean {
  return Object.values(state.gates).some(gate => gate.kind === 'signal'
    && gate.status === 'approved'
    && gate.scopeTaskIds.includes(taskId)
    && refsAreCurrent(state, gate.inputRefs))
}

function executionGateApproved(state: WorkflowRunState, taskId: string): boolean {
  return Object.values(state.gates).some(gate => gate.kind === 'execution'
    && gate.status === 'approved'
    && gate.scopeTaskIds.includes(taskId)
    && gateRefsAreCurrent(state, gate))
}

/**
 * Compatibility for project runs committed before the execution-gate split.
 * Their one Signal Gate explicitly scoped every executable task. A new
 * layered requirement gate scopes only the architect, so it cannot satisfy
 * this predicate for implementation or downstream roles.
 */
function legacyProjectSignalExecutionApproved(state: WorkflowRunState, taskId: string): boolean {
  return Object.values(state.gates).some(gate => gate.kind === 'signal'
    && gate.status === 'approved'
    && gate.scopeTaskIds.includes(taskId)
    && refsAreCurrent(state, gate.inputRefs))
}

function actionGateApproved(state: WorkflowRunState, taskId: string): boolean {
  return Object.values(state.gates).some(gate => gate.kind === 'action'
    && gate.status === 'approved'
    && gate.scopeTaskIds.includes(taskId)
    && refsAreCurrent(state, gate.inputRefs))
}

function expectedActorMatches(required: GateRuntimeState['requiredActor'], value: WorkflowActor): boolean {
  if (required === 'user') return value.kind === 'user'
  if (required === 'pm') return value.kind === 'pm'
  return value.kind === 'agent' && value.role === 'acceptance_qa'
}

function assertDecisionAudit(value: WorkflowDecisionAudit | undefined, actorValue: WorkflowActor): void {
  if (value === undefined) return // Compatibility with records written before decision provenance shipped.
  if (actorValue.kind !== 'user' || actorValue.id !== `native-question:${value.requestId}`) {
    throw new Error('native decision audit must match its user-authority question actor')
  }
}

function verifierMatchesActor(
  verifier: AcceptanceBrief['data']['criteria'][number]['verifier'],
  value: WorkflowActor,
): boolean {
  if (verifier === 'user') return value.kind === 'user'
  if (verifier === 'pm') return value.kind === 'pm'
  return value.kind === 'agent' && value.role === verifier
}

function assertSignalContract(state: WorkflowRunState): void {
  const requirement = latestRecord(state, 'requirement')
  const acceptance = latestRecord(state, 'acceptance')
  if (requirement === undefined || acceptance === undefined) {
    throw new Error('Signal Gate cannot open without requirement and acceptance snapshots')
  }
  const unresolved = requirement.data.questions.filter(question => question.material && question.status === 'open')
  if (unresolved.length > 0) throw new Error(`Signal Gate has unresolved material questions: ${unresolved.map(item => item.id).join(', ')}`)
  const criteria = new Set(acceptance.data.criteria.map(item => item.id))
  const missing = requirement.data.acceptanceIds.filter(id => !criteria.has(id))
  if (missing.length > 0) throw new Error(`Signal Gate references missing acceptance criteria: ${missing.join(', ')}`)
}

function assertExecutionContract(state: WorkflowRunState, gate: GateRuntimeState): void {
  assertSignalContract(state)
  const architecture = currentTaskBriefs(state.records).find(task => task.data.role === 'architect')
  if (architecture === undefined) return
  if (!projectPlanningSignalApproved(state, architecture.recordId)) throw new Error('layered execution requires a requirement Signal Gate scoped to read-only planning')
  if (state.tasks[architecture.recordId]?.status !== 'completed') throw new Error('layered execution requires completed read-only planning')
  const design = latestRecord(state, 'design')
  if (design === undefined || !gate.inputRefs.some(input => input.kind === 'design'
    && input.recordId === design.recordId && input.version === design.version)) {
    throw new Error('layered execution gate must bind the current design')
  }
}

function assertGateInputs(state: WorkflowRunState, gate: WorkflowEventPayloadMap['gate/requested']): void {
  if (!refsAreCurrent(state, gate.inputRefs)) throw new Error(`workflow gate ${gate.gateId} references a stale or missing input`)
  if (gate.kind === 'signal') {
    const requirement = latestRecord(state, 'requirement')
    const acceptance = latestRecord(state, 'acceptance')
    if (requirement === undefined || acceptance === undefined) throw new Error('Signal Gate requires current requirement and acceptance snapshots')
    const actual = new Set(gate.inputRefs.map(workflowVersionKey))
    if (!actual.has(workflowVersionKey(requirement)) || !actual.has(workflowVersionKey(acceptance))) {
      throw new Error('Signal Gate must bind the current requirement and acceptance versions')
    }
  }
  if (gate.kind === 'execution') {
    const requirement = latestRecord(state, 'requirement')
    const acceptance = latestRecord(state, 'acceptance')
    if (requirement === undefined || acceptance === undefined) throw new Error('execution gate requires current requirement and acceptance snapshots')
    const actual = new Set(gate.inputRefs.map(workflowVersionKey))
    if (!actual.has(workflowVersionKey(requirement)) || !actual.has(workflowVersionKey(acceptance))) {
      throw new Error('execution gate must bind the current requirement and acceptance versions')
    }
  }
  if (gate.kind === 'execution' || gate.kind === 'action' || gate.kind === 'rollback' || gate.kind === 'runtime-recovery') {
    if (gate.scopeTaskIds.length === 0) throw new Error(`action gate ${gate.gateId} must name its affected tasks`)
    for (const taskId of gate.scopeTaskIds) {
      const brief = taskBrief(state, taskId)
      if (!gate.inputRefs.some(ref => ref.kind === 'task' && ref.recordId === taskId && ref.version === brief.version)) {
        throw new Error(`action gate ${gate.gateId} must bind current task ${taskId}`)
      }
    }
  }
}

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['ready', 'cancelled', 'invalidated'],
  ready: ['running', 'blocked', 'cancelled', 'invalidated'],
  running: ['completed', 'failed', 'blocked', 'cancelled', 'invalidated'],
  blocked: ['ready', 'cancelled', 'invalidated'],
  completed: ['invalidated'],
  failed: ['ready', 'cancelled', 'invalidated'],
  cancelled: [],
  invalidated: ['ready', 'cancelled'],
}

function taskBrief(state: WorkflowRunState, taskId: string): TaskBrief {
  const value = state.records[workflowVersionKey({ kind: 'task', recordId: taskId })]
  if (value?.kind !== 'task') throw new Error(`workflow task ${taskId} has no current brief`)
  return value
}

export function assertTaskMayExecute(state: WorkflowRunState, brief: TaskBrief): void {
  if (state.staleTaskIds.includes(brief.recordId)) throw new Error(`workflow task ${brief.recordId} has stale inputs`)
  const projectTask = brief.data.outputContract.reportSchema === PROJECT_PILOT
  if (projectTask && brief.data.role === 'architect' && !projectPlanningSignalApproved(state, brief.recordId)) {
    throw new Error(`workflow planning task ${brief.recordId} cannot start before requirement Signal Gate approval`)
  }
  if (projectTask && brief.data.role !== 'architect'
    && !executionGateApproved(state, brief.recordId)
    && !legacyProjectSignalExecutionApproved(state, brief.recordId)) {
    throw new Error(`workflow project task ${brief.recordId} cannot start before execution gate approval`)
  }
  if (!projectTask && brief.data.stage !== 'requirements' && !signalGateApproved(state)) {
    throw new Error(`workflow task ${brief.recordId} cannot start before Signal Gate approval`)
  }
  if (state.risk === undefined) throw new Error(`workflow task ${brief.recordId} cannot start before risk classification`)
  if (WORKFLOW_RISK_LEVELS.indexOf(state.risk.level) < WORKFLOW_RISK_LEVELS.indexOf(brief.data.riskLevel)) {
    throw new Error(`workflow task ${brief.recordId} exceeds the run risk classification`)
  }
  if (brief.data.requiresActionGate && !state.risk.actionGateRequired) {
    throw new Error(`workflow task ${brief.recordId} requires X-action classification`)
  }
  if (brief.data.requiresActionGate && !actionGateApproved(state, brief.recordId)) {
    throw new Error(`workflow task ${brief.recordId} requires an approved action gate`)
  }
  const blocked = brief.data.dependsOn.filter(id => state.tasks[id]?.status !== 'completed')
  if (blocked.length > 0) throw new Error(`workflow task ${brief.recordId} is blocked by ${blocked.join(', ')}`)
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index])
}

/** Calculate the hard acceptance result without optimistic prose parsing. */
export function summarizeAcceptanceLedger(
  brief: AcceptanceBrief | undefined,
  results: Readonly<Record<string, AcceptanceResult>>,
): AcceptanceLedgerSummary {
  if (brief === undefined) return { pass: 0, fail: 0, waived: 0, pending: 0, hardOutcome: 'PENDING' }
  let pass = 0
  let fail = 0
  let waived = 0
  let pending = 0
  for (const criterion of brief.data.criteria.filter(item => item.criticality === 'hard')) {
    const result = results[criterion.id]
    if (result === undefined || result.briefVersion !== brief.version) pending += 1
    else if (result.status === 'PASS') pass += 1
    else if (result.status === 'FAIL') fail += 1
    else waived += 1
  }
  const hardOutcome = fail > 0 ? 'FAIL' : pending > 0 ? 'PENDING' : waived > 0 ? 'QUALIFIED' : 'PASS'
  return { pass, fail, waived, pending, hardOutcome }
}

function assertOutcome(state: WorkflowRunState, payload: WorkflowEventPayloadMap['outcome/declared']): void {
  if (state.outcome !== undefined) throw new Error('workflow outcome is already declared')
  if ((payload.outcome === 'ABANDONED') !== (state.manualClose !== undefined)) {
    throw new Error('ABANDONED requires an audited manual closure; it cannot attest cancellation or delivery')
  }
  if (payload.outcome !== 'ABANDONED'
    && (Object.values(state.commands).some(command => ['running', 'unknown'].includes(command.status))
      || Object.values(state.assignments).some(agent => agent.runtimeIssue && agent.runtimeIssue.status !== 'stopped'))) {
    throw new Error('unresolved runtime ranges require exit evidence or audited administrative closure')
  }
  const actual = summarizeAcceptanceLedger(latestRecord(state, 'acceptance'), state.acceptance)
  if (JSON.stringify(actual) !== JSON.stringify(payload.ledger)) throw new Error('declared acceptance ledger does not match replayed evidence')
  if (payload.outcome === 'PASS' && actual.hardOutcome !== 'PASS') throw new Error('PASS requires every hard criterion to be PASS')
  if (payload.outcome === 'QUALIFIED' && actual.hardOutcome !== 'QUALIFIED') throw new Error('QUALIFIED requires at least one approved WAIVED criterion and no hard failure')
  if ((payload.outcome === 'PASS' || payload.outcome === 'QUALIFIED') && state.staleTaskIds.length > 0) {
    throw new Error(`cannot deliver with stale tasks: ${state.staleTaskIds.join(', ')}`)
  }
  if (payload.outcome === 'PASS' || payload.outcome === 'QUALIFIED') {
    const incomplete = Object.entries(state.tasks).filter(([, task]) => task.status !== 'completed').map(([id]) => id)
    if (incomplete.length > 0) throw new Error(`cannot deliver with incomplete tasks: ${incomplete.join(', ')}`)
  }
}

function publishRecord(state: MutableWorkflowRunState, record: WorkflowRecord): void {
  if (record.runId !== state.runId) throw new Error(`record ${record.recordId} belongs to another workflow run`)
  if (record.kind === 'requirement' || record.kind === 'design' || record.kind === 'acceptance') {
    const conflicting = Object.values(state.records).find(item => item.kind === record.kind && item.recordId !== record.recordId)
    if (conflicting !== undefined) throw new Error(`workflow run already has canonical ${record.kind} record ${conflicting.recordId}`)
  }
  const key = workflowVersionKey(record)
  const prior = state.records[key]
  const expectedVersion = (prior?.version ?? 0) + 1
  if (record.version !== expectedVersion) {
    throw new Error(`record ${key} expected version ${String(expectedVersion)}, got ${String(record.version)}`)
  }
  if (record.kind === 'task') {
    for (const input of record.data.inputs) {
      if (state.latestVersions[workflowVersionKey(input)] !== input.version) {
        throw new Error(`task ${record.recordId} input ${workflowVersionKey(input)}@${String(input.version)} is not current`)
      }
    }
    const criteria = latestRecord(state, 'acceptance')?.data.criteria.map(item => item.id) ?? []
    const missingCriteria = record.data.acceptanceIds.filter(id => !criteria.includes(id))
    if (missingCriteria.length > 0) throw new Error(`task ${record.recordId} references missing acceptance criteria: ${missingCriteria.join(', ')}`)
    if (prior?.kind === 'task' && executionGateApproved(state, record.recordId)) {
      const { inputs: _priorInputs, ...priorAuthorization } = prior.data
      const { inputs: _nextInputs, ...nextAuthorization } = record.data
      if (JSON.stringify(priorAuthorization) !== JSON.stringify(nextAuthorization)) {
        throw new Error(`task ${record.recordId} cannot change its authorized scope after execution approval`)
      }
    }
  }
  state.records = { ...state.records, [key]: record }
  state.latestVersions = { ...state.latestVersions, [key]: record.version }
  if (record.kind === 'task') {
    // A revised assignment needs fresh verification. Keep the old evidence in
    // history, but do not display its verdict as acceptance of the new work.
    const invalidatedCriteria = new Set(record.data.acceptanceIds)
    state.acceptance = Object.fromEntries(Object.entries(state.acceptance).filter(([id]) => !invalidatedCriteria.has(id)))
    state.tasks = {
      ...state.tasks,
      [record.recordId]: { briefVersion: record.version, status: 'pending', reason: record.version === 1 ? 'task published' : 'task packet revised' },
    }
    planTaskWaves(currentTaskBriefs(state.records))
  }
  state.staleTaskIds = recalculateStaleTasks(state)
  state.staleGateIds = recalculateStaleGates(state)
}

/** Apply one committed plugin Journal event to a single-run projection. */
export function applyWorkflowStoredEvent(state: WorkflowRunState, candidate: unknown): WorkflowRunState {
  if (candidate === null || typeof candidate !== 'object' || (candidate as UnknownRecord).type !== WORKFLOW_SESSION_EVENT_TYPE) return state
  const outer = candidate as UnknownRecord
  const seq = integer(outer.seq, 'event.seq')
  const time = integer(outer.time, 'event.time')
  if (outer.data === null || typeof outer.data !== 'object' || Array.isArray(outer.data)) invalid('event.data', 'must be an object')
  const selectedRunId = text((outer.data as UnknownRecord).runId, 'event.data.runId')
  if (selectedRunId !== state.runId) return state
  const event = parseWorkflowEventData(outer.data)
  if (seq <= state.lastSeq) throw new Error(`workflow event seq ${String(seq)} is not after ${String(state.lastSeq)}`)
  if (state.eventIds[event.eventId] === true) throw new Error(`workflow event id ${event.eventId} is duplicated`)
  if (state.created === undefined && event.name !== 'run/created') throw new Error('workflow run must begin with run/created')
  const terminalExtension = event.name === 'learning/proposed' || event.name === 'learning/revised' || event.name === 'learning/decided'
    || event.name === 'learning/revoked'
    || event.name === 'runtime/stall-detected' || event.name === 'runtime/recovery-settled'
    || event.name === 'agent/runtime-interrupted'
    || event.name === 'command/finished'
    || (event.name === 'gate/requested' && event.payload.kind === 'rollback')
    || (event.name === 'gate/decided' && state.gates[event.payload.gateId]?.kind === 'rollback')
    || event.name === 'rollback/applied'
    || event.name === 'rollback/prepared' || event.name === 'rollback/interrupted' || event.name === 'rollback/cleaned'
  if (state.outcome !== undefined && !terminalExtension) {
    throw new Error(`workflow run is terminal after ${state.outcome.outcome}`)
  }
  if (state.manualClose && !state.outcome && event.name !== 'outcome/declared') {
    throw new Error('manual closure must immediately declare its ABANDONED outcome')
  }
  if (state.rollbackTransaction && state.rollbackTransaction.phase !== 'cleaned'
    && !event.name.startsWith('rollback/') && !event.name.startsWith('runtime/')
    && event.name !== 'agent/runtime-interrupted' && event.name !== 'command/finished'
    && !(event.name === 'gate/requested' && event.payload.kind === 'rollback')
    && !(event.name === 'gate/decided' && state.gates[event.payload.gateId]?.kind === 'rollback')) {
    throw new Error('unfinished file rollback must be resolved before other workflow changes')
  }

  const next = structuredClone(state) as MutableWorkflowRunState
  next.eventIds = { ...next.eventIds, [event.eventId]: true }
  next.lastSeq = seq
  next.lastTime = time

  switch (event.name) {
    case 'run/created':
      if (next.created !== undefined) throw new Error('workflow run/created may occur only once')
      next.created = event.payload
      break
    case 'risk/classified':
      if (next.risk !== undefined) {
        if (WORKFLOW_RISK_LEVELS.indexOf(event.payload.level) < WORKFLOW_RISK_LEVELS.indexOf(next.risk.level)) {
          throw new Error(`workflow risk cannot be silently downgraded from ${next.risk.level} to ${event.payload.level}`)
        }
        if (next.risk.actionGateRequired && !event.payload.actionGateRequired) {
          throw new Error('workflow X-action classification cannot be silently removed')
        }
        const removedActions = next.risk.actionTypes.filter(action => !event.payload.actionTypes.includes(action))
        if (removedActions.length > 0) throw new Error(`workflow X-action types cannot be silently removed: ${removedActions.join(', ')}`)
      }
      next.risk = event.payload
      break
    case 'gate/requested':
      if (next.gates[event.payload.gateId] !== undefined) throw new Error(`workflow gate ${event.payload.gateId} already exists`)
      if (event.payload.kind === 'rollback' && (next.outcome === undefined || event.payload.requiredActor !== 'user')) {
        throw new Error('workspace rollback gates require a terminal workflow and a real user decision')
      }
      if (event.payload.kind === 'runtime-recovery' && event.payload.requiredActor !== 'user') {
        throw new Error('manual runtime closure requires native user authority')
      }
      assertGateInputs(next, event.payload)
      next.gates = { ...next.gates, [event.payload.gateId]: { ...event.payload, status: 'waiting' } }
      next.staleGateIds = recalculateStaleGates(next)
      next.currentStage = event.payload.stage
      break
    case 'gate/decided': {
      const gate = next.gates[event.payload.gateId]
      if (gate === undefined) throw new Error(`workflow gate ${event.payload.gateId} was not requested`)
      if (gate.status !== 'waiting') throw new Error(`workflow gate ${event.payload.gateId} is already ${gate.status}`)
      // Runtime teardown may close an abandoned question, but can never grant
      // permission or impersonate its human answerer. Stale gates may only close.
      const runtimeCancellation = event.payload.decision === 'cancelled' && event.actor.kind === 'system'
      assertDecisionAudit(event.payload.decisionAudit, event.actor)
      if (gate.kind === 'runtime-recovery' && event.payload.decision === 'approved') {
        const request = state.manualCloseRequests[gate.gateId]
        if (!request || request.requestedAtSeq !== state.lastSeq || event.payload.decisionAudit?.requestId !== gate.gateId) {
          throw new Error('manual closure requires a fresh exact native question audit')
        }
        assertManualCloseScope(state, request)
      }
      if (!runtimeCancellation && !refsAreCurrent(next, gate.inputRefs)) throw new Error(`workflow gate ${event.payload.gateId} became stale before the decision`)
      if (!runtimeCancellation && !expectedActorMatches(gate.requiredActor, event.actor)) throw new Error(`workflow gate ${event.payload.gateId} requires ${gate.requiredActor}`)
      if (gate.kind === 'signal' && event.payload.decision === 'approved') assertSignalContract(next)
      if (gate.kind === 'execution' && event.payload.decision === 'approved') assertExecutionContract(next, gate)
      next.gates = {
        ...next.gates,
        [gate.gateId]: {
          ...gate,
          status: event.payload.decision === 'approved' ? 'approved' : event.payload.decision,
          decidedBy: event.actor,
          ...(event.payload.decisionAudit === undefined ? {} : { decisionAudit: event.payload.decisionAudit }),
          reason: event.payload.reason,
        },
      }
      break
    }
    case 'record/published':
      publishRecord(next, event.payload.record)
      break
    case 'task/status-changed': {
      const task = next.tasks[event.payload.taskId]
      const brief = taskBrief(next, event.payload.taskId)
      if (task === undefined) throw new Error(`workflow task ${event.payload.taskId} has no runtime state`)
      if (brief.version !== event.payload.taskVersion || task.briefVersion !== event.payload.taskVersion) throw new Error(`workflow task ${event.payload.taskId} packet version is stale`)
      if (task.status !== event.payload.expectedStatus) throw new Error(`workflow task ${event.payload.taskId} expected status ${event.payload.expectedStatus}, actual ${task.status}`)
      if (!TASK_TRANSITIONS[task.status].includes(event.payload.status)) throw new Error(`workflow task ${event.payload.taskId} cannot move from ${task.status} to ${event.payload.status}`)
      if ((event.payload.status === 'ready' || event.payload.status === 'running') && next.staleTaskIds.includes(event.payload.taskId)) {
        throw new Error(`workflow task ${event.payload.taskId} has stale inputs`)
      }
      if (event.payload.status === 'running') assertTaskMayExecute(next, brief)
      next.tasks = { ...next.tasks, [event.payload.taskId]: { briefVersion: task.briefVersion, status: event.payload.status, reason: event.payload.reason } }
      next.currentStage = brief.data.stage
      break
    }
    case 'agent/assigned': {
      if (next.assignments[event.payload.assignmentId] !== undefined) throw new Error(`workflow assignment ${event.payload.assignmentId} already exists`)
      if (Object.values(next.assignments).some(item => item.agentSessionId === event.payload.agentSessionId)) throw new Error(`workflow agent ${event.payload.agentSessionId} is already assigned`)
      const brief = taskBrief(next, event.payload.taskId)
      if (brief.version !== event.payload.taskVersion) throw new Error(`workflow assignment ${event.payload.assignmentId} uses a stale task packet`)
      assertTaskMayExecute(next, brief)
      if (next.tasks[event.payload.taskId]?.status === 'completed' || next.tasks[event.payload.taskId]?.status === 'cancelled') {
        throw new Error(`workflow assignment ${event.payload.assignmentId} targets a terminal task`)
      }
      if (brief.data.role !== event.payload.role) throw new Error(`workflow assignment ${event.payload.assignmentId} violates task role isolation`)
      if (brief.data.lifecycle !== event.payload.lifecycle) throw new Error(`workflow assignment ${event.payload.assignmentId} violates task lifecycle`)
      if (!event.payload.contextDomains.every(domain => brief.data.contextDomains.includes(domain))) throw new Error(`workflow assignment ${event.payload.assignmentId} exceeds its context domains`)
      next.assignments = { ...next.assignments, [event.payload.assignmentId]: { ...event.payload, status: 'running' } }
      break
    }
    case 'agent/resumed': {
      const assignment = next.assignments[event.payload.assignmentId]
      if (assignment === undefined) throw new Error(`workflow assignment ${event.payload.assignmentId} does not exist`)
      if (assignment.runtimeIssue) throw new Error('interrupted runtime lease requires explicit recovery, not automatic resume')
      if (assignment.lifecycle !== 'continuable') throw new Error(`workflow assignment ${event.payload.assignmentId} is one-shot and cannot resume`)
      if (!['idle', 'failed', 'interrupted'].includes(assignment.status)) throw new Error(`workflow assignment ${event.payload.assignmentId} is not resumable from ${assignment.status}`)
      const brief = taskBrief(next, assignment.taskId)
      if (brief.version !== event.payload.taskVersion) throw new Error(`workflow assignment ${event.payload.assignmentId} resume packet is stale`)
      assertTaskMayExecute(next, brief)
      if (brief.data.role !== assignment.role || !sameSet(brief.data.contextDomains, assignment.contextDomains)) {
        throw new Error(`workflow assignment ${event.payload.assignmentId} cannot cross role or context domain boundaries`)
      }
      next.assignments = { ...next.assignments, [event.payload.assignmentId]: { ...assignment, taskVersion: event.payload.taskVersion, status: 'running' } }
      break
    }
    case 'agent/settled': {
      const assignment = next.assignments[event.payload.assignmentId]
      if (assignment === undefined) throw new Error(`workflow assignment ${event.payload.assignmentId} does not exist`)
      if (assignment.runtimeIssue) throw new Error('runtime interruption must be settled through its exact incident')
      if (Object.values(next.commands).some(command => command.assignmentId === assignment.assignmentId && command.status !== 'completed')) throw new Error('native Agent settlement is not command exit evidence')
      if (assignment.status !== 'running') throw new Error(`workflow assignment ${event.payload.assignmentId} is not running`)
      const status = event.payload.outcome === 'completed'
        ? assignment.lifecycle === 'continuable' ? 'idle' : 'completed'
        : event.payload.outcome
      next.assignments = { ...next.assignments, [event.payload.assignmentId]: { ...assignment, status, lastSummary: event.payload.summary } }
      break
    }
    case 'command/started': {
      if (event.actor.kind !== 'system') throw new Error('only the Host may attest a command start')
      const command = event.payload
      const assignment = next.assignments[command.assignmentId]
      if (!assignment || assignment.status !== 'running' || assignment.runtimeIssue || assignment.taskVersion !== command.taskVersion) throw new Error('command has no current running assignment')
      if (!['test_engineer', 'acceptance_qa'].includes(assignment.role)) throw new Error('this role cannot run frozen commands')
      if (next.commands[command.commandId] || Object.values(next.commands).some(item => item.assignmentId === command.assignmentId && ['running', 'unknown'].includes(item.status))) throw new Error('duplicate or unresolved command execution')
      next.commands = { ...next.commands, [command.commandId]: { ...command, status: 'running' } }
      break
    }
    case 'command/finished': {
      if (event.actor.kind !== 'system') throw new Error('only the Host may attest command exit')
      const command = next.commands[event.payload.commandId]
      if (!command || command.status !== 'running') throw new Error('command exit must settle its exact running execution once')
      next.commands = { ...next.commands, [command.commandId]: { ...command, status: event.payload.status, observation: event.payload } }
      break
    }
    case 'agent/runtime-interrupted': {
      if (event.actor.kind !== 'system') throw new Error('only the Host may attest a child runtime interruption')
      const issue = event.payload
      const assignment = next.assignments[issue.assignmentId]
      if (!assignment || assignment.taskVersion !== issue.taskVersion) throw new Error('child runtime incident has a stale assignment version')
      const prior = assignment.runtimeIssue
      if (issue.status === 'stopped' && Object.values(next.commands).some(command => command.assignmentId === issue.assignmentId && ['running', 'unknown'].includes(command.status))) throw new Error('Agent stop cannot attest an unresolved command range')
      if (prior) {
        if (prior.incidentId !== issue.incidentId || prior.cause !== issue.cause || prior.budgetMs !== issue.budgetMs || prior.elapsedMs !== issue.elapsedMs) throw new Error('child runtime incident identity cannot change')
        if (prior.status === 'stopped' || issue.status === 'stopping' || prior.status === issue.status) throw new Error('child runtime incident transition is not monotonic')
      } else if (assignment.status !== 'running' || issue.status === 'stopped') {
        throw new Error('child runtime interruption must begin on a running assignment without claiming a stop')
      }
      next.assignments = { ...next.assignments, [issue.assignmentId]: {
        ...assignment, runtimeIssue: issue, status: issue.status === 'stopped' ? 'interrupted' : assignment.status, lastSummary: issue.reason,
      } }
      // A runtime failure is not a business FAIL and consumes no rework budget.
      const task = next.tasks[assignment.taskId]
      if (!next.outcome && task?.briefVersion === issue.taskVersion && ['running', 'completed', 'blocked', 'invalidated'].includes(task.status)) {
        next.tasks = { ...next.tasks, [assignment.taskId]: { ...task,
          status: task.status === 'running' ? 'blocked' : task.status === 'completed' ? 'invalidated' : task.status, reason: issue.reason,
        } }
      }
      break
    }
    case 'runtime/manual-close-requested': {
      const request = event.payload
      const gate = state.gates[request.gateId]
      if (event.actor.kind !== 'pm' || state.manualCloseRequests[request.gateId]
        || gate?.kind !== 'runtime-recovery' || gate.status !== 'waiting' || gate.requiredActor !== 'user') {
        throw new Error('manual closure proposal requires a new waiting native recovery gate')
      }
      assertManualCloseScope(state, request)
      const taskIds = [...new Set(request.checks.map(item => state.assignments[item.assignmentId]!.taskId))]
      if (!sameSet(taskIds, gate.scopeTaskIds)) throw new Error('manual closure gate must cover every affected task')
      next.manualCloseRequests = { ...next.manualCloseRequests, [request.gateId]: { ...request, requestedAtSeq: seq } }
      break
    }
    case 'runtime/manual-close-recorded': {
      const gate = state.gates[event.payload.gateId]
      const request = state.manualCloseRequests[event.payload.gateId]
      if (event.actor.kind !== 'system' || !request || request.requestedAtSeq + 1 !== state.lastSeq
        || gate?.kind !== 'runtime-recovery' || gate.status !== 'approved'
        || gate.decisionAudit?.requestId !== gate.gateId || gate.decidedBy?.kind !== 'user') {
        throw new Error('manual closure requires its immediately preceding native approval')
      }
      assertManualCloseScope(state, request)
      next.manualClose = { gateId: gate.gateId, recordedAt: time, decisionAudit: gate.decisionAudit }
      // Do not rewrite assignments, command observations, task or acceptance evidence.
      break
    }
    case 'evidence/recorded':
      if (next.evidence[event.payload.evidence.evidenceId] !== undefined) throw new Error(`workflow evidence ${event.payload.evidence.evidenceId} already exists`)
      for (const ref of event.payload.evidence.artifactRefs) {
        if (next.latestVersions[workflowVersionKey(ref)] !== ref.version) throw new Error(`workflow evidence references stale artifact ${workflowVersionKey(ref)}`)
      }
      next.evidence = { ...next.evidence, [event.payload.evidence.evidenceId]: event.payload.evidence }
      break
    case 'acceptance/recorded': {
      const brief = latestRecord(next, 'acceptance')
      if (brief === undefined) throw new Error('workflow acceptance brief does not exist')
      const criterion = brief.data.criteria.find(item => item.id === event.payload.result.criterionId)
      if (criterion === undefined) {
        throw new Error(`workflow acceptance criterion ${event.payload.result.criterionId} does not exist`)
      }
      if (event.payload.result.briefVersion !== brief.version) throw new Error(`workflow acceptance criterion ${criterion.id} uses a stale AcceptanceBrief`)
      if (event.payload.result.status === 'WAIVED' && event.actor.kind !== 'user') throw new Error('WAIVED acceptance must be recorded from an explicit user decision')
      if (event.payload.result.status !== 'WAIVED' && !verifierMatchesActor(criterion.verifier, event.actor)) {
        throw new Error(`workflow acceptance criterion ${criterion.id} requires verifier ${criterion.verifier}`)
      }
      const missingEvidence = event.payload.result.evidenceIds.filter(id => next.evidence[id] === undefined)
      if (missingEvidence.length > 0) throw new Error(`workflow acceptance references missing evidence: ${missingEvidence.join(', ')}`)
      const verdicts = event.payload.result.evidenceIds.map(id => next.evidence[id]?.verdict)
      if (event.payload.result.status === 'PASS' && !verdicts.includes('pass')) throw new Error(`workflow acceptance PASS for ${criterion.id} requires passing evidence`)
      if (event.payload.result.status === 'FAIL' && !verdicts.includes('fail')) throw new Error(`workflow acceptance FAIL for ${criterion.id} requires failing evidence`)
      next.acceptance = { ...next.acceptance, [event.payload.result.criterionId]: event.payload.result }
      break
    }
    case 'checkpoint/file-captured': {
      if (event.actor.kind !== 'system') throw new Error('workspace checkpoints may only be recorded by the Host controller')
      const brief = taskBrief(next, event.payload.taskId)
      if (brief.version !== event.payload.taskVersion || brief.data.role !== 'engineer'
        || next.tasks[event.payload.taskId]?.status !== 'running') {
        throw new Error(`checkpoint ${event.payload.checkpointId} does not match a running engineer task`)
      }
      const prior = next.checkpoints[event.payload.checkpointId]
      if (prior && (prior.taskId !== event.payload.taskId || prior.taskVersion !== event.payload.taskVersion)) {
        throw new Error(`checkpoint ${event.payload.checkpointId} is already bound to another task packet`)
      }
      if (next.rollbacks.some(item => item.checkpointId === event.payload.checkpointId)) {
        throw new Error(`checkpoint ${event.payload.checkpointId} is already rolled back`)
      }
      const key = event.payload.path.toLocaleLowerCase('en-US')
      if (prior?.files[key]) throw new Error(`checkpoint ${event.payload.checkpointId} already captured ${event.payload.path}`)
      const checkpoint: WorkflowCheckpointState = prior ?? {
        checkpointId: event.payload.checkpointId,
        taskId: event.payload.taskId,
        taskVersion: event.payload.taskVersion,
        files: {},
      }
      next.checkpoints = {
        ...next.checkpoints,
        [checkpoint.checkpointId]: {
          ...checkpoint,
          files: { ...checkpoint.files, [key]: { path: event.payload.path, before: event.payload.before, after: event.payload.before } },
        },
      }
      break
    }
    case 'checkpoint/file-observed': {
      if (event.actor.kind !== 'system') throw new Error('workspace checkpoint observations may only be recorded by the Host controller')
      const checkpoint = next.checkpoints[event.payload.checkpointId]
      const key = event.payload.path.toLocaleLowerCase('en-US')
      const file = checkpoint?.files[key]
      if (!checkpoint || !file || file.path !== event.payload.path) throw new Error(`checkpoint file is not captured: ${event.payload.path}`)
      if (next.rollbacks.some(item => item.checkpointId === checkpoint.checkpointId)) throw new Error(`checkpoint ${checkpoint.checkpointId} is already rolled back`)
      if (!sameWorkflowFileState(file.after, event.payload.expectedBefore)) {
        throw new Error(`checkpoint file changed without the expected state: ${event.payload.path}`)
      }
      next.checkpoints = {
        ...next.checkpoints,
        [checkpoint.checkpointId]: {
          ...checkpoint,
          files: { ...checkpoint.files, [key]: { ...file, after: event.payload.after } },
        },
      }
      break
    }
    case 'return/routed':
      if (event.payload.responsibleTaskId !== undefined && next.tasks[event.payload.responsibleTaskId] === undefined) throw new Error(`workflow return references missing task ${event.payload.responsibleTaskId}`)
      next.returns = [...next.returns, event.payload]
      next.currentStage = event.payload.toStage
      break
    case 'outcome/declared':
      assertOutcome(next, event.payload)
      next.outcome = event.payload
      next.currentStage = 'delivery'
      break
    case 'rollback/prepared':
    case 'rollback/applied': {
      if (event.actor.kind !== 'system') throw new Error('workspace rollback application may only be recorded by the Host controller')
      if (next.outcome === undefined) throw new Error('workspace rollback requires a terminal workflow; stop an active run first')
      if (next.rollbacks.some(item => item.rollbackId === event.payload.rollbackId
        || item.checkpointId === event.payload.checkpointId)) throw new Error('workspace rollback was already applied')
      const checkpoint = next.checkpoints[event.payload.checkpointId]
      if (!checkpoint) throw new Error(`workspace checkpoint does not exist: ${event.payload.checkpointId}`)
      const gate = next.gates[event.payload.gateId]
      if (!gate || gate.kind !== 'rollback' || gate.status !== 'approved' || gate.decidedBy?.kind !== 'user'
        || !gate.scopeTaskIds.includes(checkpoint.taskId)) {
        throw new Error('workspace rollback requires its matching approved user gate')
      }
      const newer = Object.values(next.checkpoints).filter(item => item.taskId === checkpoint.taskId
        && item.taskVersion > checkpoint.taskVersion
        && !next.rollbacks.some(rollback => rollback.checkpointId === item.checkpointId)
        && Object.values(item.files).some(file => !sameWorkflowFileState(file.before, file.after)))
      if (newer.length) throw new Error('workspace checkpoints must be rolled back newest first')
      const changed = Object.values(checkpoint.files).filter(file => !sameWorkflowFileState(file.before, file.after))
      const expected = changed.map(file => ({
        path: file.path,
        action: file.before.kind === 'absent' ? 'remove' as const : 'restore' as const,
      }))
      if (!sameSet(expected.map(item => `${item.path.toLocaleLowerCase('en-US')}:${item.action}`),
        event.payload.files.map(item => `${item.path.toLocaleLowerCase('en-US')}:${item.action}`))) {
        throw new Error('workspace rollback file list does not match the checkpoint')
      }
      const transaction = next.rollbackTransaction
      if (event.name === 'rollback/prepared') {
        if (!gate.decisionAudit || gate.decisionAudit.requestId !== gate.gateId) throw new Error('durable rollback requires native decision audit')
        if (transaction && transaction.phase !== 'cleaned') {
          if (transaction.phase === 'applied' || transaction.rollbackId !== event.payload.rollbackId
            || transaction.checkpointId !== event.payload.checkpointId || transaction.gateId === event.payload.gateId) {
            throw new Error('unfinished rollback requires the same transaction and a fresh user gate')
          }
        } else if (transaction?.rollbackId === event.payload.rollbackId) throw new Error('rollback transaction id cannot be reused')
        next.rollbackTransaction = { ...event.payload, phase: 'prepared' }
        break
      }
      if (transaction && transaction.phase !== 'cleaned') {
        if (transaction.phase !== 'prepared' || transaction.rollbackId !== event.payload.rollbackId
          || transaction.checkpointId !== event.payload.checkpointId || transaction.gateId !== event.payload.gateId) {
          throw new Error('rollback completion does not match its durable authorization')
        }
        next.rollbackTransaction = { ...transaction, phase: 'applied' }
      }
      next.rollbacks = [...next.rollbacks, event.payload]
      next.currentStage = 'delivery'
      break
    }
    case 'rollback/interrupted': {
      const transaction = next.rollbackTransaction
      if (event.actor.kind !== 'system' || !transaction || transaction.rollbackId !== event.payload.rollbackId
        || !['prepared', 'interrupted'].includes(transaction.phase)) throw new Error('rollback interruption has no unfinished transaction')
      next.rollbackTransaction = { ...transaction, phase: 'interrupted', reason: event.payload.reason }
      break
    }
    case 'rollback/cleaned': {
      const transaction = next.rollbackTransaction
      if (event.actor.kind !== 'system' || !transaction || transaction.rollbackId !== event.payload.rollbackId
        || transaction.phase !== 'applied') throw new Error('rollback cleanup requires committed completion')
      next.rollbackTransaction = { ...transaction, phase: 'cleaned' }
      break
    }
    case 'learning/applied':
      if (event.actor.kind !== 'system') throw new Error('workflow learning application may only be recorded by the Host controller')
      if (next.outcome !== undefined) throw new Error('workflow learning cannot be applied after an outcome')
      next.appliedLearning = event.payload.items
      break
    case 'learning/proposed':
      if (next.outcome === undefined) throw new Error('workflow learning may only be proposed after an outcome')
      if (event.actor.kind !== 'pm') throw new Error('workflow learning candidates must be proposed by the coordinator')
      if (next.learningProposalRecorded) throw new Error('workflow learning may only be reviewed once per run')
      if (event.payload.items.length > 3) throw new Error('workflow learning is limited to three candidates per run')
      for (const item of event.payload.items) {
        if (item.sourceEvidenceIds) {
          const unknown = item.sourceEvidenceIds.filter(id => next.evidence[id] === undefined)
          if (unknown.length) throw new Error(`workflow learning references unknown evidence: ${unknown.join(', ')}`)
          const sources = item.sourceEvidenceIds.map(id => {
            const evidence = next.evidence[id]!
            return { evidenceId: id, kind: evidence.kind, verdict: evidence.verdict, summary: evidence.summary, taskId: evidence.taskId ?? null }
          })
          const expectedHash = createHash('sha256').update(JSON.stringify(sources), 'utf8').digest('hex')
          if (item.sourceSummaryHash !== expectedHash) throw new Error(`workflow learning evidence digest disagrees with persisted evidence for ${item.id}`)
        }
      }
      next.learningProposalRecorded = true
      next.proposedLearning = event.payload.items
      next.currentStage = 'learning'
      break
    case 'learning/revised': {
      if (next.outcome === undefined) throw new Error('workflow learning may only be revised after an outcome')
      if (event.actor.kind !== 'pm') throw new Error('workflow learning revisions must be submitted by the coordinator')
      const pending = next.learningDecision?.revisionRequiredIds ?? []
      if (!pending.includes(event.payload.candidateId)) throw new Error('workflow learning revision requires a candidate returned for editing')
      const candidate = next.proposedLearning.find(item => item.id === event.payload.candidateId)
      if (!candidate) throw new Error('workflow learning revision references an unknown candidate')
      if (candidate.statement !== event.payload.previousStatement) throw new Error('workflow learning revision previous statement is stale')
      if (event.payload.statement === event.payload.previousStatement) throw new Error('workflow learning revision must change the statement')
      const expectedAttempt = next.learningRevisions.filter(item => item.candidateId === event.payload.candidateId).length + 1
      if (event.payload.attempt !== expectedAttempt) throw new Error('workflow learning revision attempt is not monotonic')
      next.proposedLearning = next.proposedLearning.map(item => item.id === event.payload.candidateId
        ? { ...item, statement: event.payload.statement } : item)
      next.learningRevisions = [...next.learningRevisions, event.payload]
      next.learningRevisionReadyIds = next.learningRevisionReadyIds.includes(event.payload.candidateId)
        ? next.learningRevisionReadyIds : [...next.learningRevisionReadyIds, event.payload.candidateId]
      next.currentStage = 'learning'
      break
    }
    case 'learning/decided': {
      if (event.actor.kind !== 'user') throw new Error('permanent workflow learning requires a user decision')
      assertDecisionAudit(event.payload.decisionAudit, event.actor)
      if (!next.learningProposalRecorded) throw new Error('workflow learning decision requires one undecided proposal')
      const known = new Set(next.proposedLearning.map(item => item.id))
      const revisionRequiredIds = event.payload.revisionRequiredIds ?? []
      const decidedIds = [...event.payload.acceptedIds, ...event.payload.rejectedIds, ...revisionRequiredIds]
      const unknown = decidedIds.filter(id => !known.has(id))
      if (unknown.length > 0) throw new Error(`workflow learning decision references unknown items: ${unknown.join(', ')}`)
      const expectedIds = next.learningDecision === undefined ? [...known] : [...next.learningRevisionReadyIds]
      if (expectedIds.length === 0) throw new Error('workflow learning decision requires one undecided proposal or revised candidate')
      if (!sameSet(decidedIds, expectedIds)) {
        throw new Error(next.learningDecision === undefined
          ? 'workflow learning decision must accept or reject every proposed item, or return it for revision'
          : 'workflow learning revision decision must cover every corrected candidate exactly once')
      }
      if (event.payload.acceptedScopes !== undefined) {
        if (!sameSet(event.payload.acceptedScopes.map(item => item.id), event.payload.acceptedIds)) {
          throw new Error('workflow learning accepted scopes must identify every accepted item exactly once')
        }
        for (const accepted of event.payload.acceptedScopes) {
          const candidate = next.proposedLearning.find(item => item.id === accepted.id)!
          if (accepted.scope === 'project' && candidate.projectKey === undefined) {
            throw new Error('project-scoped learning requires a Host-bound project identity')
          }
        }
      }
      const previous = next.learningDecision
      const acceptedIds = [...(previous?.acceptedIds ?? []), ...event.payload.acceptedIds]
      const rejectedIds = [...(previous?.rejectedIds ?? []), ...event.payload.rejectedIds]
      const acceptedScopes = [...(previous?.acceptedScopes ?? []), ...(event.payload.acceptedScopes ?? [])]
      const stillPending = (previous?.revisionRequiredIds ?? [])
        .filter(id => !event.payload.acceptedIds.includes(id) && !event.payload.rejectedIds.includes(id))
      next.learningDecision = {
        acceptedIds,
        rejectedIds,
        revisionRequiredIds: [...new Set([...stillPending, ...revisionRequiredIds])],
        acceptedScopes,
        ...(event.payload.decisionAudit === undefined ? {} : { decisionAudit: event.payload.decisionAudit }),
      }
      const completed = new Set(expectedIds)
      next.learningRevisionReadyIds = next.learningRevisionReadyIds.filter(id => !completed.has(id))
      break
    }
    case 'learning/revoked':
      if (event.actor.kind !== 'user') throw new Error('workflow learning revocation requires a user decision')
      assertDecisionAudit(event.payload.decisionAudit, event.actor)
      if (next.outcome === undefined) throw new Error('workflow learning may only be revoked from a terminal run')
      if (next.learningRevocations.some(item => item.ruleId === event.payload.ruleId)) throw new Error('workflow learning rule was already revoked in this run')
      next.learningRevocations = [...next.learningRevocations, event.payload]
      next.currentStage = 'learning'
      break
    case 'runtime/stall-detected': {
      if (event.actor.kind !== 'system') throw new Error('root runtime stalls may only be recorded by the Host controller')
      if (event.payload.stage !== next.currentStage) throw new Error('root runtime stall stage disagrees with the current Journal stage')
      if (event.payload.journalRevision !== seq) throw new Error('root runtime stall revision must name the pre-commit Journal revision')
      const previous = next.runtimeRecovery
      if (previous?.status === 'recovering') {
        if (event.payload.attempt !== previous.attempt + 1) throw new Error('root runtime recovery attempt is not monotonic')
      } else if (event.payload.attempt !== 1) {
        throw new Error('a new root runtime recovery chain must begin at attempt 1')
      }
      if (previous?.status === 'needs-attention') {
        throw new Error('root runtime recovery needs user attention before another automatic attempt')
      }
      next.runtimeRecovery = {
        incidentId: event.payload.incidentId,
        status: event.payload.disposition === 'auto-continue' ? 'recovering' : 'needs-attention',
        attempt: event.payload.attempt,
        turn: event.payload.turn,
        stage: event.payload.stage,
        noProgressMs: event.payload.noProgressMs,
        journalRevision: event.payload.journalRevision,
        reason: event.payload.reason,
        preserved: event.payload.preserved,
        resumeFrom: event.payload.resumeFrom,
      }
      break
    }
    case 'runtime/recovery-settled': {
      if (event.actor.kind !== 'system') throw new Error('root runtime recovery may only be settled by the Host controller')
      const recovery = next.runtimeRecovery
      if (!recovery || recovery.incidentId !== event.payload.incidentId) {
        throw new Error('root runtime recovery settlement does not match the active incident')
      }
      if (event.payload.outcome === 'resumed') delete next.runtimeRecovery
      else next.runtimeRecovery = { ...recovery, status: 'needs-attention' }
      break
    }
  }
  return next
}

/** Strictly replay one run from a mixed plugin-journal event stream. */
export function foldWorkflowRun(runId: string, events: readonly unknown[]): WorkflowRunState {
  return events.reduce(applyWorkflowStoredEvent, emptyWorkflowRunState(runId))
}
