import { REQUIREMENTS_CONFIRM_LABEL } from '../workflow-ui-contract.ts'

interface QuestionOptionLike {
  label?: string
  description?: string
}

interface QuestionLike {
  id?: string
  question?: string
  detail?: string
  options?: readonly QuestionOptionLike[]
  multiSelect?: boolean
  intent?: { kind?: string; approve?: string }
}

interface RequirementsGateAnswer {
  answers: readonly { id: string; selected: readonly string[] }[]
}

interface PendingInteractionLike {
  kind?: string
  key?: string
  sessionId?: string
  questions?: readonly QuestionLike[]
  answer?: (answer: RequirementsGateAnswer) => Promise<void>
  cancel?: () => Promise<void>
}

/** Composer-chain currency needed by the first workflow gate selector. */
export interface RequirementsGateOwner {
  pendingInteraction?: PendingInteractionLike
}

/** A pending question proven to be the workflow's first, read-only planning gate. */
export interface RequirementsGateWait {
  kind: 'plan-review'
  key: string
  sessionId: string
  questions: readonly [RequirementsGateQuestion]
  answer(answer: RequirementsGateAnswer): Promise<void>
  cancel(): Promise<void>
}

/** The single decision rendered by the first workflow gate. */
export interface RequirementsGateQuestion {
  id: string
  question: string
  detail: string
  options: readonly [RequirementsGateOption]
  multiSelect?: false
  intent: { kind: 'plan-review'; approve: typeof REQUIREMENTS_CONFIRM_LABEL }
}

/** Exact approval option supplied by the Host. */
export interface RequirementsGateOption {
  label: typeof REQUIREMENTS_CONFIRM_LABEL
  description?: string
}

function matchesRequirementsGate(interaction: PendingInteractionLike): interaction is RequirementsGateWait {
  if (interaction.kind !== 'plan-review'
    || typeof interaction.key !== 'string'
    || typeof interaction.sessionId !== 'string'
    || typeof interaction.answer !== 'function'
    || typeof interaction.cancel !== 'function') return false
  const questions = interaction.questions
  if (questions?.length !== 1) return false
  const question = questions[0]
  if (question === undefined
    || typeof question.id !== 'string'
    || typeof question.question !== 'string'
    || typeof question.detail !== 'string'
    || question.multiSelect === true
    || question.intent?.kind !== 'plan-review'
    || question.intent.approve !== REQUIREMENTS_CONFIRM_LABEL) return false
  const options = question.options
  return options?.length === 1 && options[0]?.label === REQUIREMENTS_CONFIRM_LABEL
}

/**
 * Select only the first workflow gate. A non-match leaves the request to the
 * official DSH question or plan-review composer.
 */
export function selectRequirementsGate(owner: RequirementsGateOwner): RequirementsGateWait | null {
  return owner.pendingInteraction !== undefined && matchesRequirementsGate(owner.pendingInteraction)
    ? owner.pendingInteraction
    : null
}

/** Read the already-validated single decision from a selected wait. */
export function requirementsGateQuestion(wait: RequirementsGateWait): RequirementsGateQuestion {
  return wait.questions[0]
}

/** Answer with the Host's exact option label; pending removal remains frame-driven. */
export async function approveRequirementsGate(wait: RequirementsGateWait): Promise<void> {
  const question = requirementsGateQuestion(wait)
  await wait.answer({
    answers: [{ id: question.id, selected: [REQUIREMENTS_CONFIRM_LABEL] }],
  })
}

/** Cancel the pending gate so the original composer returns for natural-language correction. */
export async function reviseRequirementsGate(wait: RequirementsGateWait): Promise<void> {
  await wait.cancel()
}
