/** Clean registry build, tests and prebuilt tgz. No Host, profile or publishing. */
import assert from 'node:assert/strict'
import { cp, readFile, mkdir, lstat, realpath, mkdtemp, readdir } from 'node:fs/promises'
import { join, resolve, dirname, isAbsolute, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { digest, regularFiles, newDirectory, saveJson, candidateVersion, inside } from './lib/release-files.mjs'
import { DECLARATIVE_DSH, PRESET_ADMISSION_PROTOCOL, REGISTRY_MODULE, appendDeclarativeBundle, readPresetDefinition } from './lib/workflow-declarative-preset.mjs'

const root = resolve(import.meta.dirname, '..')
const inputs = ['src', 'tests', 'scripts', 'preset', 'release', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json', 'tsdown.config.ts', 'tsdown.release.config.ts']
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

async function inputHashes(at) {
  const result = {}
  for (const name of inputs) {
    const path = join(at, name), info = await lstat(path)
    assert.ok(!info.isSymbolicLink(), 'Source input is a link')
    if (info.isDirectory()) for (const [part, sha] of Object.entries(await regularFiles(path))) result[name + '/' + part] = sha
    else { assert.ok(info.isFile()); result[name] = digest(await readFile(path)) }
  }
  return result
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('pnpm run release:build --output <new-absolute-directory> --version 1.0.0-rc.N [--pnpm-cli <pnpm.mjs/cjs>]')
    return
  }
  const flags = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!['--output', '--version', '--pnpm-cli'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('invalid-arguments')
    flags.set(args[i], args[i + 1])
  }
  const version = candidateVersion(flags.get('--version'))
  const output = flags.get('--output')
  assert.ok(output && isAbsolute(output), 'A new absolute output directory is required')
  const pnpm = flags.get('--pnpm-cli') ?? process.env.npm_execpath
  assert.ok(pnpm && isAbsolute(pnpm) && /^pnpm\.(mjs|cjs)$/u.test(basename(pnpm)), 'Run via pnpm or pass --pnpm-cli')
  const source = await inputHashes(root)
  const sourceManifest = await readJson(join(root, 'package.json'))
  const targetDsh = sourceManifest.peerDependencies[REGISTRY_MODULE] ?? '0.1.5-rc.1'
  let verificationPolicy
  if (targetDsh === DECLARATIVE_DSH) {
    verificationPolicy = await readJson(join(root, 'release/verification-policy.json'))
    assert.equal(verificationPolicy.schemaVersion, 1)
    assert.equal(verificationPolicy.dsh, targetDsh)
    assert.equal(verificationPolicy.platform, process.platform, 'Release acceptance is Windows only')
    assert.equal(verificationPolicy.arch, process.arch)
    assert.equal(verificationPolicy.node, process.version)
    assert.equal(verificationPolicy.zeroSkipsRequired, true)
    assert.equal(verificationPolicy.productionReady, false)
    assert.ok(Number.isSafeInteger(verificationPolicy.expectedTests) && verificationPolicy.expectedTests > 0)
    assert.ok(Number.isSafeInteger(verificationPolicy.expectedTestFiles) && verificationPolicy.expectedTestFiles > 0)
  }
  // Never let user-relative links, credentials or prior machine caches determine a release.
  assert.doesNotMatch(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), /\b(?:link|file|workspace):/u)
  await newDirectory(output)
  // A checkout nested under the developer's repository could resolve undeclared
  // modules from its ancestors. Build outside it and verify every direct dep.
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'workflow-release-source-')))
  assert.ok(!inside(root, workspace), 'Release source must be outside the development repository')
  const payload = join(output, 'package')
  await mkdir(payload)
  const receipt = { schemaVersion: 1, status: 'failed', version, startedAt: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, buildMode: 'production', workspace, source, checks: [], activated: false, published: false }

  async function command(name, cwd, file, argv) {
    const log = createWriteStream(join(output, name + '.log'), { flags: 'wx' })
    const startedAt = new Date().toISOString()
    // Do not inherit resolution injection or old fixture output paths.
    const env = { ...process.env, CI: 'true', NODE_ENV: name === 'install' ? 'development' : 'production' }
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'WORKFLOW_CRASH_EVIDENCE_DIR', 'WORKFLOW_PROCESS_EVIDENCE_DIR']) delete env[key]
    const child = spawn(file, argv, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 600_000)
    const result = await new Promise(resolveResult => {
      child.on('error', error => resolveResult({ code: null, error: error.code ?? 'spawn-failed' }))
      child.on('close', (code, signal) => resolveResult({ code, signal }))
    })
    clearTimeout(timer); log.end(); await finished(log)
    receipt.checks.push({ name, startedAt, finishedAt: new Date().toISOString(), ...result, timedOut })
    console.log(JSON.stringify({ step: name, ...result, timedOut }))
    if (result.code !== 0 || timedOut) throw new Error('release-step-failed: ' + name)
  }
  try {
    for (const name of inputs) await cp(join(root, name), join(workspace, name), { recursive: true, force: false, errorOnExist: true })
    assert.deepEqual(await inputHashes(workspace), source)
    await command('pnpm-version', workspace, process.execPath, [pnpm, '--version'])
    assert.equal((await readFile(join(output, 'pnpm-version.log'), 'utf8')).trim(), '11.7.0', 'Pinned pnpm required')
    await command('install', workspace, process.execPath, [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--config.manage-package-manager-versions=false'])
    // pnpm's own store links are allowed, links outside this new build tree are not.
    for (const name of Object.keys({ ...(await readJson(join(workspace, 'package.json'))).peerDependencies,
      ...(await readJson(join(workspace, 'package.json'))).dependencies, ...(await readJson(join(workspace, 'package.json'))).devDependencies })) {
      assert.ok(inside(workspace, await realpath(join(workspace, 'node_modules', name))), 'External development dependency: ' + name)
    }
    await command('typecheck-host', workspace, process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
    await command('typecheck-client', workspace, process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json'])
    await command('build', workspace, process.execPath, ['node_modules/tsdown/dist/run.mjs', '--config', 'tsdown.release.config.ts'])
    // Official preset discovery deliberately checks node_modules rather than
    // package self-reference. Materialize this build as a regular package, not
    // a development Junction; otherwise a nested checkout can pick an OLD
    // ancestor's @local package. The archive/official installer is tested next.
    const selfPackage = join(workspace, 'node_modules/@local/workflow-agent-signal-lab')
    await mkdir(selfPackage, { recursive: true })
    await cp(join(workspace, 'lib'), join(selfPackage, 'lib'), { recursive: true, errorOnExist: true })
    await cp(join(workspace, 'package.json'), join(selfPackage, 'package.json'), { errorOnExist: true })
    assert.deepEqual(await regularFiles(join(selfPackage, 'lib')), await regularFiles(join(workspace, 'lib')))
    const selfRequire = createRequire(pathToFileURL(join(selfPackage, 'package.json')))
    const workspaceRequire = createRequire(pathToFileURL(join(workspace, 'package.json')))
    assert.equal(selfRequire.resolve('@deepseek-ai/dsh-llm'), workspaceRequire.resolve('@deepseek-ai/dsh-llm'), 'AgentLoop request identity must share the Host LLM module')
    await command('tests', workspace, process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', 'tests/*.test.mjs'])
    if (verificationPolicy) {
      const inventory = (await readdir(join(workspace, 'tests'))).filter(file => file.endsWith('.test.mjs')).sort()
      assert.equal(inventory.length, verificationPolicy.expectedTestFiles)
      const report = await readFile(join(output, 'tests.log'), 'utf8'), counts = {}
      for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
        const match = report.match(new RegExp('^# ' + field + ' (\\d+)$', 'mu'))
        assert.ok(match, 'Missing test summary: ' + field)
        counts[field] = Number(match[1])
      }
      assert.equal(counts.tests, verificationPolicy.expectedTests)
      assert.equal(counts.pass, verificationPolicy.expectedTests)
      for (const field of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[field], 0, field)
      receipt.testInventory = { files: inventory, ...counts }
    }
    assert.deepEqual(await inputHashes(root), source, 'Source changed during the build')
    assert.deepEqual(await inputHashes(workspace), source, 'Build modified its source inputs')

    await cp(join(workspace, 'lib'), join(payload, 'lib'), { recursive: true, errorOnExist: true })
    await cp(join(workspace, 'preset'), join(payload, 'preset'), { recursive: true, errorOnExist: true })
    const inputManifest = await readJson(join(workspace, 'package.json'))
    const dsh = inputManifest.peerDependencies[REGISTRY_MODULE] ?? '0.1.5-rc.1'
    assert.ok(['0.1.5-rc.1', DECLARATIVE_DSH].includes(dsh), 'Unsupported release Host baseline')
    if (dsh === DECLARATIVE_DSH) {
      const requireWorkspace = createRequire(join(workspace, 'package.json'))
      const include = await import(pathToFileURL(requireWorkspace.resolve('@deepseek-ai/cordis-plugin-include')).href)
      const yaml = createRequire(requireWorkspace.resolve('@deepseek-ai/dsh-app-boot'))('js-yaml')
      const definition = await readPresetDefinition({ packageRoot: workspace, include, yaml }, 'workflow-agent-signal-lab')
      const base = yaml.load(await readFile(join(workspace, 'release', 'cordis.patch.yml'), 'utf8'), { schema: include.entryListSchema })
      const layer = appendDeclarativeBundle(base, definition)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(payload, 'cordis.patch.yml'), yaml.dump(layer, { schema: include.entryListSchema, noRefs: true, lineWidth: 110 }), { flag: 'wx' })
    } else await cp(join(workspace, 'release', 'cordis.patch.yml'), join(payload, 'cordis.patch.yml'))
    await cp(join(workspace, 'release', 'README.md'), join(payload, 'README.md'))
    await cp(join(workspace, 'release', 'THIRD_PARTY_NOTICES.md'), join(payload, 'THIRD_PARTY_NOTICES.md'))
    await cp(join(workspace, 'src/workflow-resource-candidate.json'), join(payload, 'resource-policy.json'))
    assert.equal((await readJson(join(payload, 'resource-policy.json'))).dsh, dsh, 'Resource policy must match the exact release Host')
    const maintenance = ['scripts/diagnose-workflow.mjs', 'scripts/lib/workflow-diagnostics.mjs',
      'scripts/capture-workflow-native.mjs', 'scripts/lib/workflow-native-capture.mjs',
      'scripts/configure-workflow.mjs', 'scripts/workflow-profile-guard.mjs', 'scripts/lib/workflow-profile-config.mjs', 'scripts/lib/workflow-declarative-preset.mjs', 'scripts/lib/release-files.mjs',
      'scripts/transition-workflow.mjs', 'scripts/lib/workflow-profile-transition.mjs', 'scripts/lib/workflow-transition-data.mjs']
    for (const name of maintenance) {
      await mkdir(dirname(join(payload, name)), { recursive: true })
      await cp(join(workspace, name), join(payload, name))
    }
    const manifest = await readJson(join(workspace, 'package.json'))
    manifest.version = version
    manifest.description = 'DSH native supervised Workflow Agent release candidate; not production-approved.'
    manifest.license = 'UNLICENSED'
    // These services belong to the installed Host. Installing another physical
    // copy can split opaque request registries even when the version is equal.
    // DSH's official profile module fallback supplies them at boot; the installed
    // module-identity check is mandatory before activation.
    manifest.peerDependenciesMeta = Object.fromEntries(Object.keys(manifest.peerDependencies).map(name => [name, { optional: true }]))
    delete manifest.scripts; delete manifest.devDependencies; delete manifest.packageManager
    manifest.files = ['lib/*.js', 'preset', 'cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md',
      'resource-policy.json', 'release-manifest.json', ...maintenance]
    // pnpm pack normalizes package.json to this exact formatting (no final LF).
    await saveJson(join(payload, 'package.json'), manifest, { newline: false })
    const files = await regularFiles(payload)
    for (const file of Object.keys(files)) {
      assert.ok(!file.endsWith('.map') && !file.includes('node_modules'), 'No development artifacts in payload')
      if (file.endsWith('.js') || file.endsWith('.yml')) {
        const contents = await readFile(join(payload, file), 'utf8')
        for (const prefix of [root, workspace, root.replaceAll('\\', '/'), workspace.replaceAll('\\', '/')]) assert.ok(!contents.includes(prefix), 'Build machine path in ' + file)
      }
    }
    for (const entry of Object.values(manifest.exports)) assert.ok(files[entry.slice(2)], 'Missing export: ' + entry)
    await saveJson(join(payload, 'release-manifest.json'), { schemaVersion: 1, version, status: 'candidate-not-activated',
      dsh, scope: 'windows-supervised-local-l0-l1', buildMode: 'production', nodeTested: process.version, packageManager: 'pnpm@11.7.0',
      source, files, transitionProtocol: 1, ...(dsh === DECLARATIVE_DSH ? { presetAdmissionProtocol: PRESET_ADMISSION_PROTOCOL } : {}),
      automaticMigration: false, licenseDecisionPending: true })
    await command('pack', payload, process.execPath, [pnpm, 'pack', '--pack-destination', output])
    const filename = 'local-workflow-agent-signal-lab-' + version + '.tgz'
    receipt.artifact = { filename, sha256: digest(await readFile(join(output, filename))) }
    receipt.payload = await regularFiles(payload)
    receipt.status = 'passed'
  } catch (error) {
    receipt.failure = String(error.message)
    throw error
  } finally {
    receipt.finishedAt = new Date().toISOString()
    await saveJson(join(output, 'receipt.json'), receipt)
  }
  console.log(JSON.stringify({ status: receipt.status, output, artifact: receipt.artifact, activated: false, published: false }))
}
await main(process.argv.slice(2))
