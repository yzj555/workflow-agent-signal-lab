import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Registry from '@deepseek-ai/dsh-agent-preset-registry'
const require = createRequire(import.meta.url)
const yaml = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml')

export async function registerFixturePresets(ctx, root, workflowId) {
  await ctx.plugin(Registry, { default: workflowId })
  const entries = []
  for (const [id, base] of [[workflowId, 'preset'], ['plain-test', 'tests/fixtures/presets']]) {
    const directory = join(root, base, id)
    const metadata = yaml.load(await readFile(join(directory, 'preset.yml'), 'utf8'))
    const plugins = yaml.load(await readFile(join(directory, 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
    entries.push({ id: id === workflowId ? 'workflow-agent-preset-declaration' : 'plain-test-declaration',
      name: '@deepseek-ai/dsh-agent-preset', config: { id, name: metadata.name, description: metadata.description,
        ...(metadata.order !== undefined ? { order: metadata.order } : {}), plugins } })
  }
  await ctx.loader.root.update(entries)
}
