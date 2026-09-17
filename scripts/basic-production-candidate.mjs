/** Build and verify in a separate candidate. Never replace the live bundle or restart 3080. */
import assert from 'node:assert/strict'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { backupJournal } from './lib/journal-backup.mjs'
const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-basic-production-20260917')
const candidate = join(base, 'candidate')
const [action, label = 'check'] = process.argv.slice(2)
assert.ok(['baseline', 'stage', 'sync', 'build', 'focused', 'clock', 'native', 'full', 'check'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,50}$/u)
const sha = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
async function hashes(folder) {
  const values = {}
  for (const e of await readdir(join(root, folder), { recursive: true, withFileTypes: true })) {
    if (e.isFile()) { const file = join(e.parentPath, e.name); values[file.slice(root.length + 1).replaceAll('\\', '/')] = sha(await readFile(file)) }
  }
  return values
}
async function witness() {
  return { writer: await json(join(root, '.dsh/workflow-runtime/writer.lock')), config: sha(await readFile(join(root, 'cordis.patch.yml'))),
    build: await hashes('lib'), preset: await hashes('preset') }
}
if (action === 'baseline') {
  await mkdir(base); await mkdir(join(base, 'baseline'))
  const before = await witness()
  for (const name of ['src', 'lib', 'tests', 'scripts', 'docs', 'preset', 'README.md', 'package.json', 'tsdown.config.ts',
    'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json', 'cordis.patch.yml']) {
    await cp(join(root, name), join(base, 'baseline', name), { recursive: true, force: false, errorOnExist: true })
  }
  const backup = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, 'baseline/journal'), mode: 'online' })
  assert.deepEqual(await witness(), before)
  await save(join(base, 'baseline/witness.json'), before)
  console.log(JSON.stringify({ base, rows: backup.rowCount }))
} else if (action === 'stage') {
  await mkdir(candidate)
  for (const name of ['src', 'lib', 'tests', 'scripts', 'preset', 'package.json', 'tsdown.config.ts', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json']) {
    await cp(join(root, name), join(candidate, name), { recursive: true, force: false, errorOnExist: true })
  }
  console.log(candidate)
} else if (action === 'sync') {
  assert.deepEqual(await witness(), await json(join(base, 'baseline/witness.json')))
  assert.equal((await json(join(candidate, 'package.json'))).name, '@local/workflow-agent-signal-lab')
  // Mechanical source synchronization into this one pre-created candidate only.
  // Never copy configuration, native sessions, runtime records, or live lib.
  for (const name of ['src', 'tests', 'scripts', 'package.json', 'tsdown.config.ts', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json']) {
    await cp(join(root, name), join(candidate, name), { recursive: true })
  }
  console.log(candidate)
} else if (action === 'check') {
  const before = await json(join(base, 'baseline/witness.json'))
  assert.deepEqual(await witness(), before, 'Live Host, configuration, preset or build changed')
  const records = await json(join(base, 'baseline/journal/records.json'))
  const backup = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, label + '-journal'),
    mode: 'online', validate: value => assert.deepEqual(value.records, records) })
  assert.deepEqual(await witness(), before)
  const result = { status: 'passed', checkedAt: new Date().toISOString(), unchangedRecords: backup.rowCount,
    hostUnchanged: true, liveBuildUnchanged: true, configUnchanged: true, presetUnchanged: true, writer: before.writer }
  await save(join(base, label + '-protection.json'), result); console.log(JSON.stringify(result))
} else {
  assert.deepEqual(await witness(), await json(join(base, 'baseline/witness.json')))
  const dest = join(base, label)
  await mkdir(dest); await mkdir(join(dest, 'cases')); await mkdir(join(dest, 'native-cases'))
  const commands = action === 'build' ? [
    ['typecheck-host', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
    ['typecheck-client', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json']],
    ['build', ['node_modules/tsdown/dist/run.mjs', '--config', 'tsdown.config.ts']],
  ] : action === 'focused' ? [['tests', ['--test', 'tests/workflow-session-durability.test.mjs', 'tests/workflow-crash-recovery.test.mjs']]]
    : action === 'clock' ? [['tests', ['--test', '--test-name-pattern=fractional remaining|early boundary', 'tests/workflow-run-time.test.mjs']]]
    : action === 'native' ? [['tests', ['--test', '--test-name-pattern=real PowerShell budget', 'tests/workflow-native.test.mjs']]]
      : [['tests', ['--test', 'tests/*.test.mjs']]]
  let exitCode = 0
  const checks = []
  for (const [name, args] of commands) {
    const startedAt = new Date().toISOString()
    let output
    try {
      const result = await promisify(execFile)(process.execPath, args, { cwd: candidate, windowsHide: true, maxBuffer: 16000000, timeout: 240000,
        env: { ...process.env, WORKFLOW_CRASH_EVIDENCE_DIR: join(dest, 'cases'), WORKFLOW_PROCESS_EVIDENCE_DIR: join(dest, 'native-cases') } })
      output = result.stdout + result.stderr
    } catch (error) { exitCode = typeof error.code === 'number' ? error.code : 1; output = (error.stdout ?? '') + (error.stderr ?? '') + String(error) }
    await writeFile(join(dest, name + '.log'), output, { flag: 'wx' })
    checks.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode })
    if (exitCode) break
  }
  const result = { candidate, exitCode, checks }
  await save(join(dest, 'result.json'), result); console.log(JSON.stringify(result)); process.exitCode = exitCode
}
