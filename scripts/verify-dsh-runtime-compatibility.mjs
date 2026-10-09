/** Isolated native-regression evidence; not an installer or a live activation. */
import assert from 'node:assert/strict'
import { readFile, cp, realpath, lstat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { regularFiles, newDirectory, saveJson, digest, inside } from './lib/release-files.mjs'
import { nativeRegressionReport } from './lib/native-regression-report.mjs'

const root = resolve(import.meta.dirname, '..')
const suite = 'tests/workflow-native.test.mjs'
const flags = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1]
  assert.ok(['--probe', '--official-source', '--output'].includes(name) && value && isAbsolute(value) && !flags.has(name), 'invalid-arguments')
  flags.set(name, value)
}
assert.equal(flags.size, 3, 'probe-official-source-and-new-output-required')
const probe = JSON.parse(await readFile(flags.get('--probe'), 'utf8'))
assert.equal(probe.status, 'completed-compatibility-probe-not-production-approved')
assert.equal(probe.target, '0.2.0-rc.2')
const workspace = await realpath(probe.workspace), output = resolve(flags.get('--output')), official = resolve(flags.get('--official-source'))
assert.ok(!inside(root, workspace) && !inside(official, workspace), 'isolated-workspace-required')
assert.ok(!inside(workspace, output) && !inside(official, output), 'output-overlaps-protected-inputs')
const git = args => execFileSync('git', args, { cwd: official, windowsHide: true, encoding: 'utf8' }).trim()
assert.equal(git(['rev-parse', 'HEAD']), probe.sourceCommit)
assert.equal(git(['status', '--porcelain']), '', 'official-checkout-changed')
const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
assert.equal(manifest.private, true)
assert.equal(manifest.name, 'workflow-private-compatibility-probe')
assert.equal(manifest.dependencies['@deepseek-ai/dsh'], probe.target)
for (const name of Object.keys(manifest.dependencies)) assert.ok(inside(workspace, await realpath(join(workspace, 'node_modules', name))), 'external-dependency: ' + name)
const protect = async () => ({ src: await regularFiles(join(root, 'src')), preset: await regularFiles(join(root, 'preset')),
  lib: await regularFiles(join(root, 'lib')), tests: await regularFiles(join(root, 'tests')) })
