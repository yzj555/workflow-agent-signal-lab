import { randomUUID } from 'node:crypto'
import type { WorkflowJournal } from '../workflow-journal.ts'
import { WorkflowJournalError } from '../workflow-journal.ts'
import { RUN_TIME_SLICE_MS, RunBudgetExceeded } from '../workflow-run-budget.ts'
import type { ChildWatchdogScheduler } from './workflow-child-watchdog.ts'
import { childScheduler } from './workflow-child-watchdog.ts'

interface ClockRun {
  rootId: string; runId: string; root: boolean; waiting: boolean; children: Set<string>
  last: number; elapsed: number; overrun: number; credit: number; cap: number
  sealed: boolean; timer?: unknown; boundary?: unknown; queue: Promise<void>
}

/** Union of funded root/child execution intervals, never a sum of parallel roles. */
export class WorkflowRunTime {
  readonly ownerId = randomUUID()
  private readonly runs = new Map<string, ClockRun>()
  private closed = false
  constructor(private readonly journal: WorkflowJournal,
    private readonly stop: (rootId: string, runId: string, error: Error) => void,
    private readonly report: (error: unknown) => void = () => {},
    private readonly clock: ChildWatchdogScheduler = childScheduler()) {}

  private active(s: ClockRun): boolean { return !s.sealed && (s.children.size > 0 || (s.root && !s.waiting)) }
  private sample(s: ClockRun): void {
    const now = this.clock.now()
    if (!Number.isFinite(now) || now < s.last) throw new Error('有效时长的单调时钟无效；不能用系统墙钟补算')
    if (this.active(s)) s.elapsed += now - s.last
    s.last = now
  }
  private clear(s: ClockRun): void {
    if (s.timer !== undefined) this.clock.clear(s.timer)
    if (s.boundary !== undefined) this.clock.clear(s.boundary)
    s.timer = undefined; s.boundary = undefined
  }
  private notifyStop(s: ClockRun, error: Error): void {
    if (s.sealed) return
    s.sealed = true; s.root = false; s.children.clear(); this.clear(s)
    this.stop(s.rootId, s.runId, error)
  }
  private fault(s: ClockRun, error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error))
    const capacity = error instanceof WorkflowJournalError && (error.code === 'capacity'
      || (error.code === 'limit' && this.journal.readSnapshot(s.rootId).capacity))
    if (!capacity) this.journal.sealTimeAccounting(reason)
    this.notifyStop(s, reason)
    try { this.report(reason) } catch { /* observer cannot reopen admission */ }
  }
  private check(s: ClockRun): boolean {
    this.sample(s)
    if (!this.active(s) || s.elapsed < s.credit) return !s.sealed
    if (s.credit < s.cap) {
      this.fault(s, new Error('整轮计时凭据未能及时续期；新执行已封闭，请重新打开存储核实。这不是预算耗尽。'))
    } else {
      s.overrun += Math.max(0, Math.floor(s.elapsed) - s.cap)
      s.elapsed = s.cap
      this.notifyStop(s, new RunBudgetExceeded())
      void this.sync(s, false).catch(error => this.report(error))
    }
    return false
  }
  private arm(s: ClockRun): void {
    this.clear(s)
    if (!this.active(s)) return
    const remaining = Math.max(0, s.credit - s.elapsed)
    s.boundary = this.clock.set(() => {
      // Timers are integer milliseconds; the monotonic clock is fractional.
      // An early wakeup is not expiry and must not consume our only observer.
      try { if (this.check(s)) this.arm(s) } catch (error) { this.fault(s, error) }
    }, Math.max(1, Math.ceil(remaining)))
    // Renew well before the existing durable grant expires; its independent
    // boundary remains armed during slow SQLite I/O.
    if (s.credit < s.cap) s.timer = this.clock.set(() => {
      try {
        if (!this.check(s)) return
        void this.sync(s, true).catch(error => this.fault(s, error))
      } catch (error) { this.fault(s, error) }
    }, Math.max(1, Math.ceil(remaining - RUN_TIME_SLICE_MS / 2)))
  }

  private sync(s: ClockRun, ensure: boolean): Promise<void> {
    const work = s.queue.then(async () => {
      this.check(s)
      const account = this.journal.readRunBudget(s.rootId, s.runId)
      if (!account?.time || account.limits.activeMs === undefined) return
      const time = account.time
      if (account.blocked && !s.sealed) this.notifyStop(s, new RunBudgetExceeded())
      if (time.reservedMs && time.ownerId !== this.ownerId) throw new Error('发现旧 Host 未结算的计时，必须先执行冷恢复')
      const elapsed = Math.max(0, Math.min(time.reservedMs, Math.floor(s.elapsed) - time.observedMs))
      const release = !this.active(s) && !ensure
      const reserve = !s.sealed && !account.blocked && !account.recovery?.awaitingResume
        && (ensure || this.active(s)) && time.reservedMs - elapsed <= RUN_TIME_SLICE_MS / 2 ? RUN_TIME_SLICE_MS : 0
      if (!elapsed && !reserve && !s.overrun && !(release && time.reservedMs)) { this.arm(s); return }
      const overrun = s.overrun; s.overrun = 0
      const snapshot = await this.journal.updateRunTime(s.rootId, s.runId, this.ownerId,
        { elapsedMs: elapsed, reserveMs: reserve, release, overrunMs: overrun })
      const next = snapshot.run!.budget!
      s.credit = next.time!.observedMs + next.time!.reservedMs
      s.cap = next.limits.activeMs! - next.time!.uncertainMs
      if (!s.sealed) {
        if (next.blocked) this.notifyStop(s, new RunBudgetExceeded())
        else if (this.check(s)) this.arm(s)
      }
    })
    s.queue = work.then(() => {}, () => {})
    return work
  }

  async enter(rootId: string, runId: string, actor: string, waiting = false): Promise<void> {
    if (this.closed) throw new Error('整轮计时已关闭')
    const account = this.journal.readRunBudget(rootId, runId)
    if (!account?.time) return // No retroactive clock on old runs.
    if (account.blocked || account.recovery?.awaitingResume) throw new RunBudgetExceeded()
    let s = this.runs.get(rootId)
    if (!s || s.runId !== runId || s.sealed) {
      if (s && this.active(s)) throw new Error('旧运行的计时尚未结束，不能替换')
      if (s) {
        await s.queue
        // Another admission may have replaced this stopped state while its
        // final checkpoint was pending. Never create two clocks for one run.
        if (this.runs.get(rootId) !== s) return this.enter(rootId, runId, actor, waiting)
      }
      if (this.closed) throw new Error('整轮计时已关闭')
      const latest = this.journal.readRunBudget(rootId, runId)!
      if (latest.blocked || latest.recovery?.awaitingResume) throw new RunBudgetExceeded()
      s = { rootId, runId, root: false, waiting, children: new Set(), last: this.clock.now(),
        elapsed: latest.time!.observedMs, overrun: 0,
        credit: latest.time!.observedMs + latest.time!.reservedMs,
        cap: latest.limits.activeMs! - latest.time!.uncertainMs, sealed: false, queue: Promise.resolve() }
      this.runs.set(rootId, s)
    }
    try {
      if (!this.check(s)) throw new RunBudgetExceeded()
      await this.sync(s, true)
      if (s.sealed || this.closed || !this.check(s)) throw new RunBudgetExceeded()
      if (actor === 'root') { s.root = true; s.waiting = waiting }
      else s.children.add(actor)
      s.last = this.clock.now()
      this.arm(s)
    } catch (error) {
      if (!(error instanceof RunBudgetExceeded)) this.fault(s, error)
      throw error
    }
  }

  leave(rootId: string, actor: string): void {
    const s = this.runs.get(rootId)
    if (!s) return
    try {
      this.check(s)
      if (actor === 'root') s.root = false
      else s.children.delete(actor)
      this.arm(s)
      void this.sync(s, false).catch(error => this.fault(s, error))
    } catch (error) { this.fault(s, error) }
  }
  waiting(rootId: string, waiting: boolean): void {
    const s = this.runs.get(rootId)
    if (!s || !s.root || s.waiting === waiting) return
    try {
      this.check(s); s.waiting = waiting
      // On answer, durable re-admission happens before the next model request;
      // prevent unreserved time between the answer and that request.
      if (!waiting) s.root = false
      this.arm(s)
      void this.sync(s, false).catch(error => this.fault(s, error))
    } catch (error) { this.fault(s, error) }
  }
  halt(rootId: string): void {
    const s = this.runs.get(rootId)
    if (!s) return
    try { this.check(s); s.root = false; s.children.clear(); this.clear(s)
      void this.sync(s, false).catch(error => this.fault(s, error))
    } catch (error) { this.fault(s, error) }
  }
  assertAdmitted(rootId: string, runId: string): void {
    const s = this.runs.get(rootId)
    if (s?.runId !== runId) return
    try { if (s.sealed || !this.check(s)) throw new RunBudgetExceeded() }
    catch (error) {
      if (!(error instanceof RunBudgetExceeded)) this.fault(s, error)
      throw error
    }
  }
  async flush(rootId: string): Promise<void> {
    const s = this.runs.get(rootId)
    if (!s) return
    while (true) { const work = s.queue; await work; if (work === s.queue) return }
  }
  async release(rootId: string): Promise<void> { this.halt(rootId); await this.flush(rootId); this.runs.delete(rootId) }
  async close(): Promise<void> {
    this.closed = true
    for (const id of this.runs.keys()) this.halt(id)
    await Promise.all([...this.runs.keys()].map(id => this.flush(id)))
    this.runs.clear()
  }
}
