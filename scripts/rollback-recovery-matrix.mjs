/** Dated, isolated candidate verification. Never restart or replace the live Host. */
import assert from 'node:assert/strict'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { backupJournal } from './lib/journal-backup.mjs'
const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-rollback-recovery-20260917')
const candidate = join(base, 'candidate')
const [action, label = 'check'] = process.argv.slice(2)
assert.ok(['baseline', 'stage', 'sync', 'build', 'test', 'full', 'check'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,50}$/u)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
async function hashes(folder, directory = root) {
  const values = {}
  for (const entry of await readdir(join(directory, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { const file = join(entry.parentPath, entry.name); values[file.slice(directory.length + 1).replaceAll('\\', '/')] = sha(await readFile(file)) }
  }
  return values
}
async function witness() {
  return { writer: await json(join(root, '.dsh/workflow-runtime/writer.lock')),
    config: sha(await readFile(join(root, 'cordis.patch.yml'))), build: await hashes('lib'), preset: await hashes('preset') }
}
if (action === 'baseline') {
  await mkdir(base); await mkdir(join(base, 'baseline'))
  const before = await witness()
  for (const name of ['src', 'lib', 'tests', 'scripts', 'docs', 'preset', 'README.md', 'CHANGELOG.md', 'package.json',
    'tsdown.config.ts', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json', 'cordis.patch.yml']) {
    await cp(join(root, name), join(base, 'baseline', name), { recursive: true, force: false, errorOnExist: true })
  }
  const backup = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, 'baseline/journal'), mode: 'online' })
  assert.deepEqual(await witness(), before)
  await save(join(base, 'baseline/witness.json'), before)
  console.log(JSON.stringify({ base, rows: backup.rowCount, writer: before.writer }))
} else if (action === 'stage' || action === 'sync') {
  assert.deepEqual(await witness(), await json(join(base, 'baseline/witness.json')))
  if (action === 'stage') await mkdir(candidate)
  else assert.equal((await json(join(candidate, 'package.json'))).name, '@local/workflow-agent-signal-lab')
  // No lib on first stage: build starts from empty outputs. No online config/data.
  for (const name of ['src', 'tests', 'scripts', 'preset', 'package.json', 'tsdown.config.ts', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.client.json']) {
    await cp(join(root, name), join(candidate, name), { recursive: true, force: action === 'sync', errorOnExist: action === 'stage' })
  }
  console.log(candidate)
} else if (action === 'check') {
  const before = await json(join(base, 'baseline/witness.json'))
  assert.deepEqual(await witness(), before, 'Live Host, build, preset or configuration changed')
  assert.deepEqual(await hashes('src'), await hashes('src', candidate), 'Candidate source is not current')
  assert.notDeepEqual(await hashes('lib', candidate), {}, 'Candidate build is empty')
  const records = await json(join(base, 'baseline/journal/records.json'))
  const backup = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, label + '-journal'),
    mode: 'online', validate: snapshot => assert.deepEqual(snapshot.records, records) })
  assert.deepEqual(await witness(), before)
  const result = { status: 'passed', checkedAt: new Date().toISOString(), unchangedRecords: backup.rowCount,
    liveHostUnchanged: true, liveBuildUnchanged: true, candidateSourceMatches: true, candidateNotActivated: true,
    configUnchanged: true, presetUnchanged: true, writer: before.writer }
  await save(join(base, label + '-protection.json'), result); console.log(JSON.stringify(result))
} else {
  assert.deepEqual(await witness(), await json(join(base, 'baseline/witness.json')))
  const output = join(base, label)
  await mkdir(output); await mkdir(join(output, 'cases')); await mkdir(join(output, 'native-cases'))
  const checks = [], commands = action === 'build' ? [
    ['typecheck-host', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
    ['typecheck-client', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json']],
    ['build', ['node_modules/tsdown/dist/run.mjs', '--config', 'tsdown.config.ts']],
  ] : [['tests', action === 'test' ? ['--test', 'tests/workflow-rollback-recovery.test.mjs', 'tests/workflow-project-controller.test.mjs'] : ['--test', 'tests/*.test.mjs']]]
  let exitCode = 0
  for (const [name, args] of commands) {
    const startedAt = new Date().toISOString()
    let log
    try {
      const result = await promisify(execFile)(process.execPath, args, { cwd: candidate, windowsHide: true, maxBuffer: 20000000, timeout: 240000,
        env: { ...process.env, WORKFLOW_CRASH_EVIDENCE_DIR: join(output, 'cases'), WORKFLOW_PROCESS_EVIDENCE_DIR: join(output, 'native-cases') } })
      log = result.stdout + result.stderr
    } catch (error) { exitCode = typeof error.code === 'number' ? error.code : 1; log = (error.stdout ?? '') + (error.stderr ?? '') + String(error) }
    await writeFile(join(output, name + '.log'), log, { flag: 'wx' })
    checks.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode })
    if (exitCode) break
  }
  await save(join(output, 'result.json'), { candidate, exitCode, checks })
  console.log(JSON.stringify({ output, exitCode, checks })); process.exitCode = exitCode
}
