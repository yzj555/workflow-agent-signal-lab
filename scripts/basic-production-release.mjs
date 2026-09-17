/** This dated local activation only; no publishing, lock takeover or schema migration. */
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, mkdir, cp, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createConnection } from 'node:net'
import { backupJournal } from './lib/journal-backup.mjs'
const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-basic-production-20260917')
const candidate = join(base, 'candidate'), release = join(base, 'release')
const [action, label = 'check'] = process.argv.slice(2)
assert.ok(['prepare', 'rehearsal', 'preflight', 'backup', 'backup-stopped', 'postflight'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,50}$/u)
const sha = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
async function files(directory) {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    assert.ok(!entry.isSymbolicLink(), 'No links in a frozen build')
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name)
      result[file.slice(directory.length + 1).replaceAll('\\', '/')] = sha(await readFile(file))
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
const baseline = await json(join(base, 'baseline/witness.json'))
const expected = await json(join(base, 'baseline/journal/records.json'))
async function fixedConfig() {
  assert.equal(sha(await readFile(join(root, 'cordis.patch.yml'))), baseline.config, 'Configuration changed')
  assert.deepEqual(await files(join(root, 'preset')), Object.fromEntries(Object.entries(baseline.preset).map(([k,v]) => [k.slice(7),v])))
}
async function replay(moduleFile, rows) {
  const { WorkflowJournal, parseWorkflowJournalRecord } = await import(pathToFileURL(moduleFile).href)
  const values = new Map(rows.map(row => [row.key, parseWorkflowJournalRecord(JSON.parse(row.value))]))
  const reader = new WorkflowJournal({ get: key => values.get(key), entries: () => values.entries(),
    put: async () => { throw new Error('Compatibility replay cannot write') } })
  try { return rows.map(row => reader.readSnapshot(row.key)) }
  finally { await reader.close() }
}
await fixedConfig()
if (action === 'prepare') {
  for (const name of ['candidate-clean-build', 'candidate-clean-full', 'candidate-full-v2', 'clock-regression-after',
    'native-fixed-1', 'native-fixed-2', 'native-fixed-3', 'native-fixed-4', 'native-fixed-5', 'native-fixed-6']) {
    assert.equal((await json(join(base, name, 'result.json'))).exitCode, 0, name)
  }
  const log = await readFile(join(base, 'candidate-clean-full/tests.log'), 'utf8')
  assert.match(log, /tests 342\r?\n/u); assert.match(log, /pass 342\r?\n/u); assert.match(log, /fail 0\r?\n/u)
  assert.deepEqual(await files(join(candidate, 'src')), await files(join(root, 'src')))
  assert.equal(sha(await readFile(join(candidate, 'package.json'))), sha(await readFile(join(root, 'package.json'))))
  const db = new DatabaseSync(join(base, 'baseline/journal/journal.sqlite'), { readOnly: true })
  let rows
  try { rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all() } finally { db.close() }
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.key, sha(row.value)])), expected)
  const old = await replay(join(base, 'baseline/lib/workflow-journal.js'), rows)
  const next = await replay(join(candidate, 'lib/workflow-journal.js'), rows)
  assert.deepEqual(next, old, 'Candidate changed a historical projection')
  assert.deepEqual(await replay(join(base, 'baseline/lib/workflow-journal.js'), rows), next, 'Old build cannot replay after candidate inspection')
  await mkdir(release)
  for (const file of ['lib', 'package.json']) await cp(join(candidate, file), join(release, file), { recursive: true, force: false, errorOnExist: true })
  const manifest = { preparedAt: new Date().toISOString(), kind: 'local-activation-candidate-not-portable-release',
    targetDsh: '0.1.5-rc.1', node: process.version, changes: ['native-session-durability', 'early-budget-timer-rearm'],
    build: await files(join(release, 'lib')), source: await files(join(candidate, 'src')),
    packageSha256: sha(await readFile(join(release, 'package.json'))),
    oldBuild: Object.fromEntries(Object.entries(baseline.build).map(([k,v]) => [k.slice(4),v])),
    oldWriter: baseline.writer, configSha256: baseline.config, regression: { tests: 342, passed: 342 },
    compatibility: { rows: rows.length, newAndOldProjectionsEqual: true, dataMigration: false },
    limits: ['Dependencies remain local official-source junctions', 'No portable install or full Gate E claim', 'No live activation yet'] }
  await save(join(release, 'manifest.json'), manifest)
  await save(join(base, 'compatibility.json'), { status: 'passed', ...manifest.compatibility,
    records: next.map(s => ({ id: s.rootSessionId, revision: s.revision, outcome: s.run?.outcome ?? null })) })
  console.log(JSON.stringify({ status: 'prepared', rows: rows.length, buildFiles: Object.keys(manifest.build).length, release }))
} else if (action === 'rehearsal') {
  const manifest = await json(join(release, 'manifest.json'))
  const directory = join(base, 'rollback-rehearsal')
  await mkdir(directory)
  await cp(join(base, 'baseline/lib'), join(directory, 'active'), { recursive: true, force: false, errorOnExist: true })
  await rename(join(directory, 'active'), join(directory, 'previous'))
  await cp(join(release, 'lib'), join(directory, 'active'), { recursive: true, force: false, errorOnExist: true })
  assert.deepEqual(await files(join(directory, 'active')), manifest.build)
  await rename(join(directory, 'active'), join(directory, 'rejected'))
  await rename(join(directory, 'previous'), join(directory, 'active'))
  assert.deepEqual(await files(join(directory, 'active')), manifest.oldBuild)
  await save(join(directory, 'result.json'), { status: 'passed', oldBuildRestored: true,
    sourceUnchanged: true, dataMigration: false, scope: 'isolated build-directory swap, not a live Host rollback' })
  console.log(JSON.stringify({ status: 'passed', isolatedBuildRollback: true }))
} else if (action === 'backup' || action === 'backup-stopped') {
  const receipt = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, label + '-journal'),
    mode: action === 'backup' ? 'online' : 'stopped',
    assertStopped: action === 'backup-stopped' ? async () => {
      const owner = await json(join(root, '.dsh/workflow-runtime/writer.lock'))
      assert.deepEqual(owner, baseline.writer)
      assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' })
      await new Promise((accept, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: 3080 })
        socket.setTimeout(1500)
        socket.once('connect', () => { socket.destroy(); reject(Error('3080 still serving')) })
        socket.once('timeout', () => { socket.destroy(); reject(Error('Cannot establish stopped port')) })
        socket.once('error', error => error.code === 'ECONNREFUSED' ? accept() : reject(error))
      })
      return { ...owner, checkedAt: new Date().toISOString(), port3080: 'not-listening' }
    } : undefined,
    validate: snapshot => assert.deepEqual(snapshot.records, expected) })
  console.log(JSON.stringify({ rows: receipt.rowCount, integrity: receipt.integrity, status: receipt.backup }))
} else {
  const manifest = await json(join(release, 'manifest.json'))
  assert.deepEqual(await files(join(release, 'lib')), manifest.build)
  assert.equal(sha(await readFile(join(release, 'package.json'))), manifest.packageSha256)
  assert.deepEqual(await files(join(root, 'lib')), action === 'preflight' ? manifest.oldBuild : manifest.build)
  if (action === 'preflight') {
    assert.deepEqual(await json(join(root, '.dsh/workflow-runtime/writer.lock')), baseline.writer)
    assert.equal(sha(await readFile(join(root, 'package.json'))), manifest.packageSha256)
    assert.deepEqual(await files(join(root, 'src')), manifest.source)
    assert.equal((await json(join(base, 'rollback-rehearsal/result.json'))).status, 'passed')
  }
  else {
    const owner = await json(join(root, '.dsh/workflow-runtime/writer.lock'))
    assert.notEqual(owner.instanceId, baseline.writer.instanceId)
    assert.equal(sha(await readFile(join(root, 'package.json'))), manifest.packageSha256)
    assert.deepEqual(await files(join(root, 'src')), manifest.source)
  }
  const result = { checkedAt: new Date().toISOString(), status: 'passed', action, immutableCandidate: true,
    configurationUnchanged: true, presetUnchanged: true,
    writer: await json(join(root, '.dsh/workflow-runtime/writer.lock')),
    testedSourceFiles: Object.keys(manifest.source).length, buildFiles: Object.keys(manifest.build).length }
  if (label !== 'check') await save(join(base, label + '-' + action + '.json'), result)
  console.log(JSON.stringify(result))
}
