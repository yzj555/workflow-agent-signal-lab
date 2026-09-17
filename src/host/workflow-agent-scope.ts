import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { WORKFLOW_PRESET_ID } from '../workflow-pilot-contract.ts'

/**
 * Native roots() describes runtime ownership, not durable delegation. Current
 * continuable children are parent-owned and therefore absent from roots(), but
 * a manually-created or foreign-provider Agent can still be a runtime root
 * while carrying delegated-looking metadata. Require both a native root and a
 * non-delegated durable header. An ordinary user fork may have parentSession
 * without being a delegated child.
 */
export function isWorkflowRootAgent(ctx: Context, agent: Agent): boolean {
  const header = agent.session.header
  return ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
    && header.origin === undefined && (header.delegationDepth ?? 0) === 0
    && ctx.agentPresets.composedPreset(agent.ctx) === WORKFLOW_PRESET_ID
}
