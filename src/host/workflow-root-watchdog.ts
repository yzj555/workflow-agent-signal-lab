import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { WorkflowRuntimeRecoveryState } from '../workflow-events.ts'
import type { RootRecoveryDirective, RootStallObservation } from './workflow-controller.ts'

export interface RootTurnWatchdogConfig {
  readonly rootTurnNoProgressMs: number
  readonly rootRecoveryNoProgressMs: number
  readonly rootCancelGraceMs: number
  readonly userWaitProbeMs: number
  /** Disabled unless exact, local-only diagnostic fixtures are configured by the Host. */
  readonly faultInjections?: readonly RootTurnFaultInjection[]
}

export interface RootTurnFaultInjection {
  readonly rootSessionId: string
  readonly rootTurnNoProgressMs: number
  readonly rootRecoveryNoProgressMs: number
  readonly mode: 'first-stall-only' | 'first-and-recovery'
  readonly acknowledge: 'controlled-local-only'
}

export const DEFAULT_ROOT_TURN_WATCHDOG_CONFIG: RootTurnWatchdogConfig = {
  rootTurnNoProgressMs: 180_000,
  rootRecoveryNoProgressMs: 120_000,
  rootCancelGraceMs: 15_000,
  userWaitProbeMs: 30_000,
}

export interface RootTurnWatchdogScheduler {
  now(): number
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface RootTurnWatchdogCoordinator {
  isBoundRoot(agent: Agent): boolean
  isAwaitingUser(agent: Agent): boolean
  currentRootRecovery(agent: Agent): WorkflowRuntimeRecoveryState | undefined
  recordRootStall(agent: Agent, observation: RootStallObservation): Promise<RootRecoveryDirective>
  settleRootRecovery(agent: Agent, incidentId: string, outcome: 'resumed' | 'needs-attention', summary: string): Promise<boolean>
}

export interface RootTurnWatchdogDriver {
  cancel(agent: Agent): void
  whenIdle(agent: Agent): Promise<void>
  continue(agent: Agent, prompt: string): void
}

type RecoveryChain = {
  readonly incidentId: string
  mode: 'awaiting-auto-turn' | 'auto-turn-running' | 'settling' | 'needs-attention'
}

interface WatchedRoot {
  readonly agent: Agent
  running: boolean
  turn: number
  lastProgressAt: number
  timer?: unknown
  handling: boolean
  chain?: RecoveryChain
}

function defaultScheduler(): RootTurnWatchdogScheduler {
  return {
    now: Date.now,
    set(callback, delayMs) {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
      return timer
    },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}

function positiveDuration(value: unknown, fallback: number, label: string): number {
  const selected = value === undefined ? fallback : value
  if (!Number.isSafeInteger(selected) || (selected as number) < 1_000) {
    throw new Error(`${label} must be a safe integer >= 1000ms`)
  }
  return selected as number
}

function controlledFaultDuration(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 100) {
    throw new Error(`${label} must be a safe integer >= 100ms`)
  }
  return value as number
}

function faultInjections(value: unknown): readonly RootTurnFaultInjection[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) throw new Error('faultInjections must be an array with at most 8 entries')
  const result = value.map((candidate, index): RootTurnFaultInjection => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`faultInjections[${String(index)}] must be an object`)
    }
    const entry = candidate as Record<string, unknown>
    const keys = ['rootSessionId', 'rootTurnNoProgressMs', 'rootRecoveryNoProgressMs', 'mode', 'acknowledge']
    if (Object.keys(entry).some(key => !keys.includes(key))) {
      throw new Error(`faultInjections[${String(index)}] contains undeclared fields`)
    }
    if (typeof entry.rootSessionId !== 'string'
      || !/^workflow-timeout-fixture-[a-z0-9-]{1,180}$/u.test(entry.rootSessionId)) {
      throw new Error(`faultInjections[${String(index)}].rootSessionId must be one exact workflow-timeout-fixture-* id`)
    }
    if (entry.mode !== 'first-stall-only' && entry.mode !== 'first-and-recovery') {
      throw new Error(`faultInjections[${String(index)}].mode is invalid`)
    }
    if (entry.acknowledge !== 'controlled-local-only') {
      throw new Error(`faultInjections[${String(index)}] requires acknowledge=controlled-local-only`)
    }
    return {
      rootSessionId: entry.rootSessionId,
      rootTurnNoProgressMs: controlledFaultDuration(entry.rootTurnNoProgressMs,
        `faultInjections[${String(index)}].rootTurnNoProgressMs`),
      rootRecoveryNoProgressMs: controlledFaultDuration(entry.rootRecoveryNoProgressMs,
        `faultInjections[${String(index)}].rootRecoveryNoProgressMs`),
      mode: entry.mode,
      acknowledge: entry.acknowledge,
    }
  })
  if (new Set(result.map(entry => entry.rootSessionId)).size !== result.length) {
    throw new Error('faultInjections rootSessionId values must be unique')
  }
  return result
}

