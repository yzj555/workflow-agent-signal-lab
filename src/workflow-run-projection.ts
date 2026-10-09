import { currentTaskBriefs } from './workflow-contract.ts'
import { learningDecisionComplete, sameWorkflowFileState, summarizeAcceptanceLedger } from './workflow-events.ts'
import type { WorkflowRunState } from './workflow-events.ts'
import { pilotContract } from './workflow-pilot-contract.ts'
import { criterionCheckIds, decodeWorkflowChecks, projectContract } from './workflow-project-contract.ts'
import { PROJECT_PILOT, TEXT_PILOT } from './workflow-profiles.ts'
import type { WorkflowRunView } from './workflow-view.ts'
import { workflowFailedRoles } from './workflow-view.ts'

function executionProfile(state: WorkflowRunState): typeof TEXT_PILOT | typeof PROJECT_PILOT | undefined {
  try {
    projectContract(state)
    return PROJECT_PILOT
  } catch { /* Continue with the narrower historical text profile check. */ }
  try {
    const { author, qa } = pilotContract(state)
    if (author.data.stage === 'implementation' && qa.data.stage === 'verification'
      && author.data.dependsOn.length === 0 && qa.data.dependsOn.length === 1 && qa.data.dependsOn[0] === author.recordId) return TEXT_PILOT
  } catch { /* A generic or historical run must not inherit the text route's omissions. */ }
  return undefined
}

