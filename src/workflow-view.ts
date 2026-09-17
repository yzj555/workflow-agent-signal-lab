import { z } from 'zod'
import { runBudgetAccountSchema } from './workflow-run-budget.ts'
import { WORKFLOW_ROLES, WORKFLOW_STAGES } from './workflow-contract.ts'
import { WORKFLOW_EXECUTION_PROFILES } from './workflow-profiles.ts'

export const WORKFLOW_RPC_CHANNEL = '/workflow-runtime'
export const workflowSnapshotRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rootSessionId: z.string().trim().min(1).max(256),
})

const taskView = z.strictObject({
  taskId: z.string(), version: z.int().positive(), title: z.string(),
  stage: z.enum(WORKFLOW_STAGES), role: z.enum(WORKFLOW_ROLES),
  status: z.enum(['pending', 'ready', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'invalidated']),
  reason: z.string(), dependsOn: z.array(z.string()), stale: z.boolean(),
})
const decisionAuditView = z.strictObject({
  authority: z.literal('user'),
  channel: z.literal('native-question'),
  operator: z.literal('unverified'),
  requestId: z.string(),
})
const gateView = z.strictObject({
  gateId: z.string(), kind: z.enum(['signal', 'plan', 'execution', 'product', 'review', 'delivery', 'learning', 'action', 'rollback', 'runtime-recovery']),
  stage: z.enum(WORKFLOW_STAGES), summary: z.string(),
  status: z.enum(['waiting', 'approved', 'rejected', 'cancelled']),
  requiredActor: z.enum(['user', 'pm', 'acceptance_qa']),
  scopeTaskIds: z.array(z.string()), stale: z.boolean(),
  decisionAudit: decisionAuditView.optional(),
})
const agentView = z.strictObject({
  assignmentId: z.string(), agentSessionId: z.string(), taskId: z.string(),
  taskVersion: z.int().positive(), taskTitle: z.string(), role: z.enum(WORKFLOW_ROLES),
  status: z.enum(['running', 'idle', 'completed', 'failed', 'cancelled', 'interrupted']),
  lastSummary: z.string().nullable(),
  runtimeIssue: z.strictObject({
    incidentId: z.string(), assignmentId: z.string(), taskVersion: z.int().positive(),
    cause: z.enum(['admission-timeout', 'admission-failed', 'no-progress', 'deadline', 'report-timeout', 'disposed', 'host-restart', 'stop-requested', 'command-timeout', 'command-cancelled', 'command-exit-unknown', 'command-execution-error', 'run-budget']),
    status: z.enum(['stopping', 'stopped', 'unknown']),
    budgetMs: z.int().nonnegative(), elapsedMs: z.int().nonnegative(), reason: z.string(),
  }).optional(),
})
const returnView = z.strictObject({
  fromStage: z.enum(WORKFLOW_STAGES), toStage: z.enum(WORKFLOW_STAGES),
  responsibleTaskId: z.string().optional(), reason: z.string(), attempt: z.int().positive(),
})
const rollbackView = z.strictObject({
  availableCheckpoints: z.int().nonnegative(),
  pending: z.strictObject({
    phase: z.enum(['prepared', 'interrupted', 'applied']),
    fileCount: z.int().positive(), reason: z.string(),
  }).optional(),
  latestApplied: z.strictObject({
    checkpointId: z.string(), fileCount: z.int().positive(), reason: z.string(),
  }).nullable(),
})
const learningCandidateView = z.strictObject({
  id: z.string(), statement: z.string(), basis: z.string(),
  scope: z.enum(['run', 'project', 'preset']),
  status: z.enum(['pending', 'revision-required', 'accepted', 'rejected', 'revoked']),
  ruleKey: z.string().optional(),
  actionKind: z.enum(['communication-preference', 'planning-hint', 'quality-requirement']).optional(),
  risk: z.enum(['low', 'execution-affecting']).optional(),
  revisionCount: z.int().nonnegative().optional(),
  latestRevisionReason: z.string().optional(),
})
const learningAppliedView = z.strictObject({
  ruleId: z.string(), version: z.int().positive(), sourceRunId: z.string(), statement: z.string(),
  scope: z.enum(['project', 'preset']),
  actionKind: z.enum(['communication-preference', 'planning-hint', 'quality-requirement']),
  reason: z.string(), status: z.enum(['applied', 'overridden']),
})
const learningView = z.strictObject({
  reviewed: z.boolean(), decisionRecorded: z.boolean(),
  candidates: z.array(learningCandidateView), applied: z.array(learningAppliedView),
  revokedRuleIds: z.array(z.string()),
  decisionAudit: decisionAuditView.optional(),
})
const projectPlanCheckView = z.strictObject({
  id: z.string(), command: z.string(), workdir: z.string(), purpose: z.string(),
})
const projectPlanTaskView = z.strictObject({
  taskId: z.string(), version: z.int().positive(), title: z.string(),
  stage: z.enum(WORKFLOW_STAGES), role: z.enum(WORKFLOW_ROLES),
  dependsOn: z.array(z.string()), allowedActions: z.array(z.string()),
  forbiddenActions: z.array(z.string()), writeScopes: z.array(z.string()),
})
const projectPlanDesignView = z.strictObject({
  version: z.int().positive(), summary: z.string(),
  decisions: z.array(z.strictObject({ id: z.string(), decision: z.string(), rationale: z.string() })),
  affectedAreas: z.array(z.string()), interfaces: z.array(z.string()), rollback: z.array(z.string()),
})
const projectPlanView = z.strictObject({
  confirmationMode: z.enum(['single-gate', 'layered']),
  requirementVersion: z.int().positive(), workspaceRoot: z.string(), goal: z.string(),
  inScope: z.array(z.string()), outOfScope: z.array(z.string()), constraints: z.array(z.string()),
  assumptions: z.array(z.string()), permissionBoundaries: z.array(z.string()), writeScopes: z.array(z.string()),
  criteria: z.array(z.strictObject({ id: z.string(), statement: z.string(), checkIds: z.array(z.string()) })),
  engineeringChecks: z.array(projectPlanCheckView), acceptanceChecks: z.array(projectPlanCheckView),
  tasks: z.array(projectPlanTaskView), design: projectPlanDesignView.nullable(),
})
const runtimeRecoveryView = z.strictObject({
  incidentId: z.string(), status: z.enum(['recovering', 'needs-attention']),
  attempt: z.int().positive().max(2), turn: z.int().positive(), stage: z.enum(WORKFLOW_STAGES),
  noProgressMs: z.int().positive(), journalRevision: z.int().nonnegative(),
  reason: z.string(), preserved: z.array(z.string()).min(1), resumeFrom: z.string(),
})
const outcome = z.enum(['PASS', 'QUALIFIED', 'FAIL', 'CANCELLED', 'ABANDONED'])
const runView = z.strictObject({
  runId: z.string(), title: z.string(), stage: z.enum(WORKFLOW_STAGES),
  // Read-only identification from the persisted contract, never the title or
  // current preset selection. Older views may omit it and remain unclassified.
  executionProfile: z.enum(WORKFLOW_EXECUTION_PROFILES).optional(),
  budget: runBudgetAccountSchema.optional(),
  riskLevel: z.enum(['L0', 'L1', 'L2', 'L3']).nullable(), outcome: outcome.nullable(),
  needsUser: z.boolean(), tasks: z.array(taskView), gates: z.array(gateView), agents: z.array(agentView),
  ledger: z.strictObject({
    pass: z.int().nonnegative(), fail: z.int().nonnegative(), waived: z.int().nonnegative(), pending: z.int().nonnegative(),
    hardOutcome: z.enum(['PASS', 'QUALIFIED', 'FAIL', 'PENDING']),
  }),
  // Optional on the wire so clients can still read snapshots produced before
  // return context was exposed. New projections always publish null or the
  // latest committed return/routed event.
  latestReturn: returnView.nullable().optional(),
  // Optional for compatibility with snapshots emitted before file checkpoints
  // were exposed to the read-only workflow surface.
  rollback: rollbackView.optional(),
  // Optional for snapshots produced before the real deposition stage shipped.
  learning: learningView.optional(),
  // Optional for compatibility with earlier project snapshots. This is the
  // complete read-only plan contract; native conversation remains the only
  // place where a user can approve or revise it.
  plan: projectPlanView.optional(),
  // Optional so clients can still read snapshots produced before root-turn
  // recovery became a durable Journal projection.
  recovery: runtimeRecoveryView.nullable().optional(),
  // Administrative disposition is independent from immutable exit observations.
  manualClose: z.strictObject({
    gateId: z.string(), recordedAt: z.int().nonnegative(), reason: z.string(),
    decisionAudit: decisionAuditView, hostExitVerified: z.literal(false),
    checks: z.array(z.strictObject({
      assignmentId: z.string(), incidentId: z.string(), taskVersion: z.int().positive(), commandIds: z.array(z.string()),
      evidence: z.array(z.strictObject({ source: z.string(), observation: z.string() })),
    })),
  }).optional(),
  proposedLearningCount: z.int().nonnegative(), learningDecided: z.boolean(),
})

