/** Isolated real-process checks; never activates flags or sends tasks to port 3080. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { backupJournal } from './lib/journal-backup.mjs'

const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-budget-process-matrix-20260917')
const runtime = join(root, '.dsh/workflow-runtime')
const [action, label = 'focused'] = process.argv.slice(2)
assert.ok(['baseline', 'test', 'full', 'check'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,40}$/u)
const sha = value => createHash('sha256').update(value).digest('hex')
async function treeHashes(directory) {
  const names = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
  return Object.fromEntries(await Promise.all(names.map(async file => [file.slice(directory.length + 1).replaceAll('\\', '/'), sha(await readFile(file))])))
}
async function liveWitness() {
  return {
    writer: JSON.parse(await readFile(join(runtime, 'writer.lock'), 'utf8')),
    configSha256: sha(await readFile(join(root, 'cordis.patch.yml'))),
    sourceHashes: await treeHashes(join(root, 'src')),
    buildHashes: await treeHashes(join(root, 'lib')),
  }
}
if (action === 'baseline') {
  await mkdir(base)
  const destination = join(base, 'baseline')
  await mkdir(destination)
  const before = await liveWitness()
  for (const name of ['src', 'tests', 'scripts', 'docs', 'lib', 'preset', 'README.md', 'cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'tsdown.config.ts']) {
    await cp(join(root, name), join(destination, name), { recursive: true, force: false, errorOnExist: true })
  }
  const backup = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(destination, 'journal'), mode: 'online',
    validate: snapshot => assert.equal(snapshot.rowCount, 18) })
  assert.deepEqual(await liveWitness(), before, 'Live baseline changed during capture')
  await writeFile(join(destination, 'live-witness.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ base, backup }))
} else if (action === 'test' || action === 'full') {
  const directory = join(base, label)
  await mkdir(directory)
  const evidenceDirectory = join(directory, 'cases')
  await mkdir(evidenceDirectory)
  const startedAt = new Date().toISOString()
  const commands = action === 'test'
    ? [['tests', ['--test', '--test-name-pattern=real PowerShell budget', 'tests/workflow-native.test.mjs']]]
    : [
      ['syntax-native-tests', ['--check', 'tests/workflow-native.test.mjs']],
      ['syntax-process-fixture', ['--check', 'tests/fixtures/budget-processes/budget-probe.test.cjs']],
      ['syntax-runner', ['--check', 'scripts/budget-process-matrix.mjs']],
      ['typecheck-host', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
      ['typecheck-client', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json']],
      ['tests', ['--test', 'tests/*.test.mjs']],
    ]
  const checks = []
  let exitCode = 0
  for (const [name, args] of commands) {
    let output = ''
    const checkStartedAt = new Date().toISOString()
    try {
      const result = await promisify(execFile)(process.execPath, args, {
        cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 90000,
        env: { ...process.env, WORKFLOW_PROCESS_EVIDENCE_DIR: evidenceDirectory },
      })
      output = result.stdout + result.stderr
    } catch (error) {
      exitCode = error.code ?? 1
      output = (error.stdout ?? '') + (error.stderr ?? '') + String(error)
    }
    await writeFile(join(directory, name + '.log'), output, { flag: 'wx' })
    checks.push({ name, startedAt: checkStartedAt, finishedAt: new Date().toISOString(), exitCode })
    if (exitCode !== 0) break
  }
  const result = { startedAt, finishedAt: new Date().toISOString(), exitCode, checks,
    scope: 'official in-process AgentLoop / ToolRuntime / PowerShell / local subprocess; scripted model; temporary SQLite and workspaces; no 3080 tasks' }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ directory, ...result }))
  assert.equal(exitCode, 0, `See ${join(directory, 'tests.log')}`)
} else {
  const baseline = JSON.parse(await readFile(join(base, 'baseline/live-witness.json'), 'utf8'))
  const records = JSON.parse(await readFile(join(base, 'baseline/journal/records.json'), 'utf8'))
  const now = await liveWitness()
  assert.deepEqual(now, baseline, 'Production source, build, writer or default configuration changed')
  const backup = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(base, label + '-journal'), mode: 'online',
    validate: snapshot => assert.deepEqual(snapshot.records, records, 'Historical workflow records changed') })
  assert.deepEqual(await liveWitness(), baseline)
  await writeFile(join(base, label + '-protection.json'), JSON.stringify({ checkedAt: new Date().toISOString(), historicalRows: backup.rowCount,
    productionUnchanged: true, backup, witness: now }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ productionUnchanged: true, backup }))
}
