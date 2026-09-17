/** Fixed acceptance baseline, read-only SQLite; never opens a live Journal writer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, '.dsh/verification/workflow-manual-recovery-20260915')
const previous = resolve(root, '.dsh/activation/workflow-command-online-suite-20260915/restart-v3')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const manifest = await json(resolve(previous, 'before-interruption/manifest.json'))
const oldUnknown = await json(resolve(previous, 'repeated-evidence.json'))
const nowUnknown = await json(resolve(output, 'live-unknown-readonly.json'))
const owner = await json(resolve(root, '.dsh/workflow-runtime/writer.lock'))
assert.equal(owner.pid, 21284, 'this receipt is for the unchanged pre-activation Host')
assert.equal(owner.instanceId, '206c27c5-b6b2-42df-ba14-6ead8f1baca5')
assert.deepEqual(nowUnknown.journal, oldUnknown.journal)
// The diagnostic browser deliberately denies non-whitelisted boot POSTs too.
// Keep these denials visible; they are not executed workflow mutations.
assert.deepEqual([...nowUnknown.blockedWrites].sort(), [...oldUnknown.blockedWrites].sort())
assert.equal(nowUnknown.native.running, false)
assert.equal(nowUnknown.native.snapshot.revision, 35)
assert.equal(nowUnknown.native.snapshot.run.outcome, null)
assert.equal(nowUnknown.native.snapshot.run.needsUser, true)

const db = new DatabaseSync(resolve(root, '.dsh/workflow-runtime/journal.sqlite'), { readOnly: true })
let records
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
  assert.deepEqual(rows.map(row => row.key), Object.keys(manifest.journal.records).sort())
  const unchanged = rows.filter(row => row.key !== nowUnknown.sessionId)
  for (const row of unchanged) assert.equal(hash(row.value), manifest.journal.records[row.key].sha256, `changed record: ${row.key}`)
  // New replay rules must still accept ALL existing records, not just the active test.
  const table = new Map(rows.map(row => [row.key, parseWorkflowJournalRecord(JSON.parse(row.value))]))
  const reader = new WorkflowJournal({ get: key => table.get(key), entries: () => table.entries(),
    put: async () => { throw new Error('live writes forbidden in compatibility probe') } })
  records = [...table.keys()].map(id => {
    const snapshot = reader.readSnapshot(id)
    return { id, revision: snapshot.revision, outcome: snapshot.run?.outcome ?? null }
  })
  assert.deepEqual(records.find(item => item.id === 'workflow-production-l1-clean-pass-20260911-1810'), {
    id: 'workflow-production-l1-clean-pass-20260911-1810', revision: 126, outcome: 'PASS',
  })
  assert.equal(reader.readSnapshot(nowUnknown.sessionId).run.manualClose, undefined)
  await reader.close()
} finally { db.close() }
const tap = await readFile(resolve(output, 'tests.tap'), 'utf8')
assert.match(tap, /# tests 220\r?\n/)
assert.match(tap, /# pass 220\r?\n/)
assert.match(tap, /# fail 0\r?\n/)
const builds = {}
for (const name of ['workflow-engine.js', 'workflow-pwsh.js', 'client.js']) builds[name] = hash(await readFile(resolve(root, 'lib', name)))
const report = {
  checkedAt: new Date().toISOString(), result: 'pass', scope: 'offline feature verification and read-only live baseline compatibility',
  tests: { total: 220, passed: 220, failed: 0, tapSha256: hash(tap) },
  host: { pid: owner.pid, instanceId: owner.instanceId, activationPerformed: false },
  recordCount: records.length, unchangedOtherRecordCount: records.length - 1,
  deniedBrowserBootRequests: nowUnknown.blockedWrites,
  unknown: { sessionId: nowUnknown.sessionId, revision: 35, outcome: null, manuallyClosed: false },
  records, builtArtifacts: builds,
  boundary: 'Scripted native gate test, no paid model, no online recovery approval, no server restart. Unknown is not exit proof.',
}
await writeFile(resolve(output, 'compatibility.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(report, null, 2))
