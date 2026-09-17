/** Scoped immutable backups for the three explicitly authorized test epochs. */
import assert from 'node:assert/strict'
import { DatabaseSync, backup } from 'node:sqlite'
import { constants } from 'node:fs'
import { readFile, writeFile, mkdir, cp, copyFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const [mode, phase, pid, instance] = process.argv.slice(2)
assert.ok(['before', 'check', 'after'].includes(mode))
assert.ok(['activation', 'interruption', 'persistence'].includes(phase))
const root = resolve('F:/dsh/workflow-agent-signal-lab')
const base = join(root, '.dsh/activation/workflow-manual-recovery-20260915')
const target = join(base, phase), runtime = join(root, '.dsh/workflow-runtime')
const testId = 'workflow-command-online-manual-recovery-20260915'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exists = async file => { try { await access(file); return true } catch (e) { if (e.code !== 'ENOENT') throw e; return false } }
const alive = id => { try { process.kill(id, 0); return true } catch (e) { if (e.code !== 'ESRCH') throw e; return false } }
const owner = await json(join(runtime, 'writer.lock'))
assert.equal(owner.pid, Number(pid)); assert.equal(owner.instanceId, instance)
assert.equal(alive(owner.pid), mode !== 'after')
const audit = await json(join(target, 'preflight.json'))
if (mode !== 'after') {
  if (phase === 'interruption') {
    assert.equal(audit.status, 'ready-for-authorized-interruption')
    assert.equal(audit.sessionId, testId)
    for (const key of ['otherRunning', 'otherActiveChildren', 'residentDiagnostics', 'unclassifiedResident', 'otherQueues', 'otherJobs']) assert.deepEqual(audit.native[key], [])
    assert.ok(Date.now() - Date.parse(audit.native.checkedAt) < 15000)
    assert.ok(Date.now() - audit.proof.startedAt < 60000)
    assert.equal(alive(audit.proof.testPid), true); assert.equal(alive(audit.proof.childPid), true)
  } else {
    assert.ok(Date.now() - Date.parse(audit.checkedAt) < 15000)
    for (const key of ['running', 'active', 'failures', 'residentDiagnostics', 'unclassifiedResident']) assert.deepEqual(audit[key], [])
    assert.ok(Object.values(audit.resident.queues).every(count => count === 0))
    assert.ok(Object.values(audit.resident.jobs).every(jobs => jobs.length === 0))
  }
}
function describe(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
    const records = new Map(rows.map(row => [row.key, JSON.parse(row.value)]))
    assert.equal(records.get('workflow-production-l1-clean-pass-20260911-1810').revision, 126)
    assert.equal(records.get('workflow-command-online-restart-v3-20260915').revision, 35)
    if (phase === 'interruption') {
      const record = records.get(testId)
      assert.ok(record)
      const starts = record.events.filter(e => e.data.name === 'command/started')
      assert.equal(starts.length, 1)
      assert.equal(starts[0].data.payload.commandId, audit.commandStart.data.payload.commandId)
      assert.equal(record.events.some(e => e.data.name === 'command/finished'), false)
    }
    if (phase === 'persistence') {
      assert.equal(records.get(testId).events.filter(e => e.data.name === 'runtime/manual-close-recorded').length, 1)
      assert.equal(records.get(testId).events.findLast(e => e.data.name === 'outcome/declared').data.payload.outcome, 'ABANDONED')
    }
    return Object.fromEntries(rows.map(row => [row.key, { revision: records.get(row.key).revision, sha256: hash(row.value) }]))
  } finally { db.close() }
}
if (mode === 'check') {
  const current = describe(join(runtime, 'journal.sqlite'))
  const prior = await json(join(target, 'before/manifest.json'))
  for (const [id, entry] of Object.entries(prior.records)) if (id !== testId || phase !== 'interruption') assert.deepEqual(current[id], entry)
  console.log(JSON.stringify({ result: 'fresh-preflight-and-records-match', phase }))
} else {
  const destination = join(target, mode)
  assert.equal(await exists(destination), false, 'backup already exists; do not overwrite')
  await mkdir(destination, { recursive: true })
  let records
  if (mode === 'before') {
    const db = new DatabaseSync(join(runtime, 'journal.sqlite'), { readOnly: true })
    try { await backup(db, join(destination, 'journal.sqlite')) } finally { db.close() }
    records = describe(join(destination, 'journal.sqlite'))
  } else {
    const raw = join(destination, 'raw-journal')
    await mkdir(raw)
    for (const file of ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm']) if (await exists(join(runtime, file))) {
      await copyFile(join(runtime, file), join(raw, file), constants.COPYFILE_EXCL)
    }
    await cp(raw, join(destination, 'verified-journal'), { recursive: true, force: false, errorOnExist: true })
    records = describe(join(destination, 'verified-journal/journal.sqlite'))
  }
  await copyFile(join(runtime, 'writer.lock'), join(destination, 'writer.lock'), constants.COPYFILE_EXCL)
  // Copy, never move or edit original Sessions. Before is a live-file snapshot;
  // after is quiescent, with the exact Host already proved gone.
  await cp('C:/Users/Administrator/.dsh/sessions', join(destination, 'native-sessions'), { recursive: true, force: false, errorOnExist: true })
  const files = [join(root, 'package.json'), join(root, 'cordis.patch.yml'),
    join(root, 'preset/workflow-agent-signal-lab/agent.cordis.yml'), join(root, 'preset/workflow-agent-signal-lab/preset.yml'),
    'C:/Users/Administrator/.dsh/profiles/web/package.json', 'C:/Users/Administrator/.dsh/profiles/web/cordis.yml',
    'C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml',
    'C:/Users/Administrator/.dsh/.agent-presets/workflow-agent-signal-lab/agent.cordis.yml',
    'C:/Users/Administrator/.dsh/.agent-presets/workflow-agent-signal-lab/preset.yml']
  const config = {}
  await mkdir(join(destination, 'config'))
  for (const [index, path] of files.entries()) {
    const bytes = await readFile(path)
    await writeFile(join(destination, 'config', `${index}.txt`), bytes, { flag: 'wx' })
    config[path] = { savedAs: `config/${index}.txt`, sha256: hash(bytes) }
  }
  if (mode === 'before') await cp(join(root, 'lib'), join(destination, 'candidate-build'), { recursive: true, force: false, errorOnExist: true })
  const builds = {}
  for (const name of ['workflow-engine.js', 'workflow-pwsh.js', 'client.js']) builds[name] = hash(await readFile(join(root, 'lib', name)))
  const tested = await json(join(root, '.dsh/verification/workflow-manual-recovery-20260915/compatibility.json'))
  assert.deepEqual(builds, tested.builtArtifacts)
  const result = { backedUpAt: new Date().toISOString(), phase, mode, owner, records, config, candidateBuilds: builds,
    nativeCopy: mode === 'before' ? 'live-file-copy; SQLite uses consistent backup API' : 'quiescent-after-exact-Host-exit' }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ result: 'backup-complete', phase, mode, recordCount: Object.keys(records).length, destination }))
}
