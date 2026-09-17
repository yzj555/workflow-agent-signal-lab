import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CHILD_TOOLS, ROOT_TOOLS } from '../workflow-pilot-contract.ts'
import { PROJECT_NATIVE_TOOLS } from './workflow-capabilities.ts'

/**
 * Project the model input for one exact Workflow Agent, without unregistering
 * another plugin's contributions or changing any execution/approval policy.
 * tools.restrict() masks inherited tools only; child-local tools such as the
 * official `report` must also be removed from the final model-facing schemas.
 * The independent monotonic execution guard remains the authority boundary.
 */
export function installWorkflowModelView(ctx: Context, agent: Agent, role: 'root' | 'child',
  isCurrent: () => boolean = () => true, childTools: readonly string[] = CHILD_TOOLS,
  rootTools: () => readonly string[] = () => ROOT_TOOLS): () => void {
  const allowed = new Set<string>(role === 'root' ? ROOT_TOOLS : childTools)
  const hiddenNativeSections = new Set(PROJECT_NATIVE_TOOLS
    .filter(name => !allowed.has(name))
    .map(name => `tool:${name}`))
  return ctx.on('system-prompt/assemble', async (_input, context, next) => {
    const assembly = await next()
    // Scoped events also admit descendant scopes. A root's projection must
    // never strip a child's different tool set, or affect another preset.
    if (context.scope !== agent || !isCurrent()) return assembly
    const effectiveTools = role === 'root' ? new Set(rootTools()) : allowed
    const controlOnly = role === 'root' && !effectiveTools.has('workflow_advance')
    return {
      ...assembly,
      // These are the two verified dsh-crew 0.10.0 contribution names. Keep
      // native identity, persona, user instructions and security contexts;
      // never remove a section merely because its text mentions "Crew".
      sections: [...assembly.sections.filter(item =>
        (role !== 'root' || item.name !== 'crew:pm') && !hiddenNativeSections.has(item.name)),
        ...(controlOnly ? [{ name: 'workflow:budget-recovery', order: 0, text:
          '本轮预算核对模式：只解释现有状态、按用户要求申请原生补额或结束门禁，不能执行、反复轮询或自行批准。每个用户新消息最多三次请求；总核对额度有限。先 workflow_status，任何核实依据必须真实。/workflow-budget 是无需模型的原生命令。补额后结束当前轮，等待新的用户消息；已经结束的运行只能重新确认新任务。' }] : [])],
      contexts: role === 'root' ? assembly.contexts.filter(item => item.name !== 'crew:jobs') : assembly.contexts,
      tools: assembly.tools.filter(tool => effectiveTools.has(tool.name)),
    }
  }, { prepend: true })
}
