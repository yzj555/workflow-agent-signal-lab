import { AsyncLocalStorage } from 'node:async_hooks'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { childScheduler } from './workflow-child-watchdog.ts'
import type { ChildWatchdogScheduler } from './workflow-child-watchdog.ts'

export interface CommandRuntimeConfig {
  readonly commandTimeoutMs: number
  readonly commandExitGraceMs: number
}
export const DEFAULT_COMMAND_CONFIG: CommandRuntimeConfig = { commandTimeoutMs: 120_000, commandExitGraceMs: 15_000 }
export function resolveCommandConfig(config: Partial<CommandRuntimeConfig> = {}): CommandRuntimeConfig {
  const result = { ...DEFAULT_COMMAND_CONFIG }
  for (const key of ['commandTimeoutMs', 'commandExitGraceMs'] as const) {
    const value = config[key] ?? result[key]
    if (!Number.isSafeInteger(value) || value < 1000 || value > 120_000) throw new Error(`${key} must be a safe integer between 1000 and 120000ms`)
    result[key] = value
  }
  return result
}
export type CommandInterruption = 'command-timeout' | 'command-cancelled' | 'command-exit-unknown' | 'command-execution-error'
export interface CommandObservation {
  readonly timeoutMs: number
  readonly elapsedMs: number
  readonly processCount: number
  readonly exitConfirmed: boolean
  readonly toolSettled: boolean
  readonly cause?: CommandInterruption
  readonly result?: ToolExecutionResult
  readonly diagnostic?: string
}
interface Invocation {
  readonly signal: AbortSignal
  readonly handles: SubprocessHandle[]
  readonly exits: Promise<boolean>[]
  readonly observeSignal: AbortSignal
  readonly interrupt: (cause: CommandInterruption) => void
  sealed: boolean
}

/** Host-owned per-call scope, shared through the controller service (not bundle globals).
 * Never replaces argv, cwd, environment, sandbox policy, or the native executor.
 */
export class WorkflowCommandRuntime {
  private readonly scope = new AsyncLocalStorage<Invocation>()
  constructor(readonly config = DEFAULT_COMMAND_CONFIG, private readonly clock: ChildWatchdogScheduler = childScheduler()) {}

  /** Used ONLY by the preset-local official subprocess decorator. */
  spawn(provider: Pick<SubprocessRuntime, 'spawn'>, spec: SubprocessSpawnSpec): SubprocessHandle {
    const call = this.scope.getStore()
    if (!call || call.sealed || call.signal.aborted) throw new Error('冻结命令派发凭据失效；未启动进程')
    if (call.handles.length) throw new Error('一次冻结前台命令只允许一个官方托管范围')
    const handle = provider.spawn(spec)
    call.handles.push(handle)
    // Observe immediately, independently of direct-command/stdio completion.
    const exited = Promise.resolve().then(() => handle.waitForExit(call.observeSignal)).then(value => {
      if (!value) call.interrupt('command-exit-unknown')
      return value === true
    }, () => { call.interrupt('command-exit-unknown'); return false })
    call.exits.push(exited)
    // A provider may reject done before the native executor has installed its reader.
    void handle.done.catch(() => {})
    return handle
  }

  async run(
    exec: ToolDispatchExecution,
    leaseSignal: AbortSignal,
    timeoutMs: number,
    dispatch: () => Promise<ToolExecutionResult>,
    onInterrupt: (cause: CommandInterruption, elapsedMs: number) => void,
  ): Promise<CommandObservation> {
    const started = this.clock.now()
    const upstream = exec.signal
    const cancel = new AbortController(), observation = new AbortController()
    const interrupted = Promise.withResolvers<void>()
    let cause: CommandInterruption | undefined
    let result: ToolExecutionResult | undefined
    let diagnostic: string | undefined
    let toolSettled = false
    let graceTimer: unknown
    const graceEnded = Promise.withResolvers<void>()
    const call: Invocation = {
      signal: cancel.signal, handles: [], exits: [], observeSignal: observation.signal, sealed: false,
      interrupt: reason => {
        if (cause) return
        cause = reason
        // Seal before cancellation callbacks: a late executor cannot start another process.
        call.sealed = true
        graceTimer = this.clock.set(() => graceEnded.resolve(), this.config.commandExitGraceMs)
        cancel.abort(new Error(reason))
        for (const handle of call.handles) {
          try { handle.terminate() } catch { /* missing exit proof remains unknown */ }
        }
        interrupted.resolve()
        onInterrupt(reason, Math.max(0, Math.round(this.clock.now() - started)))
      },
    }
    const onCancel = () => call.interrupt('command-cancelled')
    upstream.addEventListener('abort', onCancel, { once: true })
    leaseSignal.addEventListener('abort', onCancel, { once: true })
    const timer = this.clock.set(() => call.interrupt('command-timeout'), timeoutMs)
    exec.signal = AbortSignal.any([upstream, leaseSignal, cancel.signal])
    try {
      if (upstream.aborted || leaseSignal.aborted) onCancel()
      const work = this.scope.run(call, async () => {
        try {
          if (call.sealed) return
          result = await dispatch()
          if (result.isError) {
            diagnostic = result.error?.message?.slice(0, 600)
            call.interrupt('command-execution-error')
          }
          else {
            const value = result.value as { kind?: unknown; timedOut?: unknown; aborted?: unknown; exitCode?: unknown; signal?: unknown; sandbox?: { denied?: boolean; runnerFailed?: boolean } } | undefined
            if (value?.timedOut === true) call.interrupt('command-timeout')
            else if (value?.aborted === true) call.interrupt('command-cancelled')
            else if (value?.signal != null) call.interrupt('command-cancelled')
            else if (value?.kind !== 'foreground' || !Number.isSafeInteger(value.exitCode)
              || value.timedOut !== false || value.aborted !== false || value.sandbox?.denied || value.sandbox?.runnerFailed) call.interrupt('command-execution-error')
          }
        } catch (error) { diagnostic = String(error).slice(0, 600); call.interrupt('command-execution-error') }
        finally { toolSettled = true }
      })
      const completed = work.then(async () => {
        // A replaced shell which bypasses the documented subprocess seam cannot attest exit.
        if (call.handles.length !== 1) call.interrupt('command-exit-unknown')
        const exits = await Promise.all(call.exits)
        return call.handles.length === 1 && exits.every(Boolean)
      })
      const first = await Promise.race([completed.then(exit => ({ exit })), interrupted.promise.then(() => undefined)])
      let exitConfirmed: boolean
      if (first !== undefined && !cause) exitConfirmed = first.exit
      else {
        const drained = await Promise.race([completed.then(exit => ({ exit })), graceEnded.promise.then(() => undefined)])
        exitConfirmed = drained?.exit === true
      }
      return { timeoutMs, elapsedMs: Math.max(0, Math.round(this.clock.now() - started)),
        processCount: call.handles.length, exitConfirmed, toolSettled, ...(cause ? { cause } : {}), ...(result ? { result } : {}), ...(diagnostic ? { diagnostic } : {}) }
    } finally {
      call.sealed = true
      this.clock.clear(timer)
      if (graceTimer !== undefined) this.clock.clear(graceTimer)
      upstream.removeEventListener('abort', onCancel)
      leaseSignal.removeEventListener('abort', onCancel)
      observation.abort()
      exec.signal = upstream
    }
  }
}