const protectedBefore = await protect()
assert.deepEqual(protectedBefore.src, probe.sourceFiles, 'canonical-source-changed-since-probe')
const text = await readFile(join(workspace, suite), 'utf8')
const names = [...text.matchAll(/^test\('([^']+)'/gmu)].map(value => value[1])
assert.equal(names.length, 38, 'native-suite-inventory-changed-needs-review')
assert.equal(new Set(names).size, names.length)
assert.match(text, /class ScriptedAdapter extends LlmAdapter/u)
assert.match(text, /provider: 'scripted', model: 'test-only'/u)
await newDirectory(output)
const receipt = { schemaVersion: 1, status: 'failed', target: probe.target, sourceCommit: probe.sourceCommit,
  workspace, startedAt: new Date().toISOString(), node: process.version, buildMode: 'production', expectedTestNames: names, checks: [],
  isolation: { liveHostRestarted: false, realModelTaskSent: false, productionProfileCreated: false,
    installedReleaseTest: false, originalArchivesMigrated: false }, productionReady: false }
async function run(name, args, expectedNames) {
  const logPath = join(output, name + '.log'), log = createWriteStream(logPath, { flags: 'wx' })
  const env = { ...process.env, CI: 'true', NODE_ENV: 'production' }
  for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|PASSWORD|CREDENTIAL|NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT/iu.test(key)) delete env[key]
  const child = spawn(process.execPath, args, { cwd: workspace, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 300000)
  const result = await new Promise(done => {
    child.once('error', error => done({ code: null, error: error.code }))
    child.once('close', (code, signal) => done({ code, signal }))
  })
  clearTimeout(timer); log.end(); await finished(log)
  const report = await readFile(logPath, 'utf8')
  const check = { name, ...result, timedOut, nodeEnv: env.NODE_ENV, logSha256: digest(report) }
  if (expectedNames) {
    Object.assign(check, nativeRegressionReport(report, expectedNames))
  }
  receipt.checks.push(check)
  console.log(JSON.stringify({ stage: name, code: result.code, tests: check.tests, pass: check.pass, fail: check.fail }))
  assert.ok(!timedOut && result.code === 0, 'candidate-check-failed: ' + name)
  if (expectedNames) {
    assert.equal(check.inventoryMatches, true, 'filtered-or-incomplete-test-inventory')
    assert.equal(check.tests, expectedNames.length); assert.equal(check.pass, expectedNames.length)
    assert.equal(check.fail, 0); assert.equal(check.skipped, 0); assert.equal(check.cancelled, 0)
    assert.equal(check.completePass, true)
  }
}
try {
  for (const dir of ['src', 'tests', 'preset']) {
    await cp(join(workspace, dir), join(output, 'candidate', dir), { recursive: true, errorOnExist: true })
    receipt[dir + 'Files'] = await regularFiles(join(workspace, dir))
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json', 'tsdown.config.ts', 'tsdown.release.config.ts']) {
    await cp(join(workspace, name), join(output, 'candidate', name), { errorOnExist: true })
  }
  receipt.sourceChanges = Object.entries(receipt.srcFiles).filter(([name, sha]) => probe.sourceFiles[name] !== sha)
    .map(([name, sha]) => ({ file: name, before: probe.sourceFiles[name], after: sha }))
  await run('host-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
  await run('client-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json'])
  await run('build', ['node_modules/tsdown/dist/run.mjs', '--config', 'tsdown.release.config.ts'])
  const fixture = join(workspace, 'node_modules/@local/workflow-agent-signal-lab')
  assert.equal((await lstat(fixture)).isSymbolicLink(), false, 'self-fixture-link')
  assert.equal((await realpath(fixture)).toLowerCase(), fixture.toLowerCase(), 'self-fixture-must-not-be-a-development-link')
  assert.ok(inside(workspace, fixture), 'fixture-outside-private-workspace')
  // Materialize exactly this build into the private fixture's regular files;
  // the previous development-mode probe must not supply the native test code.
  receipt.previousFixtureLib = await regularFiles(join(fixture, 'lib'))
  await cp(join(workspace, 'lib'), join(fixture, 'lib'), { recursive: true, force: true })
  assert.deepEqual(await regularFiles(join(fixture, 'lib')), await regularFiles(join(workspace, 'lib')), 'materialized-fixture-build-changed')
  const nativeRequire = createRequire(join(workspace, 'package.json')), fixtureRequire = createRequire(join(fixture, 'package.json'))
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-session']) {
    assert.equal(nativeRequire.resolve(name), fixtureRequire.resolve(name), 'split-native-module: ' + name)
  }
  await run('native-regression', ['--test', '--test-reporter=tap', suite], names)
  await cp(join(workspace, 'lib'), join(output, 'candidate/lib'), { recursive: true, errorOnExist: true })
  receipt.libFiles = await regularFiles(join(workspace, 'lib'))
  receipt.status = 'isolated-native-regression-passed-not-production-approved'
  receipt.remaining = ['declarative release bundle and Profile planner/guard', 'new inbox/job diagnostic completeness',
    'fresh redistributable package with fixed new dependency graph', 'installed official Host read-only UI acceptance', 'authorized independent real use and final delivery gates']
} catch (error) { receipt.failure = String(error.message); process.exitCode = 1 }
finally {
  try {
    assert.deepEqual(await protect(), protectedBefore, 'canonical-source-tests-preset-or-lib-changed')
    assert.equal(git(['rev-parse', 'HEAD']), probe.sourceCommit)
    assert.equal(git(['status', '--porcelain']), '')
    receipt.canonicalInputsAndOfficialCheckoutUnchanged = true
  } catch (error) { receipt.status = 'failed'; receipt.failure = String(error.message); process.exitCode = 1 }
  receipt.finishedAt = new Date().toISOString()
  await saveJson(join(output, 'receipt.json'), receipt)
  console.log(JSON.stringify({ status: receipt.status, failure: receipt.failure, productionReady: false }))
}
