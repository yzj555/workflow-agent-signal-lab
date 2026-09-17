/** Read-only compatibility check; never feeds new-protocol data to the live Host. */
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-rollback-recovery-20260917')
const label = process.argv[2] ?? 'compatibility'
assert.match(label, /^[a-z][a-z0-9-]+$/u)
const before = JSON.parse(await readFile(join(base, 'baseline/journal/records.json'), 'utf8'))
const db = new DatabaseSync(join(base, 'baseline/journal/journal.sqlite'), { readOnly: true })
let rows
try { rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all() } finally { db.close() }
assert.deepEqual(Object.fromEntries(rows.map(row => [row.key, createHash('sha256').update(row.value).digest('hex')])), before)
const old = await import(pathToFileURL(join(base, 'baseline/lib/workflow-journal.js')).href)
const candidate = await import(pathToFileURL(join(base, 'candidate/lib/workflow-journal.js')).href)
async function views(module) {
  const values = new Map(rows.map(row => [row.key, module.parseWorkflowJournalRecord(JSON.parse(row.value))]))
  const journal = new module.WorkflowJournal({ get: key => values.get(key), entries: () => values.entries(),
    put: async () => { throw new Error('Compatibility replay is read-only') } })
  try { return rows.map(row => journal.readSnapshot(row.key)) } finally { await journal.close() }
}
assert.deepEqual(await views(candidate), await views(old), 'Historical projections changed')
const sample = JSON.parse(await readFile(join(base, 'cuts-v1/cases/rollback-backed.json'), 'utf8'))
const cut = sample.phases.find(phase => phase.phase === 'durable-after-kill')
assert.ok(cut)
assert.doesNotThrow(() => candidate.parseWorkflowJournalRecord(cut.record))
assert.throws(() => old.parseWorkflowJournalRecord(cut.record), /rollback\/prepared|declared|one of|unknown/i,
  'Old builds must refuse unknown protocol, not silently drop its durable intent')
const inputHashes = {}
for (const entry of await readdir(join(root, 'src'), { withFileTypes: true, recursive: true })) {
  if (entry.isFile()) { const file = join(entry.parentPath, entry.name); inputHashes[file.slice(root.length + 1).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(file)).digest('hex') }
}
const report = { at: new Date().toISOString(), status: 'passed', historicalRecords: rows.length,
  historicalProjectionsEqual: true, oldParserRefusesNewIntent: true, noDataMigration: true,
  downgrade: 'After the first new rollback intent, keep this protocol-capable reader. Never restore old data to permit an older build.', inputHashes }
await writeFile(join(base, label + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: report.status, historicalRecords: report.historicalRecords, oldParserRefusesNewIntent: true }))
