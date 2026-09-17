/** Host half of the Workflow Agent Signal Lab plugin. */

export {
  apply,
  classifyPmWriteTarget,
  inject,
  isDelegatedAgentExecution,
  name,
} from './host/pm-write-guard.ts'

export { classifyWorkflowOutcome, summarizeAgentFollowup } from './workflow-policy.ts'
export type { WorkflowOutcome } from './workflow-policy.ts'

export {
  WORKFLOW_ACCEPTANCE_STATUSES,
  WORKFLOW_CONTEXT_DOMAINS,
  WORKFLOW_RECORD_KINDS,
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
export type {
  AcceptanceBrief,
  AcceptanceCriterion,
  AcceptanceStatus,
  AgentLifecycle,
  ArtifactRecord,
  ContextDomain,
  DesignSnapshot,
  RequirementQuestion,
  RequirementSnapshot,
  RiskLevel,
  TaskBrief,
  VersionRef,
  WorkflowRecord,
  WorkflowRecordKind,
  WorkflowRole,
  WorkflowStage,
} from './workflow-contract.ts'

export {
  PROJECT_CHANGE_CLASSES,
  PROJECT_PILOT,
  addArtifactInputs,
  criterionCheckIds,
  decodeWorkflowChecks,
  encodeWorkflowCheck,
  isSupportedL1Command,
  normalizeProjectRelative,
  projectBoundaries,
  projectContract,
  projectDesignRecord,
  projectExecutionConfirmationCard,
  projectProposalSchema,
  projectRecords,
  projectReportSchema,
  projectRequirementConfirmationCard,
  removeArtifactInputs,
} from './workflow-project-contract.ts'

export {
  CONFIRMATION_AUDIT_POINTERS,
  CONFIRMATION_CARD_CONTRACT_VERSION,
  CONFIRMATION_CARD_KINDS,
  CONFIRMATION_FIELD_LABELS,
  CONFIRMATION_REQUIRED_FIELDS,
  CONTRACT_RETAINED_SEMANTICS,
  ConfirmationCardError,
  RETAINED_SEMANTICS_KEYS,
  RETAINED_SEMANTICS_STATEMENT,
  assertConfirmationCardCurrent,
  bindConfirmationCard,
  displayRecordedRuleText,
  firstScreenIdentifiers,
  renderConfirmationCard,
  retainedSemanticsDigest,
  retainedSnapshotFromRule,
  retainedSnapshotFromState,
  rollbackConfirmationCard,
  ruleIdentitiesInText,
} from './workflow-confirmation-card.ts'
export type {
  ConfirmationCard,
  ConfirmationCardBinding,
  ConfirmationCardDraft,
  ConfirmationCardExtension,
  ConfirmationCardKind,
  ConfirmationCardOption,
  ConfirmationFieldId,
  RetainedSemantics,
  RollbackConfirmationSource,
} from './workflow-confirmation-card.ts'

export {
  PROJECT_NATIVE_TOOLS,
  guardProjectTool,
  matchProjectCheck,
  projectToolsForTask,
  resolveProjectPath,
} from './host/workflow-capabilities.ts'
export type {
  ProjectChangeClass,
  ProjectContract,
  ProjectProposal,
  ProjectReport,
  WorkflowCheck,
} from './workflow-project-contract.ts'

export {
  WORKFLOW_EVENT_NAMES,
  WORKFLOW_INGRESS_RUN_ID,
  applyWorkflowStoredEvent,
  emptyWorkflowRunState,
  foldWorkflowRun,
  learningDecisionComplete,
  parseWorkflowEventData,
  summarizeAcceptanceLedger,
} from './workflow-events.ts'
export type {
  AcceptanceLedgerSummary,
  AcceptanceResult,
  AssignmentRuntimeState,
  EvidenceRecord,
  GateKind,
  GateRuntimeState,
  TaskRuntimeState,
  TaskStatus,
  WorkflowActor,
  WorkflowDecisionAudit,
  WorkflowEventData,
  WorkflowEventName,
  WorkflowEventPayloadMap,
  WorkflowOutcomeCode,
  WorkflowRunState,
  WorkflowRuntimeRecoveryState,
  WorkflowStoredEvent,
} from './workflow-events.ts'

export {
  LEARNING_ACTION_KINDS,
  LEARNING_RISKS,
  LEARNING_SCOPES,
  LearningRuleConflictError,
  compareLearningRuleDrafts,
  collectActiveLearningRules,
  findLearningRuleOverlap,
  learningCommandSchema,
  learningOverrideSchema,
  learningOverridesSchema,
  learningRevisionCommandSchema,
  learningRevokeSchema,
  learningRevocationPresentation,
  learningStatementIssues,
  learningToolCommandSchema,
  learningRulesForContext,
  matchLearningRules,
  nextLearningVersion,
  normalizeLearningText,
} from './workflow-learning.ts'
export type {
  ActiveLearningRule,
  LearningActionKind,
  LearningCommand,
  LearningOverride,
  LearningRevisionCommand,
  LearningRuleDraft,
  LearningRuleOverlap,
  LearningRevocationPresentation,
  LearningScope,
  LearningToolCommand,
  WorkflowExecutionProfile,
} from './workflow-learning.ts'
