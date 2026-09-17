import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { WorkflowTextController } from './workflow-controller.ts'

/** Do not mutate DSH's frozen request or trust a model-supplied session ID. */
export function installWorkflowModelBudget(ctx: Context, agent: Agent, controller: WorkflowTextController,
  isCurrent: () => boolean = () => true): () => void {
  return ctx.on('llm/stream', async function* (options, next) {
    // Ancestor middleware also receives descendant calls. Only the exact
    // official frozen loop request AND currently bound opaque Agent identify
    // the charge (once, not parent+child). Cordis listener `this.ctx` can be
    // rebound to its registration fiber, so it is NOT the dispatch subject.
    if (options.sessionId !== agent.id || !isCurrent()) { yield* next(); return }
    // Native auxiliary model work is outside this slice's admission counts.
    if (options.purpose) { yield* next(); return }
    if (!isAgentLoopRequest(options) || !Object.isFrozen(options)) throw new Error('预算只接受官方 AgentLoop 冻结请求')
    options.signal?.throwIfAborted()
    await controller.admitModelRequest(agent)
    options.signal?.throwIfAborted()
    yield* next()
  }, { prepend: true })
}