/** One shared wire schema: no source code, artifact contents, or raw Agent conversations. */
export const workflowSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), source: z.literal('plugin-journal'), rootSessionId: z.string(),
  revision: z.int().nonnegative(), availability: z.enum(['ready', 'absent']),
  budgetRevision: z.int().nonnegative().optional(),
  run: runView.nullable(),
  history: z.array(z.strictObject({ runId: z.string(), title: z.string(), outcome: outcome.nullable() })),
  // Optional for clients reading snapshots produced before the pre-run
  // recovery lane shipped. This records only runtime continuity; it is not a
  // workflow run, a merged requirement, or a Signal Gate approval.
  preRunRecovery: runtimeRecoveryView.nullable().optional(),
}).superRefine((value, context) => {
  if (value.run?.budget && (value.run.budget.runId !== value.run.runId || !value.budgetRevision)) {
    context.addIssue({ code: 'custom', message: 'budget must bind to the current run and its accounting revision' })
  }
  if (value.run && ((value.run.outcome === 'ABANDONED') !== (value.run.manualClose !== undefined))) {
    context.addIssue({ code: 'custom', message: 'manual closure and ABANDONED outcome must agree' })
  }
  const absent = value.availability === 'absent'
  if (absent ? value.run !== null || value.history.length !== 0
    : value.revision === 0 || value.run === null) {
    context.addIssue({ code: 'custom', message: 'snapshot availability disagrees with committed state' })
  }
  if (value.revision === 0 && value.preRunRecovery != null) {
    context.addIssue({ code: 'custom', message: 'pre-run recovery requires a committed Journal revision' })
  }
})

export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>
export type WorkflowRunView = z.infer<typeof runView>
