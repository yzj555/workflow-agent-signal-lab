/** Isolated registry compile probe; never changes a Profile, starts a Host or publishes. */
import assert from 'node:assert/strict'
import { cp, readFile, writeFile, mkdtemp, realpath } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { digest, regularFiles, inside, newDirectory, saveJson } from './lib/release-files.mjs'

const root = resolve(import.meta.dirname, '..')
const configs = ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json']
const commandOutput = (cwd, file, args) => execFileSync(file, args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/check-dsh-compatibility.mjs --official-source <absolute-clean-DSH-checkout> --version 0.2.0-rc.2 --output <new-absolute-directory> --pnpm-cli <absolute-pnpm.mjs>')
    return
  }
  const flags = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!['--official-source', '--version', '--output', '--pnpm-cli'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('invalid-arguments')
    flags.set(args[i], args[i + 1])
  }
  const source = flags.get('--official-source'), output = flags.get('--output'), pnpm = flags.get('--pnpm-cli'), version = flags.get('--version')
  assert.ok(source && output && pnpm && [source, output, pnpm].every(isAbsolute), 'absolute-paths-required')
  assert.equal(version, '0.2.0-rc.2', 'explicit-reviewed-target-required')
  assert.match(basename(pnpm), /^pnpm\.(mjs|cjs)$/u)
  const commit = commandOutput(source, 'git', ['rev-parse', 'HEAD'])
  assert.equal(commandOutput(source, 'git', ['status', '--porcelain']), '', 'official-checkout-must-be-clean')
  const upstream = JSON.parse(await readFile(join(source, 'apps/cli/package.json'), 'utf8'))
  assert.equal(upstream.name, '@deepseek-ai/dsh'); assert.equal(upstream.version, version)
  const official = new Map()
  const paths = commandOutput(source, 'rg', ['--files', 'packages', 'vendor', 'apps', 'native', '-g', 'package.json']).split(/\r?\n/u)
  for (const file of paths) {
    const manifest = JSON.parse(await readFile(join(source, file), 'utf8'))
    if (!manifest.name?.startsWith('@deepseek-ai/')) continue
    assert.ok(!official.has(manifest.name), 'duplicate-official-package')
    official.set(manifest.name, { version: manifest.version, path: file })
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const oldRegistry = '@deepseek-ai/dsh-agent-presets', newRegistry = '@deepseek-ai/dsh-agent-preset-registry'
  assert.ok(!official.has(oldRegistry) && official.get(newRegistry)?.version === version)
  const before = await regularFiles(join(root, 'src'))
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'workflow-dsh-compat-')))
  assert.ok(!inside(root, workspace) && !inside(source, workspace))
  await newDirectory(output)
  const receipt = { schemaVersion: 1, status: 'failed', target: version, sourceCommit: commit,
    startedAt: new Date().toISOString(), node: process.version, workspace, sourceFiles: before,
    checks: [], mechanicalImportMap: { [oldRegistry]: newRegistry }, activated: false, published: false, productionReady: false }
  async function run(name, argv) {
    const log = createWriteStream(join(output, name + '.log'), { flags: 'wx' })
    const env = { ...process.env, CI: 'true', NODE_ENV: 'development' }
    for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|PASSWORD|CREDENTIAL|NODE_OPTIONS|NODE_PATH/iu.test(key)) delete env[key]
    const child = spawn(process.execPath, argv, { cwd: workspace, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 600000)
    const result = await new Promise(done => {
      child.once('error', error => done({ code: null, error: error.code }))
      child.once('close', (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer); log.end(); await finished(log)
    if (timedOut || result.code === null) throw new Error('probe-command-failed')
    receipt.checks.push({ name, ...result, timedOut })
    console.log(JSON.stringify({ step: name, code: result.code }))
    return result.code
  }
  try {
    await cp(join(root, 'src'), join(workspace, 'src'), { recursive: true, errorOnExist: true })
    for (const config of configs) await cp(join(root, config), join(workspace, config), { errorOnExist: true })
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.devDependencies,
      '@deepseek-ai/dsh': version, [newRegistry]: version, '@deepseek-ai/dsh-agent-preset': version }
    delete dependencies[oldRegistry]
    const differences = []
    for (const [name, value] of Object.entries(dependencies)) {
      if (!name.startsWith('@deepseek-ai/')) continue
      const current = official.get(name)
      assert.ok(current, 'unmapped-official-dependency: ' + name)
      differences.push({ name, from: value, to: current.version, officialPath: current.path })
      dependencies[name] = current.version
    }
    receipt.dependencies = differences
    const overrides = Object.fromEntries([...official].map(([name, item]) => [name, item.version]))
    Object.assign(overrides, { zod: manifest.dependencies.zod, react: manifest.peerDependencies.react, 'react-dom': manifest.peerDependencies['react-dom'] })
    await saveJson(join(workspace, 'package.json'), { name: 'workflow-private-compatibility-probe', version: '0.0.0', private: true,
      type: 'module', packageManager: 'pnpm@11.7.0', dependencies })
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - .\noverrides:\n' +
      Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value)).join('\n') + '\n', { flag: 'wx' })
    assert.equal(await run('pnpm-version', [pnpm, '--version']), 0)
    assert.equal((await readFile(join(output, 'pnpm-version.log'), 'utf8')).trim(), '11.7.0')
    const installArgs = ['--ignore-scripts', '--registry=https://registry.npmjs.org', '--config.manage-package-manager-versions=false']
    assert.equal(await run('resolve-lock', [pnpm, 'install', '--lockfile-only', ...installArgs]), 0)
    assert.equal(await run('install', [pnpm, 'install', '--frozen-lockfile', ...installArgs]), 0)
    for (const name of Object.keys(dependencies)) assert.ok(inside(workspace, await realpath(join(workspace, 'node_modules', name))), 'external-dependency')
    await cp(join(workspace, 'package.json'), join(output, 'probe-package.json'), { errorOnExist: true })
    await cp(join(workspace, 'pnpm-workspace.yaml'), join(output, 'probe-pnpm-workspace.yaml'), { errorOnExist: true })
    await cp(join(workspace, 'pnpm-lock.yaml'), join(output, 'probe-pnpm-lock.yaml'), { errorOnExist: true })
    const originalHost = await run('original-host-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
    const originalClient = await run('original-client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json'])
    // Bulk mechanical substitution ONLY in this disposable source copy. This
    // exposes other API failures; it is not an adapter or a deployable package.
    const mapped = []
    for (const file of Object.keys(before)) {
      const path = join(workspace, 'src', file), text = await readFile(path, 'utf8')
      if (!text.includes(oldRegistry)) continue
      const replacement = text.replaceAll(oldRegistry, newRegistry)
      await writeFile(path, replacement)
      mapped.push({ file, before: digest(text), after: digest(replacement) })
    }
    receipt.mechanicallyChangedFiles = mapped
    const mappedHost = await run('mapped-host-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
    const mappedClient = await run('mapped-client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json'])
    receipt.compilation = { originalHost, originalClient, mappedHost, mappedClient }
    receipt.sourceStillRequires = ['declarative preset bundle and profile generator', 'runtime/role/gate/native-interface acceptance',
      'diagnostic inbox/job observations for the new control projection', 'release policy and exact Host module-identity checks']
    receipt.status = 'completed-compatibility-probe-not-production-approved'
    assert.deepEqual(await regularFiles(join(root, 'src')), before)
    assert.equal(commandOutput(source, 'git', ['rev-parse', 'HEAD']), commit)
    assert.equal(commandOutput(source, 'git', ['status', '--porcelain']), '')
    receipt.sourceAndOfficialCheckoutUnchanged = true
  } catch (error) { receipt.failure = String(error.message); process.exitCode = 1 }
  finally {
    receipt.finishedAt = new Date().toISOString()
    await saveJson(join(output, 'receipt.json'), receipt)
    console.log(JSON.stringify({ status: receipt.status, compilation: receipt.compilation, failure: receipt.failure,
      activated: false, productionReady: false }))
  }
}
main(process.argv.slice(2)).catch(() => { console.error('兼容探针未完成；请核对固定版本、独立输出及官方源码。未启动 Host 或更改 Profile。'); process.exitCode = 1 })
