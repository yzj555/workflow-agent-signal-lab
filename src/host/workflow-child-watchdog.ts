import type { WorkflowRole } from '../workflow-contract.ts'

export type ChildRole = Exclude<WorkflowRole, 'pm'>
export interface ChildRoleBudget { readonly noProgressMs: number; readonly maxRunMs: number }
export interface ChildWatchdogConfig {
  readonly childAdmissionMs: number
  readonly childNoProgressMs: number
  readonly childMaxRunMs: number
  readonly childReportGraceMs: number
  readonly childCancelGraceMs: number
  readonly childRoleBudgets?: Partial<Record<ChildRole, ChildRoleBudget>>
}
export interface ChildWatchdogScheduler {
  now(): number
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}
export interface ChildBudgetExpiry {
  readonly cause: 'admission-timeout' | 'no-progress' | 'deadline' | 'report-timeout' | 'disposed'
  readonly budgetMs: number
  readonly elapsedMs: number
}
export const DEFAULT_CHILD_WATCHDOG_CONFIG: ChildWatchdogConfig = {
  childAdmissionMs: 30_000, childNoProgressMs: 180_000, childMaxRunMs: 1_200_000,
  childReportGraceMs: 15_000, childCancelGraceMs: 15_000,
}
export function childScheduler(): ChildWatchdogScheduler {
  return {
    now: () => performance.now(),
    set(callback, delayMs) { const timer = setTimeout(callback, delayMs); timer.unref?.(); return timer },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}
export function resolveChildWatchdogConfig(config: Partial<ChildWatchdogConfig> = {}): ChildWatchdogConfig {
  const duration = (value: unknown, fallback: number, name: string): number => {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || (result as number) < 1_000 || (result as number) > 2_147_483_647) {
      throw new Error(`${name} must be a safe integer between 1000 and 2147483647ms`)
    }
    return result as number
  }
  const selected = Object.fromEntries(Object.entries(DEFAULT_CHILD_WATCHDOG_CONFIG)
    .map(([key, fallback]) => [key, duration(config[key as keyof ChildWatchdogConfig], fallback, key)])) as unknown as ChildWatchdogConfig
  const overrides = config.childRoleBudgets ?? {}
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('childRoleBudgets must be a role map')
  const budgets: Partial<Record<ChildRole, ChildRoleBudget>> = {}
  for (const [role, budget] of Object.entries(overrides)) {
    if (!['architect', 'engineer', 'test_engineer', 'code_reviewer', 'acceptance_qa'].includes(role)) throw new Error(`unsupported child budget role ${role}`)
    if (!budget || typeof budget !== 'object' || Object.keys(budget).some(key => !['noProgressMs', 'maxRunMs'].includes(key))) throw new Error(`invalid child budget for ${role}`)
    const noProgressMs = duration(budget.noProgressMs, selected.childNoProgressMs, `${role}.noProgressMs`)
    const maxRunMs = duration(budget.maxRunMs, selected.childMaxRunMs, `${role}.maxRunMs`)
    if (maxRunMs < noProgressMs) throw new Error(`${role} maxRunMs must cover noProgressMs`)
    budgets[role as ChildRole] = { noProgressMs, maxRunMs }
  }
  if (selected.childMaxRunMs < selected.childNoProgressMs) throw new Error('childMaxRunMs must cover childNoProgressMs')
  return { ...selected, childRoleBudgets: budgets }
}

interface Watch {
  readonly role: ChildRole
  readonly startedAt: number
  lastProgressAt: number
  admitted: boolean
  reportedAt?: number
  disposedAt?: number
  timer?: unknown
}

/** One clock chain per exact dispatch object, not per reusable Session id. */
export class ChildLeaseWatchdog<T extends object> {
  private readonly watches = new Map<T, Watch>()
  constructor(
    readonly config: ChildWatchdogConfig,
    readonly scheduler: ChildWatchdogScheduler,
    private readonly expire: (token: T, observation: ChildBudgetExpiry) => void,
  ) {}
  watch(token: T, role: ChildRole): void {
    this.forget(token)
    const now = this.scheduler.now()
    this.watches.set(token, { role, startedAt: now, lastProgressAt: now, admitted: false })
    this.arm(token)
  }
  admitted(token: T): void {
    const state = this.watches.get(token)
    if (!state) return
    state.admitted = true
    state.lastProgressAt = this.scheduler.now()
    this.arm(token)
  }
  progress(token: T): void {
    const state = this.watches.get(token)
    if (!state || !state.admitted || state.reportedAt !== undefined || state.disposedAt !== undefined) return
    state.lastProgressAt = this.scheduler.now()
    this.arm(token)
  }
  reported(token: T): void {
    const state = this.watches.get(token)
    if (!state || state.reportedAt !== undefined) return
    state.reportedAt = this.scheduler.now()
    this.arm(token)
  }
  disposed(token: T): void {
    const state = this.watches.get(token)
    if (!state || state.disposedAt !== undefined) return
    state.disposedAt = this.scheduler.now()
    this.arm(token)
  }
  forget(token: T): void {
    const state = this.watches.get(token)
    if (state?.timer !== undefined) this.scheduler.clear(state.timer)
    this.watches.delete(token)
  }
  close(): void { for (const token of this.watches.keys()) this.forget(token) }
  private arm(token: T): void {
    const state = this.watches.get(token)
    if (!state) return
    if (state.timer !== undefined) this.scheduler.clear(state.timer)
    const roleBudget = this.config.childRoleBudgets?.[state.role]
    const candidates: { cause: ChildBudgetExpiry['cause']; start: number; budget: number }[] = [
      { cause: 'deadline', start: state.startedAt, budget: roleBudget?.maxRunMs ?? this.config.childMaxRunMs },
      state.reportedAt !== undefined
        ? { cause: 'report-timeout', start: state.reportedAt, budget: this.config.childReportGraceMs }
        : !state.admitted
          ? { cause: 'admission-timeout', start: state.startedAt, budget: this.config.childAdmissionMs }
          : { cause: 'no-progress', start: state.lastProgressAt, budget: roleBudget?.noProgressMs ?? this.config.childNoProgressMs },
    ]
    if (state.disposedAt !== undefined) candidates.push({ cause: 'disposed', start: state.disposedAt, budget: this.config.childReportGraceMs })
    const first = candidates.sort((a, b) => a.start + a.budget - b.start - b.budget)[0]!
    state.timer = this.scheduler.set(() => {
      if (this.watches.get(token) !== state) return
      const elapsedMs = Math.floor(this.scheduler.now() - first.start)
      if (elapsedMs < first.budget) { this.arm(token); return }
      this.forget(token)
      this.expire(token, { cause: first.cause, budgetMs: first.budget, elapsedMs })
    }, Math.max(0, first.start + first.budget - this.scheduler.now()))
  }
}

/** Attach both handlers so a late cleanup rejection can never go unobserved. */
export function withinChildGrace(work: Promise<unknown>, graceMs: number, scheduler: ChildWatchdogScheduler): Promise<boolean> {
  return new Promise(resolve => {
    const timer = scheduler.set(() => resolve(false), graceMs)
    work.then(() => { scheduler.clear(timer); resolve(true) }, () => { scheduler.clear(timer); resolve(false) })
  })
}
export function abortableAdmission(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('child admission cancelled')) }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
