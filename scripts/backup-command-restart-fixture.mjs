/** Backup/guard for the single authorized 2026-09-15 Host-loss fixture.
 * Never writes the live database, config or native Session files.
 */
import assert from 'node:assert/strict'
import { DatabaseSync, backup } from 'node:sqlite'
import { constants } from 'node:fs'
import { readFile, writeFile, mkdir, copyFile, cp, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const [mode] = process.argv.slice(2)
assert.ok(['before', 'check', 'after'].includes(mode))
const root = resolve('F:/dsh/workflow-agent-signal-lab')
const runtime = join(root, '.dsh/workflow-runtime')
const evidence = join(root, '.dsh/activation/workflow-command-online-suite-20260915/restart-v3')
const sessionId = 'workflow-command-online-restart-v3-20260915'
const fixture = resolve('F:/dsh/workflow-command-restart-v3-fixture-20260915')
const journalFile = join(runtime, 'journal.sqlite')
const ownerExpected = { pid: 49572, instanceId: '95e805e7-ffc2-4b3f-b3cb-3e615f3db36a' }
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const sha = data => createHash('sha256').update(data).digest('hex')
const exists = async file => {
  try { await access(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
const pidAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
const guard = await json(join(evidence, 'process-observation.json'))
assert.equal(guard.status, 'ready-for-authorized-interruption')
assert.equal(guard.sessionId, sessionId)
assert.equal(resolve(guard.fixture), fixture)
assert.deepEqual(guard.native.otherRunning, [])
assert.deepEqual(guard.native.otherActiveChildren, [])
for (const key of ['residentDiagnostics', 'unclassifiedResident', 'otherQueues', 'otherJobs']) assert.deepEqual(guard.native[key], [])
assert.ok(guard.native.resident?.ids.includes(sessionId), 'test root missing from live control baseline')
const owner = await json(join(runtime, 'writer.lock'))
assert.equal(owner.pid, ownerExpected.pid)
assert.equal(owner.instanceId, ownerExpected.instanceId)
if (mode !== 'after') {
  assert.equal(pidAlive(owner.pid), true, 'old Host is no longer alive')
  assert.ok(Date.now() - Date.parse(guard.native.checkedAt) < 15000, 'native idle preflight is stale')
  assert.ok(Date.now() - guard.proof.startedAt < 45000, 'too near fixture self-exit; do not interrupt')
  assert.equal(pidAlive(guard.proof.testPid), true)
  assert.equal(pidAlive(guard.proof.childPid), true)
} else assert.equal(pidAlive(owner.pid), false, 'raw crash backup requires the exact old Host to be gone')

const describe = file => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const rows = db.prepare('SELECT key, value FROM u_workflow_runtime_sessions ORDER BY key').all()
    const records = Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)]))
    const record = records[sessionId]
    assert.equal(record.rootSessionId, sessionId)
    const starts = record.events.filter(event => event.data.name === 'command/started')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].data.payload.commandId, guard.commandStart.data.payload.commandId)
    assert.equal(starts[0].data.payload.checkId, 'ENG-1')
    assert.equal(starts[0].data.payload.timeoutMs, 60000)
    assert.equal(record.events.some(event => event.data.name === 'command/finished'), false,
      'the command already settled; this is not an unknown-exit sample')
    for (const [id, revision] of Object.entries({
      'workflow-production-l1-clean-pass-20260911-1810': 126,
      'workflow-command-online-normal-v2-20260915': 49,
      'workflow-command-online-timeout-20260915': 44,
      'workflow-command-online-cancel-20260915': 36,
      'workflow-command-online-normal-20260915': 2,
      'workflow-command-online-restart-20260915': 36,
    })) assert.equal(records[id]?.revision, revision, `protected record changed: ${id}`)
    return { integrity: 'ok', sessionId, revision: record.revision,
      commandId: starts[0].data.payload.commandId,
      records: Object.fromEntries(rows.map(row => [row.key, {
        revision: records[row.key].revision, sha256: sha(row.value),
      }])) }
  } finally { db.close() }
}

