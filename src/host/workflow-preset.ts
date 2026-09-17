import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installWorkflowChild } from './workflow-control.ts'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-commands'
import { ROOT_TOOLS } from '../workflow-pilot-contract.ts'
import { registerRootTools } from './workflow-tools.ts'
import { installWorkflowModelView } from './workflow-model-view.ts'
import { installWorkflowModelBudget } from './workflow-model-budget.ts'
import { isWorkflowRootAgent } from './workflow-agent-scope.ts'

export const name = 'workflow-preset'
export const inject = ['workflowController', 'tools', 'agents', 'agentPresets', 'systemPrompt', 'commands']

/** Agent-plane contribution; no Host service is published from this preset. */
export function apply(ctx: Context): void {
  const controller = ctx.workflowController
  registerRootTools(ctx, controller)
  ctx.tools.guard(exec => controller.guard(exec.agent, exec.name, exec.arguments))
  const bindings = new WeakMap<Agent, () => void>()
  const syncBinding = (agent: Agent) => {
    if (controller.ownsChild(agent.id)) {
      if (bindings.has(agent)) return
      const undoChild = installWorkflowChild(agent.ctx, agent, controller)
      if (undoChild === undefined) throw new Error('工作流子 Agent 未取得已记录的派发授权')
      bindings.set(agent, () => { undoChild(); bindings.delete(agent) })
      return
    }
    if (!isWorkflowRootAgent(ctx, agent)) {
      bindings.get(agent)?.()
      return
    }
    if (bindings.has(agent)) return
    controller.bindRoot(agent)
    // Keep the preset's native capability substrate in the scope chain so an
    // official delegated child can inherit it and then narrow to its role.
    // A parent restriction is monotonic and would make those tools impossible
    // to restore in a child. The coordinator still sees only ROOT_TOOLS through
    // the final model-view projection, while controller.guard rejects any
    // hidden or forged native call at execution time.
    const undoView = installWorkflowModelView(agent.ctx, agent, 'root', () => isWorkflowRootAgent(ctx, agent), undefined,
      () => controller.rootModelTools(agent))
    const undoBudget = installWorkflowModelBudget(agent.ctx, agent, controller, () => isWorkflowRootAgent(ctx, agent))
    const commandFiber = agent.ctx.inject(['commands'], commandCtx => { commandCtx.commands.register({
      name: 'workflow-budget', description: '核对工作流预算，或通过原生确认申请补额／结束（不调用模型）',
      input: { hint: '留空查看；topup 申请补额；end 申请结束' },
      async handler(invocation) {
        if (invocation.agent !== agent || !isWorkflowRootAgent(ctx, agent)) return { kind: 'error', text: '命令不属于当前工作流 Agent' }
        try { return { kind: 'success', text: await controller.budgetCommand(agent, invocation.rawInput, invocation.signal) } }
        catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) } }
      },
    }) })
    bindings.set(agent, () => {
      void commandFiber.dispose().catch(error => ctx.logger.warn(String(error)))
      undoBudget(); undoView(); bindings.delete(agent)
    })
  }
  // Synchronous failure here vetoes native Agent publication. Do not defer
  // permission installation to a later promise or to the first model message.
  ctx.on('agent/created', ({ agent }) => syncBinding(agent))
  ctx.on('agent/disposed', ({ agent }) => bindings.get(agent)?.())
  // Official blank-session selection re-links the same Agent; it does not
  // emit agent/created again. Bind on entry and release exact local effects
  // on exit, without touching another Agent or the shared preset composition.
  ctx.on('agent-preset/selected', sessionId => {
    const agent = ctx.agents.get(sessionId)
    if (agent) syncBinding(agent)
  })
}
