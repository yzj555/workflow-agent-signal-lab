import { KEEP_UNKNOWN_LABEL, MANUAL_CLOSE_LABEL, MANUAL_CLOSE_QUESTION, MANUAL_CLOSE_HEADER } from '../workflow-ui-contract.ts'

interface ManualRecoveryAnswer {
  answers: readonly { id: string; selected: readonly string[] }[]
}
interface RecoveryOption {
  label: typeof MANUAL_CLOSE_LABEL | typeof KEEP_UNKNOWN_LABEL
  description?: string
}
export interface ManualRecoveryQuestion {
  id: string
  header: typeof MANUAL_CLOSE_HEADER
  question: typeof MANUAL_CLOSE_QUESTION
  detail: string
  options: readonly [RecoveryOption, RecoveryOption]
  multiSelect?: false
  intent: { kind: 'plan-review'; approve: typeof MANUAL_CLOSE_LABEL }
}
export interface ManualRecoveryWait {
  kind: 'plan-review'
  key: string
  sessionId: string
  questions: readonly [ManualRecoveryQuestion]
  answer(answer: ManualRecoveryAnswer): Promise<void>
  cancel(): Promise<void>
}
export interface ManualRecoveryOwner {
  sessionId?: string | undefined
  pendingInteraction?: unknown
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Exact, Session-owned binary contract only. Non-matches retain the official composer. */
export function selectManualRecoveryGate(owner: ManualRecoveryOwner): ManualRecoveryWait | null {
  const wait = owner.pendingInteraction
  if (!record(wait) || wait.kind !== 'plan-review' || !nonempty(wait.key)
    || !nonempty(owner.sessionId) || wait.sessionId !== owner.sessionId
    || typeof wait.answer !== 'function' || typeof wait.cancel !== 'function'
    || !Array.isArray(wait.questions) || wait.questions.length !== 1) return null
  const question: unknown = wait.questions[0]
  if (!record(question) || !nonempty(question.id) || question.header !== MANUAL_CLOSE_HEADER
    || question.question !== MANUAL_CLOSE_QUESTION || !nonempty(question.detail)
    || (question.multiSelect !== undefined && question.multiSelect !== false)
    || !record(question.intent) || question.intent.kind !== 'plan-review'
    || question.intent.approve !== MANUAL_CLOSE_LABEL
    || !Array.isArray(question.options) || question.options.length !== 2) return null
  const labels = new Set<string>()
  for (const option of question.options as unknown[]) {
    if (!record(option) || (option.label !== MANUAL_CLOSE_LABEL && option.label !== KEEP_UNKNOWN_LABEL)
      || (option.description !== undefined && typeof option.description !== 'string')) return null
    labels.add(option.label)
  }
  return labels.size === 2 ? wait as unknown as ManualRecoveryWait : null
}

/** Use the original PendingQuestion, its id and exact Host label; never synthesize approval. */
export async function decideManualRecovery(wait: ManualRecoveryWait, choice: 'keep' | 'close'): Promise<void> {
  await wait.answer({ answers: [{ id: wait.questions[0].id,
    selected: [choice === 'close' ? MANUAL_CLOSE_LABEL : KEEP_UNKNOWN_LABEL] }] })
}
export async function discussManualRecovery(wait: ManualRecoveryWait): Promise<void> {
  await wait.cancel()
}
