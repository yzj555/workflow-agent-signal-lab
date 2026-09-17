/** Final live read-only backup/replay: all historical workflow rows must stay byte-identical. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'
import { backupJournal } from './lib/journal-backup.mjs'

const root = resolve(import.meta.dirname, '..'), base = join(root, '.dsh/activation/workflow-budget-cleanup-20260917')
const sha = value => createHash('sha256').update(value).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const frozen = await readJson(join(base, 'baseline/journal/records.json'))
const receipt = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, 'final-live-journal'),
  mode: 'online', validate: snapshot => assert.deepEqual(snapshot.records, frozen) })
const db = new DatabaseSync(join(base, 'final-live-journal/journal.sqlite'), { readOnly: true })
const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
db.close()
const table = new Map(rows.map(row => [row.key, parseWorkflowJournalRecord(JSON.parse(row.value))]))
const journal = new WorkflowJournal({ get: key => table.get(key), entries: () => table.entries(), put: async () => { throw new Error('No writes in compatibility verification') } })
const records = rows.map(row => {
  const snapshot = journal.readSnapshot(row.key)
  return { id: row.key, revision: snapshot.revision, outcome: snapshot.run?.outcome ?? null }
})
const unknown = journal.readSnapshot('workflow-command-online-restart-v3-20260915')
assert.equal(unknown.revision, 35)
assert.ok(unknown.run.agents.some(agent => agent.runtimeIssue?.status === 'unknown'))
assert.equal(unknown.run.manualClose, undefined)
const passed = journal.readSnapshot('workflow-production-l1-clean-pass-20260911-1810')
assert.equal(passed.revision, 126); assert.equal(passed.run.outcome, 'PASS')
const ended = journal.readSnapshot('workflow-budget-online-control-20260916')
assert.equal(ended.revision, 10); assert.equal(ended.run.outcome, 'CANCELLED'); assert.equal(ended.run.budget.recovery.closed, true)
await journal.close()
const configHash = sha(await readFile(join(root, 'cordis.patch.yml')))
assert.equal(configHash, sha(await readFile(join(base, 'baseline/cordis.patch.yml'))))
const native = 'C:/Users/Administrator/.dsh/sessions/--F-dsh-workflow-agent-signal-lab--/workflow-budget-online-control-20260916/session.v3.jsonl.zstd'
const nativeHash = sha(await readFile(native))
assert.equal(nativeHash, sha(await readFile(join(root, '.dsh/activation/workflow-budget-online-20260916/native-session.v3.jsonl.zstd'))))
const artifacts = {}
for (const name of ['workflow-engine.js', 'workflow-pwsh.js', 'client.js']) artifacts[name] = sha(await readFile(join(root, 'lib', name)))
const result = { checkedAt: new Date().toISOString(), status: 'passed', unchangedRecords: records.length, records,
  nativeBudgetSessionUnchanged: true, nativeSessionSha256: nativeHash, defaultConfigUnchanged: true, configHash,
  currentWriter: await readJson(join(root, '.dsh/workflow-runtime/writer.lock')), artifacts, backup: receipt.backup, integrity: receipt.integrity }
await writeFile(join(base, 'record-verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: result.status, unchangedRecords: records.length, nativeBudgetSessionUnchanged: true, defaultConfigUnchanged: true, integrity: receipt.integrity }))