export function resolveRootTurnWatchdogConfig(config: Partial<RootTurnWatchdogConfig> = {}): RootTurnWatchdogConfig {
  return {
    rootTurnNoProgressMs: positiveDuration(config.rootTurnNoProgressMs,
      DEFAULT_ROOT_TURN_WATCHDOG_CONFIG.rootTurnNoProgressMs, 'rootTurnNoProgressMs'),
    rootRecoveryNoProgressMs: positiveDuration(config.rootRecoveryNoProgressMs,
      DEFAULT_ROOT_TURN_WATCHDOG_CONFIG.rootRecoveryNoProgressMs, 'rootRecoveryNoProgressMs'),
    rootCancelGraceMs: positiveDuration(config.rootCancelGraceMs,
      DEFAULT_ROOT_TURN_WATCHDOG_CONFIG.rootCancelGraceMs, 'rootCancelGraceMs'),
    userWaitProbeMs: positiveDuration(config.userWaitProbeMs,
      DEFAULT_ROOT_TURN_WATCHDOG_CONFIG.userWaitProbeMs, 'userWaitProbeMs'),
    faultInjections: faultInjections(config.faultInjections),
  }
}

/**
 * Process-local root-turn supervisor. Durable incident ownership remains in
 * WorkflowTextController and its Journal; this class only owns clocks and the
 * exact live Agent capability.
 */
export class RootTurnWatchdog {
  private readonly roots = new Map<string, WatchedRoot>()
  private closed = false

  constructor(
    private readonly coordinator: RootTurnWatchdogCoordinator,
    private readonly driver: RootTurnWatchdogDriver,
    private readonly config: RootTurnWatchdogConfig = DEFAULT_ROOT_TURN_WATCHDOG_CONFIG,
    private readonly scheduler: RootTurnWatchdogScheduler = defaultScheduler(),
    private readonly reportError: (error: unknown) => void = () => {},
  ) {}

  bind(agent: Agent): void {
    if (this.closed || !this.coordinator.isBoundRoot(agent)) return
    let state = this.roots.get(agent.id)
    if (state?.agent !== agent) {
      if (state?.timer !== undefined) this.scheduler.clear(state.timer)
      state = {
        agent,
        running: false,
        turn: 0,
        lastProgressAt: this.scheduler.now(),
        handling: false,
      }
      this.roots.set(agent.id, state)
    }
    const persisted = this.coordinator.currentRootRecovery(agent)
    if (persisted) state.chain = { incidentId: persisted.incidentId, mode: 'needs-attention' }
    if (persisted?.status === 'recovering') {
      void this.pauseInterruptedRecovery(state, persisted)
      return
    }
    this.observeStatus(agent, agent.status)
  }

