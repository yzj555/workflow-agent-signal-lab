import { BUDGET_HEADER, BUDGET_KEEP_LABEL, BUDGET_TOPUP_LABEL, BUDGET_END_LABEL,
  BUDGET_TOPUP_QUESTION, BUDGET_END_QUESTION } from '../workflow-ui-contract.ts'

type Approval = typeof BUDGET_TOPUP_LABEL | typeof BUDGET_END_LABEL
export interface BudgetQuestion {
  id: string
  header: typeof BUDGET_HEADER
  question: typeof BUDGET_TOPUP_QUESTION | typeof BUDGET_END_QUESTION
  detail: string
  options: readonly { label: Approval | typeof BUDGET_KEEP_LABEL; description?: string }[]
  multiSelect?: false
  intent: { kind: 'plan-review'; approve: Approval }
}
export interface BudgetWait {
  kind: 'plan-review'
  key: string
  sessionId: string
  questions: readonly [BudgetQuestion]
  answer(answer: { answers: readonly { id: string; selected: readonly string[] }[] }): Promise<void>
  cancel(): Promise<void>
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Presentation match only, never an approval/identity check. Host validates the frozen request. */
export function selectBudgetGate(owner: { sessionId?: string; pendingInteraction?: unknown }): BudgetWait | null {
  const wait = owner.pendingInteraction
  if (!record(wait) || wait.kind !== 'plan-review' || !nonempty(wait.key)
    || !nonempty(owner.sessionId) || wait.sessionId !== owner.sessionId
    || typeof wait.answer !== 'function' || typeof wait.cancel !== 'function'
    || !Array.isArray(wait.questions) || wait.questions.length !== 1) return null
  const question: unknown = wait.questions[0]
  if (!record(question) || !nonempty(question.id) || question.header !== BUDGET_HEADER || !nonempty(question.detail)
    || (question.multiSelect !== undefined && question.multiSelect !== false)
    || !record(question.intent) || question.intent.kind !== 'plan-review'
    || !Array.isArray(question.options) || question.options.length !== 2) return null
  const approve = question.question === BUDGET_TOPUP_QUESTION ? BUDGET_TOPUP_LABEL
    : question.question === BUDGET_END_QUESTION ? BUDGET_END_LABEL : null
  if (!approve || question.intent.approve !== approve) return null
  const labels = new Set<string>()
  for (const option of question.options as unknown[]) {
    if (!record(option) || typeof option.label !== 'string' || (option.label !== approve && option.label !== BUDGET_KEEP_LABEL)
      || (option.description !== undefined && typeof option.description !== 'string')) return null
    labels.add(option.label)
  }
  return labels.size === 2 ? wait as unknown as BudgetWait : null
}
export async function decideBudget(wait: BudgetWait, choice: 'keep' | 'approve'): Promise<void> {
  await wait.answer({ answers: [{ id: wait.questions[0].id,
    selected: [choice === 'approve' ? wait.questions[0].intent.approve : BUDGET_KEEP_LABEL] }] })
}
export async function discussBudget(wait: BudgetWait): Promise<void> { await wait.cancel() }