const nativeFolders = [
  '--F-dsh-workflow-command-restart-v3-fixture-20260915--',
  '--F-dsh-workflow-command-restart-v2-fixture-20260915--',
  '--F-dsh-workflow-command-restart-fixture-20260915--',
  '--F-dsh-workflow-command-cancel-fixture-20260915--',
  '--F-dsh-workflow-command-timeout-fixture-20260915--',
  '--F-dsh-workflow-command-fixture-20260915--',
  '--F-dsh-workflow-agent-production-gate-clean-fixture--',
]
const nativeBase = 'C:/Users/Administrator/.dsh/sessions'
const nativeBackup = async destination => {
  await mkdir(join(destination, 'native-sessions'))
  for (const folder of nativeFolders) {
    const source = resolve(nativeBase, folder)
    assert.equal(source.startsWith(resolve(nativeBase) + '\\'), true)
    await cp(source, join(destination, 'native-sessions', folder),
      { recursive: true, force: false, errorOnExist: true })
  }
}

if (mode === 'check') {
  const current = describe(journalFile)
  const baseline = await json(join(evidence, 'before-interruption', 'manifest.json'))
  for (const [id, state] of Object.entries(baseline.journal.records)) {
    if (id !== sessionId) assert.deepEqual(current.records[id], state, `other workflow changed since backup: ${id}`)
  }
  console.log(JSON.stringify({ status: 'fresh-open-command-and-protected-records-verified',
    commandId: current.commandId, checkedAt: new Date().toISOString() }))
} else {
  const destination = join(evidence, mode === 'before' ? 'before-interruption' : 'after-interruption')
  assert.equal(await exists(destination), false, 'refuse to overwrite an earlier backup')
  await mkdir(destination)
  let journal
  if (mode === 'before') {
    const source = new DatabaseSync(journalFile, { readOnly: true })
    try { await backup(source, join(destination, 'journal.sqlite')) } finally { source.close() }
    journal = describe(join(destination, 'journal.sqlite'))
  } else {
    // Preserve the exact DB + WAL + SHM first. Reading only the backup below
    // may affect its WAL bookkeeping, so validate a second working copy.
    const raw = join(destination, 'raw-journal')
    await mkdir(raw)
    for (const name of ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm']) {
      if (await exists(join(runtime, name))) await copyFile(join(runtime, name), join(raw, name), constants.COPYFILE_EXCL)
    }
    const verified = join(destination, 'verified-journal')
    await cp(raw, verified, { recursive: true, force: false, errorOnExist: true })
    journal = describe(join(verified, 'journal.sqlite'))
  }
  await copyFile(join(runtime, 'writer.lock'), join(destination, 'writer.lock'), constants.COPYFILE_EXCL)
  await nativeBackup(destination)
  const configs = ['.dsh/profiles/web/cordis.yml', '.dsh/profiles/web/cordis.patch.yml',
    '.dsh/.agent-presets/workflow-agent-signal-lab/agent.cordis.yml']
  await mkdir(join(destination, 'config'))
  const configHashes = {}
  for (let index = 0; index < configs.length; index++) {
    const bytes = await readFile(join(root, configs[index]))
    configHashes[configs[index]] = sha(bytes)
    await writeFile(join(destination, 'config', `${index}.yml`), bytes, { flag: 'wx' })
  }
  const manifest = { backedUpAt: new Date().toISOString(), mode, owner, journal, configHashes,
    nativeFolders, nativeCopyConsistency: mode === 'before' ? 'live-file-copy; durable journal uses SQLite backup API'
      : 'quiescent-copy-after-verified-Host-exit',
    diagnosticProof: guard.proof }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: 'backup-complete', mode, destination,
    revision: journal.revision, commandId: journal.commandId, integrity: journal.integrity }))
}
