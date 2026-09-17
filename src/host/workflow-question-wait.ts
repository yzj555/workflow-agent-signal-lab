import type { Agent } from '@deepseek-ai/dsh-agent'

/** Observes native question lifetimes, without owning their answers or cancellation. */
export class WorkflowQuestionWaits {
  private readonly pending = new Map<Agent, Set<() => void>>()
  private closed = false

  constructor(private readonly reportError: (error: unknown) => void = () => {}) {}

  has(agent: Agent): boolean {
    return !this.closed && (this.pending.get(agent)?.size ?? 0) > 0
  }

  /** Caller must first establish the exact live Workflow root at the official question seam. */
  track(agent: Agent, signal: AbortSignal | undefined, changed: () => void): () => void {
    if (this.closed || signal?.aborted) return () => {}
    const entries = this.pending.get(agent) ?? new Set<() => void>()
    this.pending.set(agent, entries)
    let released = false
    const notify = () => {
      try { changed() }
      catch (error) {
        try { this.reportError(error) } catch { /* observation cannot replace a native answer */ }
      }
    }
    const release = () => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', release)
      entries.delete(release)
      if (entries.size === 0 && this.pending.get(agent) === entries) this.pending.delete(agent)
      notify()
    }
    entries.add(release)
    signal?.addEventListener('abort', release, { once: true })
    notify()
    return release
  }

  forget(agent: Agent): void {
    for (const release of [...(this.pending.get(agent) ?? [])]) release()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const agent of [...this.pending.keys()]) this.forget(agent)
  }
}
