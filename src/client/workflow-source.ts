import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { WORKFLOW_RPC_CHANNEL, workflowSnapshotSchema } from '../workflow-view.ts'
import type { WorkflowSnapshot } from '../workflow-view.ts'

/** Uses DSH's existing transport, not a new chat or an unguarded fetch endpoint. */
export async function readWorkflowSnapshot(rpc: ClientConnectionRpc, rootSessionId: string, signal?: AbortSignal): Promise<WorkflowSnapshot> {
  const result = await rpc.call(WORKFLOW_RPC_CHANNEL, 'snapshot', { schemaVersion: 1, rootSessionId }, signal)
  if (!result.ok) throw new Error(`workflow snapshot unavailable: ${result.error.message}`)
  const snapshot = workflowSnapshotSchema.parse(result.value)
  if (snapshot.rootSessionId !== rootSessionId) throw new Error('workflow response belongs to another root Session')
  return snapshot
}

export type WorkflowClientState =
  | { readonly status: 'loading' | 'unavailable'; readonly snapshot: null }
  | { readonly status: 'ready' | 'absent'; readonly snapshot: WorkflowSnapshot }

const LOADING: WorkflowClientState = Object.freeze({ status: 'loading', snapshot: null })
const UNAVAILABLE: WorkflowClientState = Object.freeze({ status: 'unavailable', snapshot: null })

interface ObservedSession {
  readonly id: string
  readonly listeners: Set<() => void>
  state: WorkflowClientState
  token: number
  revision: number
  budgetRevision: number
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}

/** One shared, single-flight poller per observed root Session; no model/RPC writes. */
export class WorkflowSnapshotSource {
  private readonly sessions = new Map<string, ObservedSession>()
  private connected = true
  private disposed = false

  constructor(private readonly rpc: ClientConnectionRpc,
    private readonly options: { readonly pollMs?: number; readonly timeoutMs?: number } = {}) {}

  getSnapshot(id: string): WorkflowClientState {
    return this.sessions.get(id)?.state ?? (this.disposed || !this.connected ? UNAVAILABLE : LOADING)
  }

  subscribe(id: string, listener: () => void): () => void {
    if (this.disposed) return () => {}
    let entry = this.sessions.get(id)
    if (entry === undefined) {
      entry = { id, listeners: new Set(), state: this.connected ? LOADING : UNAVAILABLE, token: 0, revision: -1, budgetRevision: -1 }
      this.sessions.set(id, entry)
    }
    const subscription = () => listener()
    entry.listeners.add(subscription)
    if (entry.listeners.size === 1 && this.connected) this.start(entry)
    return () => {
      entry.listeners.delete(subscription)
      if (entry.listeners.size === 0) {
        this.cancel(entry)
        this.sessions.delete(id)
      }
    }
  }

  /** Invalidate all cached approvals on Host connection-generation changes. */
  connectionChanged(connected: boolean): void {
    if (this.disposed) return
    this.connected = connected
    for (const entry of this.sessions.values()) {
      this.cancel(entry)
      this.publish(entry, connected ? LOADING : UNAVAILABLE)
      if (connected) this.start(entry)
    }
  }

  private publish(entry: ObservedSession, state: WorkflowClientState): void {
    entry.state = state
    for (const listener of [...entry.listeners]) {
      try { listener() } catch { /* A view observer cannot stop the shared source. */ }
    }
  }

  private cancel(entry: ObservedSession): void {
    entry.token++
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.controller?.abort()
    entry.controller = undefined
  }

  private start(entry: ObservedSession): void {
    if (entry.controller !== undefined || this.disposed || !this.connected || entry.listeners.size === 0) return
    const token = ++entry.token
    const controller = new AbortController()
    entry.controller = controller
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000)
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('workflow read cancelled or timed out')), { once: true })
    })
    const current = (): boolean => this.sessions.get(entry.id) === entry && entry.token === token && !this.disposed && this.connected
    void Promise.race([readWorkflowSnapshot(this.rpc, entry.id, controller.signal), aborted]).then(snapshot => {
      if (!current()) return
      const previous = entry.state.snapshot
      if (snapshot.revision < entry.revision) throw new Error('workflow revision moved backwards')
      if ((snapshot.budgetRevision ?? 0) < entry.budgetRevision) throw new Error('workflow budget revision moved backwards')
      entry.revision = snapshot.revision
      entry.budgetRevision = snapshot.budgetRevision ?? 0
      if (previous !== null && snapshot.revision === previous.revision
        && (snapshot.budgetRevision ?? 0) === (previous.budgetRevision ?? 0)) return
      this.publish(entry, immutable({ status: snapshot.availability, snapshot }))
    }).catch(() => {
      if (current()) this.publish(entry, UNAVAILABLE)
    }).finally(() => {
      clearTimeout(timeout)
      if (!current()) return
      entry.controller = undefined
      const delay = this.options.pollMs ?? (entry.state.status === 'ready' ? 2000 : 5000)
      entry.timer = setTimeout(() => this.start(entry), delay)
    })
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.sessions.values()) {
      this.cancel(entry)
      this.publish(entry, UNAVAILABLE)
    }
    this.sessions.clear()
  }
}
