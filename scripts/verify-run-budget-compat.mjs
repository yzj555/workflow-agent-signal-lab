/** Read-only compatibility audit. Never acquire the live Journal writer. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'

const [evidencePath] = process.argv.slice(2)
assert.ok(evidencePath, 'usage: node scripts/verify-run-budget-compat.mjs <existing baseline parent>')
const directory = resolve(evidencePath)
const expected = JSON.parse(await readFile(resolve(directory, 'baseline/records.json'), 'utf8'))
const oldOwner = JSON.parse(await readFile(resolve(directory, 'baseline/writer.lock'), 'utf8'))
const owner = JSON.parse(await readFile('.dsh/workflow-runtime/writer.lock', 'utf8'))
assert.deepEqual(owner, oldOwner, 'the live Host was not replaced in this offline implementation slice')
const hash = data => createHash('sha256').update(data).digest('hex')
const db = new DatabaseSync('.dsh/workflow-runtime/journal.sqlite', { readOnly: true })
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.key, hash(row.value)])), expected)
  const parsed = new Map(rows.map(row => [row.key, parseWorkflowJournalRecord(JSON.parse(row.value))]))
  const journal = new WorkflowJournal({ get: key => parsed.get(key), entries: () => parsed.entries(),
    put: async () => { throw new Error('live writes forbidden') } })
  const snapshots = rows.map(row => journal.readSnapshot(row.key))
  assert.ok(snapshots.every(snapshot => snapshot.run?.budget === undefined), 'legacy runs must not receive fabricated accounting')
  const pass = snapshots.find(snapshot => snapshot.rootSessionId === 'workflow-production-l1-clean-pass-20260911-1810')
  const unknown = snapshots.find(snapshot => snapshot.rootSessionId === 'workflow-command-online-restart-v3-20260915')
  assert.equal(pass.revision, 126); assert.equal(pass.run.outcome, 'PASS')
  assert.equal(unknown.revision, 35); assert.equal(unknown.run.outcome, null)
  assert.equal(unknown.run.agents.find(agent => agent.assignmentId === 'b0947237-fd51-47b8-ac6e-1e3a6a1facaf')?.runtimeIssue?.status, 'unknown')
  const builds = {}
  for (const file of ['lib/workflow-engine.js', 'lib/workflow-pwsh.js', 'lib/client.js']) builds[file] = hash(await readFile(file))
  const tests = await readFile(resolve(directory, 'regression-final.tap'), 'utf8')
  const count = /^# tests (\d+)$/m.exec(tests)?.[1]
  assert.ok(count && /^# fail 0$/m.test(tests) && /^# cancelled 0$/m.test(tests))
  const report = { checkedAt: new Date().toISOString(), result: 'pass', mode: 'read-only',
    unchangedJournalRows: rows.length, nativeHost: owner,
    offlineTests: Number(count), builds,
    pass: { revision: pass.revision, outcome: pass.run.outcome },
    unknown: { revision: unknown.revision, outcome: unknown.run.outcome, status: 'unknown' },
    onlineRunBudgetActivated: false,
    limitation: 'Actual in-process AgentLoop uses a scripted provider; no real 3080 budget-exhaustion or Host crash test was run.' }
  await writeFile(resolve(directory, 'compatibility.json'), JSON.stringify(report, null, 2) + '\n')
  await journal.close()
  console.log(JSON.stringify(report))
} finally { db.close() }
