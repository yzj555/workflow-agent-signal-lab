import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as PwshTool from '@deepseek-ai/dsh-tool-pwsh'
import type {} from './workflow-control.ts'

export const name = 'workflow-pwsh'
export const inject = ['workflowController', 'subprocess', 'shell', 'tools', 'shellEnv', 'sandboxPolicy']

/** Public Cordis context extension + the unchanged official model-facing tool.
 * Cordis service tracing carries this caller's explicit subprocess delegate into
 * the existing sandboxed ShellExecutor. No global service or prototype patch.
 */
export async function apply(ctx: Context): Promise<void> {
  const upstream = ctx.subprocess
  const runtime = ctx.workflowController.commands
  const subprocess = {
    resolveExecutable: upstream.resolveExecutable.bind(upstream),
    spawn: (spec: SubprocessSpawnSpec) => runtime.spawn(upstream, spec),
    spawnTerminal: () => Promise.reject(new Error('工作流冻结检查不允许终端／后台进程')),
  }
  const scoped = ctx.extend({ subprocess })
  await scoped.plugin(PwshTool, { enableRunInBackground: false })
}
