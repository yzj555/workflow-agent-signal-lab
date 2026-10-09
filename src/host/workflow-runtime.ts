import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { WORKFLOW_RPC_CHANNEL, workflowSnapshotRequestSchema, workflowSnapshotSchema } from '../workflow-view.ts'
import { openWorkflowStorage } from './workflow-storage.ts'
import type { WorkflowJournal } from '../workflow-journal.ts'
import type { WorkflowOwner } from './workflow-owner.ts'

export { openWorkflowStorage, workflowDomainSpec, WORKFLOW_DOMAIN_NAME } from './workflow-storage.ts'
export { acquireWorkflowOwner } from './workflow-owner.ts'
export const name = 'workflow-runtime'
// Connection scopes dedicated RPC routes to the caller fiber. Registering one
// therefore requires both the Connection service and that fiber's Web server
// capability on DSH 0.1.5+.
export const inject = ['connection', 'webServer']

export interface WorkflowRuntimeConfig {
  /** A dedicated, absolute directory. One active Host writer per directory. */
  readonly dataDirectory: string
}

/** No mutation endpoint. The official Connection owns envelopes, trust checks, and disposal. */
export function workflowReadHandler(journal: WorkflowJournal, reportError: (error: unknown) => void = () => {}): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== 'snapshot') return {
      ok: false, error: { code: 'bad-request', message: 'workflow endpoint is read-only; only snapshot is available', details: { issues: [] } },
    }
    const request = workflowSnapshotRequestSchema.safeParse(payload)
    if (!request.success || signal.aborted) return {
      ok: false, error: { code: 'bad-request', message: 'invalid or cancelled workflow snapshot request', details: { issues: [] } },
    }
    try {
      const snapshot = workflowSnapshotSchema.parse(journal.readSnapshot(request.data.rootSessionId))
      return { ok: true, value: snapshot }
    } catch (error) {
      try { reportError(error) } catch { /* Keep a diagnostic sink out of the RPC outcome. */ }
      const fault = journal.readFault()
      return { ok: false, error: { code: 'internal', message: 'workflow state is unavailable; recovery must complete before advancing',
        details: fault ? { workflowFault: { schemaVersion: 1, rootSessionId: request.data.rootSessionId, kind: fault.kind } } : {} } }
    }
  }
}

/** Host plugin: independently durable state plus a loopback-only read channel. */
export async function apply(ctx: Context, config: WorkflowRuntimeConfig): Promise<void> {
  if (typeof config?.dataDirectory !== 'string') throw new Error('workflow runtime requires dataDirectory')
  const release = ctx.get('workflowReleaseReady') as { claimOwner?: () => WorkflowOwner } | undefined
  // Distribution startup transfers the SAME CAS owner after checking existing
  // data. No release/reacquire gap in which another Host could write a new image.
  const runtime = await openWorkflowStorage(config.dataDirectory, error => ctx.logger.warn(String(error)), release?.claimOwner?.())
  let removeReadChannel: (() => Promise<void>) | undefined
  try {
    // DSH 0.1.5's dedicated-channel implementation resolves its Web route
    // against the Connection provider's origin fiber when invoked beneath a
    // loader-owned plugin fiber. Register through the root transport so that
    // route can see WebServer, while retaining the returned disposer here: the
    // plugin still owns fail-closed teardown and all requests still traverse
    // Connection's Host/Origin and browser-auth fences.
    removeReadChannel = ctx.root.connection.rpc.handle(
      WORKFLOW_RPC_CHANNEL, workflowReadHandler(runtime.journal, error => ctx.logger.warn(String(error))),
    )
    ctx.effect(() => async () => {
      await removeReadChannel?.()
      await runtime.close()
    }, 'workflow-runtime.close')
    // Host-internal only. There are no model tools or text listeners in slice 2.
    ctx.provide('workflowJournal', runtime.journal)
  } catch (error) {
    await removeReadChannel?.()
    await runtime.close()
    throw error
  }
}
