/** Isolated child-Host failure injection. Never stop or write the live 3080 Host. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { backupJournal } from './lib/journal-backup.mjs'

const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-crash-recovery-matrix-20260917')
const runtime = join(root, '.dsh/workflow-runtime')
const [action, label = 'focused'] = process.argv.slice(2)
assert.ok(['baseline', 'test', 'native', 'full', 'check'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,40}$/u)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
async function hashes(folder) {
  const result = {}
  for (const entry of await readdir(join(root, folder), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    result[path.slice(root.length + 1).replaceAll('\\', '/')] = sha(await readFile(path))
  }
  return result
}
async function witness() {
  return { writer: await json(join(runtime, 'writer.lock')),
    config: sha(await readFile(join(root, 'cordis.patch.yml'))),
    source: await hashes('src'), build: await hashes('lib'), preset: await hashes('preset') }
}
if (action === 'baseline') {
  await mkdir(base)
  await mkdir(join(base, 'baseline'))
  const before = await witness()
  for (const name of ['src', 'lib', 'tests', 'scripts', 'docs', 'preset', 'README.md', 'cordis.patch.yml', 'package.json']) {
    await cp(join(root, name), join(base, 'baseline', name), { recursive: true, force: false, errorOnExist: true })
  }
  const backup = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(base, 'baseline/journal'), mode: 'online' })
  assert.deepEqual(await witness(), before)
  await save(join(base, 'baseline/witness.json'), before)
  console.log(JSON.stringify({ base, rows: backup.rowCount, writer: before.writer }))
} else if (action === 'check') {
  const before = await json(join(base, 'baseline/witness.json'))
  assert.deepEqual(await witness(), before, 'Production code, bundle, preset, Host or configuration changed')
  const records = await json(join(base, 'baseline/journal/records.json'))
  const backup = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(base, label + '-journal'),
    mode: 'online', validate: snapshot => assert.deepEqual(snapshot.records, records, 'Live workflow records changed') })
  assert.deepEqual(await witness(), before)
  const result = { checkedAt: new Date().toISOString(), status: 'passed', unchangedRecords: backup.rowCount,
    hostUnchanged: true, configUnchanged: true, presetUnchanged: true, sourceUnchanged: true, buildUnchanged: true, writer: before.writer }
  await save(join(base, label + '-protection.json'), result)
  console.log(JSON.stringify(result))
} else {
  assert.deepEqual(await witness(), await json(join(base, 'baseline/witness.json')))
  const directory = join(base, label)
  await mkdir(directory)
  await mkdir(join(directory, 'cases'))
  await mkdir(join(directory, 'native-cases'))
  const checks = []
  const commands = action === 'test' ? [['tests', ['--test', 'tests/workflow-crash-recovery.test.mjs']]]
    : action === 'native' ? [['tests', ['--test', '--test-name-pattern=real PowerShell budget', 'tests/workflow-native.test.mjs']]] : [
    ['syntax-host', ['--check', 'tests/helpers/workflow-crash-host.mjs']],
    ['syntax-tests', ['--check', 'tests/workflow-crash-recovery.test.mjs']],
    ['typecheck-host', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
    ['typecheck-client', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json']],
    ['tests', ['--test', 'tests/*.test.mjs']],
  ]
  let exitCode = 0
  for (const [name, args] of commands) {
    const startedAt = new Date().toISOString()
    let output
    try {
      const result = await promisify(execFile)(process.execPath, args, { cwd: root, windowsHide: true,
        maxBuffer: 12 * 1024 * 1024, timeout: 240000,
        env: { ...process.env, WORKFLOW_CRASH_EVIDENCE_DIR: join(directory, 'cases'),
          WORKFLOW_PROCESS_EVIDENCE_DIR: join(directory, 'native-cases') } })
      output = result.stdout + result.stderr
    } catch (error) {
      exitCode = typeof error.code === 'number' ? error.code : 1
      output = (error.stdout ?? '') + (error.stderr ?? '') + String(error)
    }
    await writeFile(join(directory, name + '.log'), output, { flag: 'wx' })
    checks.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode })
    if (exitCode !== 0) break
  }
  const result = { checkedAt: new Date().toISOString(), checks, exitCode,
    scope: 'isolated native child Hosts; real SQLite and optional PowerShell; scripted model and fixture question answers; no live 3080 interruption or writes' }
  await save(join(directory, 'result.json'), result)
  console.log(JSON.stringify({ directory, ...result }))
  process.exitCode = exitCode
}
