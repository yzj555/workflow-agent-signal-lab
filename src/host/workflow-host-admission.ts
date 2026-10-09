import { z } from 'zod'
import type { WorkflowRunState } from '../workflow-events.ts'

export interface HostAdmissionConfig {
  hostAdmissionEnabled: boolean
  hostMaxActiveRoots: number
  hostMaxRoleExecutions: number
}
export function resolveHostAdmissionConfig(config: Partial<HostAdmissionConfig> = {}): HostAdmissionConfig {
  return {
    hostAdmissionEnabled: z.boolean().parse(config.hostAdmissionEnabled ?? false),
    hostMaxActiveRoots: z.int().min(1).max(8).parse(config.hostMaxActiveRoots ?? 2),
    // The fixed project DAG can require a two-role wave; do not strand it.
    hostMaxRoleExecutions: z.int().min(2).max(16).parse(config.hostMaxRoleExecutions ?? 4),
  }
}
export interface HostRoleClaim {
  readonly key: string
  readonly rootSessionId: string
  readonly state: 'running' | 'unconfirmed' | 'reserved'
}
export const hostRoleKey = (root: string, run: string, assignment: string, version: number): string =>
  JSON.stringify([root, run, assignment, version])

/** Read facts only. A business outcome, cancel request or empty Host is not exit proof. */
export function collectHostRoleClaims(states: readonly WorkflowRunState[]): HostRoleClaim[] {
  const claims: HostRoleClaim[] = []
  for (const state of states) {
    // Explicit user disposition permits new work without rewriting unknowns.
    // It is administrative clearance, not a claim that the Host proved exit.
    if (!state.created || state.manualClose) continue
    const commands = Object.values(state.commands).filter(command => command.status === 'running' || command.status === 'unknown')
    for (const assignment of Object.values(state.assignments)) {
      const unresolved = commands.filter(command => command.assignmentId === assignment.assignmentId)
      const issue = assignment.runtimeIssue?.status
      if (!unresolved.length && issue !== 'unknown' && issue !== 'stopping'
        && (assignment.status !== 'running' || issue === 'stopped')) continue
      claims.push({ key: hostRoleKey(state.created.rootSessionId, state.runId, assignment.assignmentId, assignment.taskVersion),
        rootSessionId: state.created.rootSessionId,
        state: issue === 'unknown' || issue === 'stopping' || unresolved.some(command => command.status === 'unknown') ? 'unconfirmed' : 'running' })
    }
    // A malformed association must never make possible native work disappear.
    for (const command of commands) if (!state.assignments[command.assignmentId]) {
      claims.push({ key: hostRoleKey(state.created.rootSessionId, state.runId, `orphan-command:${command.commandId}`, 0),
        rootSessionId: state.created.rootSessionId, state: 'unconfirmed' })
    }
  }
  return claims
}

export class HostAdmissionFull extends Error {
  override name = 'HostAdmissionFull'
  constructor(readonly dimension: 'roots' | 'roles' | 'root-models', readonly usage: HostAdmissionView) {
    super(`工作流 Host 并发名额不足（活动范围 ${usage.activeRoots}/${usage.maxActiveRoots}，子角色 ${usage.roleExecutions}/${usage.maxRoleExecutions}，根模型请求 ${usage.rootModelRequests}/${usage.maxActiveRoots}）。`
      + '本次未派发、未排队、未补额，不会自动重试。已获准的后台工作可收尾；取消中或未确认停止仍占位。用 /workflow-resources 查看；名额释放后需再次明确推进。')
  }
}
export interface HostAdmissionView {
  readonly enabled: boolean
  readonly maxActiveRoots: number
  readonly maxRoleExecutions: number
  readonly activeRoots: number
  readonly roleExecutions: number
  readonly rootModelRequests: number
  readonly unconfirmedRoles: number
  readonly roots: readonly string[]
  readonly roles: readonly HostRoleClaim[]
}

/** One controller owns this synchronous reservation boundary; no queue/automatic replay. */
export class WorkflowHostAdmission {
  readonly config: Readonly<HostAdmissionConfig>
  private readonly models = new Map<string, object>()
  private readonly pending = new Map<string, { token: object; claim: HostRoleClaim }>()
  private readonly idleWaiters = new Set<() => void>()
  private closed = false
  constructor(config: Partial<HostAdmissionConfig>, private readonly durable: () => readonly HostRoleClaim[]) {
    this.config = Object.freeze(resolveHostAdmissionConfig(config))
  }
  view(): HostAdmissionView {
    const roles = new Map(this.durable().map(claim => [claim.key, { ...claim }]))
    for (const [key, { claim }] of this.pending) if (!roles.has(key)) roles.set(key, { ...claim })
    const roots = [...new Set([...roles.values()].map(claim => claim.rootSessionId).concat([...this.models.keys()]))].sort()
    return { enabled: this.config.hostAdmissionEnabled, maxActiveRoots: this.config.hostMaxActiveRoots,
      maxRoleExecutions: this.config.hostMaxRoleExecutions, activeRoots: roots.length,
      roleExecutions: roles.size, rootModelRequests: this.models.size,
      unconfirmedRoles: [...roles.values()].filter(role => role.state === 'unconfirmed').length,
      roots, roles: [...roles.values()] }
  }
  private assertOpen(): void { if (this.closed) throw new Error('Host 并发准入已关闭') }
  /** Exact stream lifetime, including cancellation until iterator settlement. */
  beginRootModel(rootSessionId: string): () => void {
    this.assertOpen()
    if (!this.config.hostAdmissionEnabled) return () => {}
    const view = this.view()
    if (this.models.has(rootSessionId) || this.models.size >= this.config.hostMaxActiveRoots) throw new HostAdmissionFull('root-models', view)
    if (!view.roots.includes(rootSessionId) && view.activeRoots >= view.maxActiveRoots) throw new HostAdmissionFull('roots', view)
    const token = {}
    this.models.set(rootSessionId, token)
    return () => {
      if (this.models.get(rootSessionId) !== token) return
      this.models.delete(rootSessionId)
      if (!this.models.size) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear() }
    }
  }
  /** Reserve the WHOLE next wave before any asynchronous persistence or spawn. */
  reserveRoles(rootSessionId: string, keys: readonly string[]): () => void {
    this.assertOpen()
    if (!this.config.hostAdmissionEnabled) return () => {}
    if (!keys.length || new Set(keys).size !== keys.length) throw new Error('角色预留必须是非空且不重复的整批')
    const view = this.view()
    if (keys.some(key => view.roles.some(role => role.key === key))) throw new Error('角色执行范围已占位，禁止重复派发')
    if (view.activeRoots + (view.roots.includes(rootSessionId) ? 0 : 1) > view.maxActiveRoots) throw new HostAdmissionFull('roots', view)
    if (view.roleExecutions + keys.length > view.maxRoleExecutions) throw new HostAdmissionFull('roles', view)
    const token = {}
    for (const key of keys) this.pending.set(key, { token, claim: { key, rootSessionId, state: 'reserved' } })
    // After a successful commit, durable assignments take over atomically. A
    // failed commit never starts native work, so its provisional slots release.
    return () => { for (const key of keys) if (this.pending.get(key)?.token === token) this.pending.delete(key) }
  }
  close(): void { this.closed = true }
  whenModelsIdle(): Promise<void> {
    return this.models.size ? new Promise(resolve => this.idleWaiters.add(resolve)) : Promise.resolve()
  }
}
