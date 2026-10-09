import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { candidateVersion, digest, inside, newDirectory, regularFiles, saveJson } from '../scripts/lib/release-files.mjs'
import { createRequire } from 'node:module'
const yaml = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-app-boot'))('js-yaml')

test('release: an explicit numbered RC cannot claim final production status', () => {
  assert.equal(candidateVersion('1.0.0-rc.1'), '1.0.0-rc.1')
  for (const value of [undefined, '1.0.0', '0.0.1', '1.0.0-rc.0', '1.0.0-rc.01', '1.0.0-rc.1/../x']) {
    assert.throws(() => candidateVersion(value))
  }
})

test('release: input fingerprints are regular-file-only and content based', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-release-files-'))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'a'), 'a')
  assert.deepEqual(await regularFiles(root), { 'nested/a': digest('a') })
  await writeFile(join(root, 'nested', 'a'), 'b')
  assert.deepEqual(await regularFiles(root), { 'nested/a': digest('b') })
  await symlink(join(root, 'nested'), join(root, 'development-link'), 'junction')
  await assert.rejects(regularFiles(root), /release-input-link/u)
})

test('release: output creation and receipts never overwrite existing evidence', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'workflow-release-exclusive-'))
  const output = join(parent, 'new')
  await newDirectory(output)
  await saveJson(join(output, 'receipt.json'), { original: true })
  await assert.rejects(newDirectory(output), { code: 'EEXIST' })
  await assert.rejects(saveJson(join(output, 'receipt.json'), {}), { code: 'EEXIST' })
  assert.deepEqual(JSON.parse(await readFile(join(output, 'receipt.json'))), { original: true })
  await assert.rejects(newDirectory('relative'), /absolute-output-required/u)
})

test('release: output under a parent link is rejected; sibling-prefix is not containment', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'workflow-release-parent-'))
  const real = join(parent, 'real'), link = join(parent, 'link')
  await mkdir(real); await symlink(real, link, 'junction')
  await assert.rejects(newDirectory(join(link, 'child')), /output-parent-link/u)
  assert.equal(inside(real, join(real, 'nested')), true)
  assert.equal(inside(real, real + '-other'), false)
  assert.equal(inside(real, resolve(real, '..')), false)
})

test('release: install layer is inert and cannot overwrite user credentials or presets', async () => {
  const layer = await readFile(new URL('../release/cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal((layer.match(/disabled: true/gu) ?? []).length, 3)
  assert.doesNotMatch(layer, /(?:path:|dataDirectory:|id: (?:settings|credentials|agent-presets)|runBudgetEnabled:)/u)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  assert.equal(manifest.packageManager, 'pnpm@11.7.0')
  for (const name of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-agent-tool-presentation', '@deepseek-ai/dsh-tool-ask-user']) {
    assert.equal(manifest.peerDependencies[name], '0.2.0-rc.2')
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-storage-sqlite'], undefined)
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-storage-sqlite'], '0.2.0-rc.2')
})

test('release: DSH transitive packages are pinned, not only the CLI version', async () => {
  const text = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  const lock = yaml.load(text)
  const policy = yaml.load(await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'))
  assert.equal(policy.overrides['@deepseek-ai/dsh-agent-loop'], '0.2.0-rc.2')
  assert.equal(policy.overrides['@deepseek-ai/dsh-llm'], '0.2.0-rc.2')
  assert.equal(policy.overrides['@deepseek-ai/dsh-agent-preset-registry'], '0.2.0-rc.2')
  assert.equal(policy.overrides['@deepseek-ai/dsh-agent-presets'], undefined)
  const dshPackages = Object.keys(lock.packages).filter(key => key.startsWith('@deepseek-ai/dsh'))
  assert.ok(dshPackages.length > 30, 'must inspect the real resolved component graph, not only a manifest')
  for (const key of dshPackages) {
    const split = key.lastIndexOf('@'), name = key.slice(0, split), version = key.slice(split + 1)
    assert.equal(version, '0.2.0-rc.2', key)
    assert.equal(policy.overrides[name], version, 'missing exact graph override: ' + name)
  }
  assert.doesNotMatch(text, /\b(?:link|file|workspace):/u)
})

test('release: every shared Host peer has the same exact development copy while SQLite stays private', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    assert.equal(manifest.devDependencies[name], version, 'shared development instance must be version pinned: ' + name)
    if (name.startsWith('@deepseek-ai/dsh')) assert.equal(version, '0.2.0-rc.2', name)
  }
  for (const name of ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent-preset']) {
    assert.equal(manifest.peerDependencies[name], '0.2.0-rc.2')
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '4.0.4')
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '3.18.4')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-storage-sqlite'], undefined)
})

test('release: the resource policy names the same exact Host as the declaration and engine', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const policy = JSON.parse(await readFile(new URL('../src/workflow-resource-candidate.json', import.meta.url), 'utf8'))
  assert.equal(policy.dsh, manifest.peerDependencies['@deepseek-ai/dsh-agent-preset-registry'])
  assert.equal(policy.status, 'candidate-not-activated')
})