  observeStatus(agent: Agent, status: AgentStatus): void {
    if (this.closed || !this.coordinator.isBoundRoot(agent)) return
    const state = this.ensure(agent)
    if (status === 'running') {
      if (state.running) return
      state.running = true
      // A new native turn can arrive while the previous automatic recovery is
      // still being durably settled. Do not start a clock against stale
      // Journal state; finishRecoveredTurn will arm a fresh budget afterwards.
      if (state.chain?.mode === 'settling') return
      if (state.chain?.mode === 'awaiting-auto-turn') {
        state.chain.mode = 'auto-turn-running'
        this.beginBudget(state)
        return
      }
      if (state.chain?.mode === 'needs-attention') {
        const incidentId = state.chain.incidentId
        state.chain = undefined
        state.handling = true
        void this.coordinator.settleRootRecovery(
          agent, incidentId, 'resumed', '用户或新的原生输入重新启动了根协调轮次；建立新的限时监督链。',
        ).catch(this.reportError).finally(() => {
          state.handling = false
          if (state.running) this.beginBudget(state)
        })
        return
      }
      this.beginBudget(state)
      return
    }

    state.running = false
    this.clearTimer(state)
    if (state.chain?.mode === 'auto-turn-running' && !state.handling) this.finishRecoveredTurn(state)
  }

  observeSessionEvent(agent: Agent, event: { readonly type: string; readonly data?: unknown }): void {
    if (this.closed || !this.coordinator.isBoundRoot(agent)) return
    const state = this.ensure(agent)
    if (event.type === 'turn/start' && event.data && typeof event.data === 'object') {
      const turn = (event.data as { turn?: unknown }).turn
      if (Number.isSafeInteger(turn) && (turn as number) > 0) state.turn = turn as number
    }
    this.touch(state)
  }

  observeAssistantFrame(agent: Agent): void {
    if (this.closed || !this.coordinator.isBoundRoot(agent)) return
    this.touch(this.ensure(agent))
  }

  /** Start/settle notifications come from observed native requests, not tool names or text. */
  observeUserWait(agent: Agent): void {
    if (this.closed || !this.coordinator.isBoundRoot(agent)) return
    const state = this.roots.get(agent.id)
    if (state?.agent !== agent || !state.running || state.handling) return
    state.lastProgressAt = this.scheduler.now()
    this.arm(state, this.coordinator.isAwaitingUser(agent) ? this.config.userWaitProbeMs : this.budget(state))
  }

