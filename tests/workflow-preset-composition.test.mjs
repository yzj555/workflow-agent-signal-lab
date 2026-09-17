import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('workflow preset mounts every official native capability used by L1 roles', async () => {
  const preset = await readFile(join(root, 'preset/workflow-agent-signal-lab/agent.cordis.yml'), 'utf8')
  for (const packageName of [
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@local/workflow-agent-signal-lab/workflow-pwsh',
  ]) {
    assert.match(preset, new RegExp(`name: '${packageName.replaceAll('/', '\\/')}'`))
  }
  assert.match(preset, /enableRunInBackground:\s*false/)
  const adapter = await readFile(join(root, 'src/host/workflow-pwsh.ts'), 'utf8')
  assert.match(adapter, /from '@deepseek-ai\/dsh-tool-pwsh'/)
  assert.match(adapter, /scoped\.plugin\(PwshTool, \{ enableRunInBackground: false \}\)/)
  assert.match(adapter, /ctx\.extend\(\{ subprocess \}\)/)
  assert.match(preset, /pipe-stdio named pipe/)
  assert.match(preset, /父会话已经由用户选择 Full access/)
})

test('development linker carries the same native capability packages', async () => {
  const linker = await readFile(join(root, 'scripts/link-dsh-dev.ps1'), 'utf8')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const dshVersion = manifest.peerDependencies['@deepseek-ai/dsh-agent']
  assert.equal(dshVersion, '0.1.5-rc.1')
  for (const packageName of [
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-subprocess',
  ]) {
    assert.match(linker, new RegExp(packageName.replaceAll('/', '\\/')))
    assert.equal(manifest.peerDependencies[packageName], dshVersion)
  }
})
