import type { Context } from '@deepseek-ai/cordis'
import * as JournalRuntime from './workflow-runtime.ts'
import * as ControlRuntime from './workflow-control.ts'

export const name = 'workflow-engine'
export const inject = ['connection', 'webServer', 'agents', 'agentPresets', 'subagents', 'tools', 'userQuestions', 'systemPrompt', 'sessionPersistence']
export interface Config extends ControlRuntime.Config {}

/** One lifecycle owner: control revokes/drains before its Journal closes. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const journal = await ctx.plugin(JournalRuntime, config)
  try {
    const controller = await ctx.plugin(ControlRuntime, config)
    try {
      const release = ctx.get('workflowReleaseReady') as { verifyRuntime?: () => Promise<void> } | undefined
      await release?.verifyRuntime?.()
    } catch (error) {
      await controller.dispose()
      throw error
    }
    ctx.effect(() => async () => {
      await controller.dispose()
      await journal.dispose()
    }, 'workflow-engine.close')
  } catch (error) {
    await journal.dispose()
    throw error
  }
}