  dispose(agent: Agent): void {
    const state = this.roots.get(agent.id)
    if (state?.agent !== agent) return
    this.clearTimer(state)
    this.roots.delete(agent.id)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const state of this.roots.values()) this.clearTimer(state)
    this.roots.clear()
  }

  private ensure(agent: Agent): WatchedRoot {
    const existing = this.roots.get(agent.id)
    if (existing?.agent === agent) return existing
    const state: WatchedRoot = {
      agent,
      running: false,
      turn: 0,
      lastProgressAt: this.scheduler.now(),
      handling: false,
    }
    this.roots.set(agent.id, state)
    return state
  }

  private touch(state: WatchedRoot): void {
    if (!state.running || state.handling) return
    if (this.suppressesProgress(state)) return
    state.lastProgressAt = this.scheduler.now()
    this.arm(state, this.budget(state))
  }

  private beginBudget(state: WatchedRoot): void {
    state.lastProgressAt = this.scheduler.now()
    this.arm(state, this.budget(state))
  }

  private budget(state: WatchedRoot): number {
    const injection = this.faultInjection(state)
    if (injection) {
      return state.chain?.mode === 'auto-turn-running'
        ? injection.rootRecoveryNoProgressMs
        : injection.rootTurnNoProgressMs
    }
    return state.chain?.mode === 'auto-turn-running'
      ? this.config.rootRecoveryNoProgressMs
      : this.config.rootTurnNoProgressMs
  }

  private faultInjection(state: WatchedRoot): RootTurnFaultInjection | undefined {
    return this.config.faultInjections?.find(entry => entry.rootSessionId === state.agent.id)
  }

  private suppressesProgress(state: WatchedRoot): boolean {
    const injection = this.faultInjection(state)
    if (!injection) return false
    return injection.mode === 'first-and-recovery' || state.chain?.mode !== 'auto-turn-running'
  }

  private arm(state: WatchedRoot, delayMs: number): void {
    this.clearTimer(state)
    if (this.closed || !state.running) return
    state.timer = this.scheduler.set(() => {
      state.timer = undefined
      void this.timeout(state).catch(this.reportError)
    }, delayMs)
  }

  private clearTimer(state: WatchedRoot): void {
    if (state.timer === undefined) return
    this.scheduler.clear(state.timer)
    state.timer = undefined
  }

  private async timeout(state: WatchedRoot): Promise<void> {
    if (this.closed || !state.running || state.handling || !this.coordinator.isBoundRoot(state.agent)) return
    if (this.coordinator.isAwaitingUser(state.agent)) {
      state.lastProgressAt = this.scheduler.now()
      this.arm(state, this.config.userWaitProbeMs)
      return
    }
    const elapsed = this.scheduler.now() - state.lastProgressAt
    const budget = this.budget(state)
    if (elapsed < budget) {
      this.arm(state, budget - elapsed)
      return
    }

    state.handling = true
    this.clearTimer(state)
    try {
      this.driver.cancel(state.agent)
      const idle = await this.waitForIdle(state.agent)
      if (!idle) throw new Error(`root Agent ${state.agent.id} did not converge to idle after cancellation`)
      const directive = await this.coordinator.recordRootStall(state.agent, {
        turn: Math.max(1, state.turn),
        noProgressMs: Math.max(budget, elapsed),
        ...(this.suppressesProgress(state) ? { faultInjected: true } : {}),
      })
      if (directive.kind === 'auto-continue' && directive.incidentId && directive.prompt) {
        state.chain = { incidentId: directive.incidentId, mode: 'awaiting-auto-turn' }
        this.driver.continue(state.agent, directive.prompt)
      } else if (directive.incidentId) {
        state.chain = { incidentId: directive.incidentId, mode: 'needs-attention' }
      } else {
        state.chain = undefined
      }
    } finally {
      state.handling = false
      if (!state.running && state.chain?.mode === 'auto-turn-running') this.finishRecoveredTurn(state)
      else if (state.running && state.timer === undefined) this.arm(state, this.budget(state))
    }
  }

  private waitForIdle(agent: Agent): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      const timer = this.scheduler.set(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, this.config.rootCancelGraceMs)
      this.driver.whenIdle(agent).then(() => {
        if (settled) return
        settled = true
        this.scheduler.clear(timer)
        resolve(true)
      }, error => {
        if (settled) return
        settled = true
        this.scheduler.clear(timer)
        reject(error)
      })
    })
  }

  private finishRecoveredTurn(state: WatchedRoot): void {
    const incidentId = state.chain?.incidentId
    if (!incidentId || state.chain?.mode !== 'auto-turn-running') return
    state.chain.mode = 'settling'
    state.handling = true
    void this.coordinator.settleRootRecovery(
      state.agent, incidentId, 'resumed', '自动恢复轮次已正常回到 idle；本次恢复链结束。',
    ).then(() => {
      if (state.chain?.incidentId === incidentId && state.chain.mode === 'settling') state.chain = undefined
    }, error => {
      // A failed durable settlement must never reopen an automatic retry loop.
      // Keep the incident paused in memory; a later native turn can reconcile
      // the exact Journal marker through the normal needs-attention path.
      if (state.chain?.incidentId === incidentId) state.chain.mode = 'needs-attention'
      this.reportError(error)
    }).finally(() => {
      state.handling = false
      if (state.running && state.chain?.mode !== 'needs-attention') this.beginBudget(state)
    })
  }

  private async pauseInterruptedRecovery(state: WatchedRoot, persisted: WorkflowRuntimeRecoveryState): Promise<void> {
    state.handling = true
    try {
      if (state.agent.status === 'running') {
        state.running = true
        this.driver.cancel(state.agent)
        const idle = await this.waitForIdle(state.agent)
        if (!idle) throw new Error(`root Agent ${state.agent.id} did not converge to idle after lifecycle recovery cancellation`)
      }
      await this.coordinator.settleRootRecovery(
        state.agent,
        persisted.incidentId,
        'needs-attention',
        'Host 或插件生命周期在自动恢复完成前发生变化；未猜测续跑，已转为需要处理。',
      )
      state.chain = { incidentId: persisted.incidentId, mode: 'needs-attention' }
    } catch (error) {
      this.reportError(error)
    } finally {
      state.handling = false
      state.running = state.agent.status === 'running'
      if (state.running && state.chain?.mode !== 'needs-attention') this.beginBudget(state)
    }
  }
}
