/** A native Session must survive a crash BEFORE its first formal Workflow Run.
 * DSH's public service barrier flushes all active write handles; read handles and
 * whenIdle() cannot provide this guarantee. Coalesce calls for the SAME root,
 * cache only the exact live root object, and bound caller wait without pretending
 * to cancel an already started persistence operation.
 */
export class RootSessionDurability<T extends object> {
  private readonly durable = new WeakSet<T>()
  private readonly pending = new WeakMap<T, Promise<void>>()
  constructor(private readonly flush: () => Promise<void>, private readonly isCurrent: (root: T) => boolean,
    private readonly timeoutMs = 15_000) {}

  async ensure(root: T, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.isCurrent(root)) throw new Error('原生根会话已失效，不能建立工作流')
    if (this.durable.has(root)) return
    // A root created AFTER another barrier started is not necessarily in that
    // barrier's captured handle set. Never share admission across root objects.
    const pending = this.pending.get(root) ?? Promise.resolve().then(() => this.flush())
    this.pending.set(root, pending)
    const clear = () => { if (this.pending.get(root) === pending) this.pending.delete(root) }
    // Join failure as well as success; a rejected detached finally would become
    // an unhandled rejection after the caller has already aborted.
    void pending.then(clear, clear)
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve()
      }
      const abort = () => finish(signal.reason ?? new Error('会话保存等待已取消'))
      const timer = setTimeout(() => finish(new Error('原生会话保存超时；工作流尚未创建，请核查存储后重试')), this.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void pending.then(() => finish(), error => finish(new Error('原生会话保存失败；工作流尚未创建，请核查存储后重试', { cause: error })))
    })
    signal.throwIfAborted()
    if (!this.isCurrent(root)) throw new Error('会话保存期间根 Agent 已失效，未创建工作流')
    this.durable.add(root)
  }
}