/** Host-only projection: strict contract recognition never enters the browser bundle. */
export function projectWorkflowRun(state: WorkflowRunState): WorkflowRunView {
  if (state.created === undefined) throw new Error('cannot project an uncreated workflow run')
  const briefs = currentTaskBriefs(state.records)
  const acceptance = Object.values(state.records).find(record => record.kind === 'acceptance')
  const profile = executionProfile(state)
  const project = profile === PROJECT_PILOT ? projectContract(state) : undefined
  const tasks = briefs.map(brief => ({
    taskId: brief.recordId, version: brief.version, title: brief.data.title,
    stage: brief.data.stage, role: brief.data.role,
    status: state.tasks[brief.recordId].status, reason: state.tasks[brief.recordId].reason,
    dependsOn: [...brief.data.dependsOn], stale: state.staleTaskIds.includes(brief.recordId),
  }))
  const gates = Object.values(state.gates).map(gate => ({
    gateId: gate.gateId, kind: gate.kind, stage: gate.stage, summary: gate.summary,
    status: gate.status, requiredActor: gate.requiredActor, scopeTaskIds: [...gate.scopeTaskIds],
    stale: state.staleGateIds.includes(gate.gateId),
    ...(gate.decisionAudit === undefined ? {} : { decisionAudit: gate.decisionAudit }),
  }))
  const agents = Object.values(state.assignments).map(agent => ({
    assignmentId: agent.assignmentId, agentSessionId: agent.agentSessionId, taskId: agent.taskId,
    taskVersion: agent.taskVersion,
    taskTitle: briefs.find(brief => brief.recordId === agent.taskId)?.data.title ?? agent.taskId,
    role: agent.role, status: agent.status, lastSummary: agent.lastSummary ?? null,
    ...(agent.runtimeIssue === undefined ? {} : { runtimeIssue: { ...agent.runtimeIssue } }),
  }))
  const latestReturn = state.returns.at(-1)
  const rolledBack = new Set(state.rollbacks.map(item => item.checkpointId))
  const availableCheckpoints = Object.values(state.checkpoints).filter(checkpoint => !rolledBack.has(checkpoint.checkpointId)
    && Object.values(checkpoint.files).some(file => !sameWorkflowFileState(file.before, file.after))).length
  const latestRollback = state.rollbacks.at(-1)
  const rollbackPending = state.rollbackTransaction?.phase !== 'cleaned' ? state.rollbackTransaction : undefined
  const revokedRuleIds = state.learningRevocations.map(item => item.ruleId)
  const revisionRequired = new Set(state.learningDecision?.revisionRequiredIds ?? [])
  const revisionReady = new Set(state.learningRevisionReadyIds)
  const decisionComplete = learningDecisionComplete(state)
  const learningCandidates = state.proposedLearning.map(item => {
    const accepted = state.learningDecision?.acceptedIds.includes(item.id) ?? false
    const rejected = state.learningDecision?.rejectedIds.includes(item.id) ?? false
    const revisions = state.learningRevisions.filter(revision => revision.candidateId === item.id)
    const latestRevision = revisions.at(-1)
    const status: 'pending' | 'revision-required' | 'accepted' | 'rejected' | 'revoked' = revokedRuleIds.includes(item.id)
      ? 'revoked' : accepted ? 'accepted' : rejected ? 'rejected'
        : revisionRequired.has(item.id) && !revisionReady.has(item.id) ? 'revision-required' : 'pending'
    return {
      id: item.id,
      statement: item.statement,
      basis: item.basis,
      scope: state.learningDecision?.acceptedScopes?.find(scope => scope.id === item.id)?.scope ?? item.proposedScope,
      status,
      revisionCount: revisions.length,
      ...(latestRevision === undefined ? {} : { latestRevisionReason: latestRevision.reason }),
      ...(item.ruleKey === undefined ? {} : { ruleKey: item.ruleKey }),
      ...(item.actionKind === undefined ? {} : { actionKind: item.actionKind }),
      ...(item.risk === undefined ? {} : { risk: item.risk }),
    }
  })
  return {
    runId: state.runId, title: state.created.title, stage: state.currentStage,
    ...(profile === undefined ? {} : { executionProfile: profile }),
    riskLevel: state.risk?.level ?? null, outcome: state.outcome?.outcome ?? null,
    needsUser: gates.some(gate => gate.status === 'waiting' && !gate.stale && gate.requiredActor === 'user')
      || rollbackPending !== undefined
      || workflowFailedRoles({ outcome: state.outcome?.outcome ?? null, tasks, agents }).length > 0
      || (!state.manualClose && agents.some(agent => agent.runtimeIssue?.status === 'unknown'
        || (state.outcome === undefined && agent.runtimeIssue?.status === 'stopped')))
      || (state.proposedLearning.length > 0 && !decisionComplete),
    tasks, gates, agents, ledger: summarizeAcceptanceLedger(acceptance, state.acceptance),
    ...(state.manualClose ? { manualClose: {
      ...state.manualClose,
      reason: state.manualCloseRequests[state.manualClose.gateId]!.reason,
      checks: structuredClone(state.manualCloseRequests[state.manualClose.gateId]!.checks),
      hostExitVerified: false as const,
    } } : {}),
    latestReturn: latestReturn === undefined ? null : {
      fromStage: latestReturn.fromStage, toStage: latestReturn.toStage,
      ...(latestReturn.responsibleTaskId === undefined ? {} : { responsibleTaskId: latestReturn.responsibleTaskId }),
      reason: latestReturn.reason, attempt: latestReturn.attempt,
    },
    rollback: {
      availableCheckpoints,
      ...(rollbackPending ? { pending: {
        phase: rollbackPending.phase as 'prepared' | 'interrupted' | 'applied',
        fileCount: rollbackPending.files.length,
        reason: rollbackPending.phase === 'applied' ? '文件撤销已落盘；本次临时备份尚待核对清理。'
          : rollbackPending.phase === 'prepared' ? '撤销意图已记录，但尚无完成记录；请勿继续修改本工作区。' : rollbackPending.reason,
      } } : {}),
      latestApplied: latestRollback === undefined ? null : {
        checkpointId: latestRollback.checkpointId,
        fileCount: latestRollback.files.length,
        reason: latestRollback.reason,
      },
    },
    learning: {
      reviewed: state.learningProposalRecorded,
      decisionRecorded: decisionComplete,
      candidates: learningCandidates,
      applied: state.appliedLearning.map(item => ({ ...item })),
      revokedRuleIds,
      ...(state.learningDecision?.decisionAudit === undefined ? {} : { decisionAudit: state.learningDecision.decisionAudit }),
    },
    ...(project === undefined ? {} : { plan: {
      confirmationMode: project.architecture === undefined ? 'single-gate' as const : 'layered' as const,
      requirementVersion: project.requirement.version,
      workspaceRoot: project.workspaceRoot,
      goal: project.requirement.data.goal,
      inScope: [...project.requirement.data.inScope],
      outOfScope: [...project.requirement.data.outOfScope],
      constraints: [...project.requirement.data.constraints],
      assumptions: [...project.requirement.data.assumptions],
      permissionBoundaries: [...project.requirement.data.permissionBoundaries],
      writeScopes: [...project.implementation.data.writeScopes],
      criteria: project.acceptance.data.criteria.map(item => ({
        id: item.id, statement: item.statement, checkIds: criterionCheckIds(item),
      })),
      engineeringChecks: project.engineeringChecks.map(check => ({ ...check })),
      acceptanceChecks: project.acceptanceChecks.map(check => ({ ...check })),
      tasks: project.tasks.map(task => {
        const checks = decodeWorkflowChecks(task.data.allowedActions)
        return {
          taskId: task.recordId, version: task.version, title: task.data.title,
          stage: task.data.stage, role: task.data.role, dependsOn: [...task.data.dependsOn],
          allowedActions: [
            ...task.data.allowedActions.filter(action => !action.startsWith('workflow-check/1:')),
            ...checks.map(check => `运行冻结检查 ${check.id}：${check.purpose}`),
          ],
          forbiddenActions: [...task.data.forbiddenActions], writeScopes: [...task.data.writeScopes],
        }
      }),
      design: state.records['design:design']?.kind === 'design' ? {
        version: state.records['design:design'].version,
        summary: state.records['design:design'].data.summary,
        decisions: state.records['design:design'].data.decisions.map(item => ({ ...item })),
        affectedAreas: [...state.records['design:design'].data.affectedAreas],
        interfaces: [...state.records['design:design'].data.interfaces],
        rollback: [...state.records['design:design'].data.rollback],
      } : null,
    } }),
    recovery: state.runtimeRecovery === undefined ? null : {
      ...state.runtimeRecovery,
      preserved: [...state.runtimeRecovery.preserved],
    },
    proposedLearningCount: state.proposedLearning.length, learningDecided: decisionComplete,
  }
}
