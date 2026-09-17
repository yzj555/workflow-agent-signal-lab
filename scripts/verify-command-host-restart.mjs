/** Read-only post-restart assertions; writes only an independent evidence receipt. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
const root = 'F:/dsh/workflow-agent-signal-lab'
const evidence = `${root}/.dsh/activation/workflow-command-online-suite-20260915`
const sample = `${evidence}/restart-v3`
const id = 'workflow-command-online-restart-v3-20260915'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const hash = data => createHash('sha256').update(data).digest('hex')
const manifest = await json(`${sample}/before-interruption/manifest.json`)
const receipt = await json(`${sample}/interruption.json`)
assert.equal(receipt.serviceRestored, true)
assert.equal(receipt.oldPid, 49572)
assert.notEqual(receipt.newPid, receipt.oldPid)
const owner = await json(`${root}/.dsh/workflow-runtime/writer.lock`)
assert.equal(owner.pid, receipt.newPid)
assert.equal(owner.instanceId, receipt.newOwner.instanceId)
const oldDb = new DatabaseSync(`${sample}/before-interruption/journal.sqlite`, { readOnly: true })
const liveDb = new DatabaseSync(`${root}/.dsh/workflow-runtime/journal.sqlite`, { readOnly: true })
let facts
try {
  assert.equal(liveDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  const rows = liveDb.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
  assert.deepEqual(rows.map(row => row.key), Object.keys(manifest.journal.records).sort())
  for (const row of rows) if (row.key !== id) {
    assert.equal(hash(row.value), manifest.journal.records[row.key].sha256, `other record changed: ${row.key}`)
  }
  const before = JSON.parse(oldDb.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key=?').get(id).value)
  const after = JSON.parse(rows.find(row => row.key === id).value)
  assert.deepEqual(after.events.slice(0, before.events.length), before.events, 'pre-crash prefix changed')
  const added = after.events.slice(before.events.length)
  assert.equal(after.revision, before.revision + 2)
  assert.deepEqual(added.map(event => event.data.name), ['command/finished', 'agent/runtime-interrupted'])
  const finish = added[0].data.payload, issue = added[1].data.payload
  assert.equal(finish.commandId, manifest.journal.commandId)
  assert.equal(finish.status, 'unknown')
  assert.equal(finish.exitConfirmed, false)
  assert.equal(finish.toolSettled, false)
  assert.equal(finish.exitCode, null)
  assert.equal(finish.elapsedMs, 0)
  assert.equal(finish.processCount, 0)
  assert.equal(issue.cause, 'host-restart')
  assert.equal(issue.status, 'unknown')
  assert.equal(after.events.filter(event => event.data.name === 'command/started').length, 1)
  facts = { beforeRevision: before.revision, afterRevision: after.revision,
    immutableOtherRecordCount: rows.length - 1, command: finish, incident: issue }
} finally { oldDb.close(); liveDb.close() }

const native = await json(`${sample}/after-restart-evidence.json`)
const repeated = await json(`${sample}/repeated-evidence.json`)
for (const current of [native, repeated]) {
  assert.equal(current.native.running, false)
  assert.equal(current.native.snapshot.revision, facts.afterRevision)
  assert.equal(current.journal.revision, facts.afterRevision)
  assert.equal(current.native.snapshot.run.outcome, null)
  assert.equal(current.native.snapshot.run.needsUser, true)
  assert.equal(current.native.children.some(child => child.activity === 'running'), false)
  assert.equal(current.native.snapshot.run.agents.some(agent => agent.runtimeIssue?.status === 'unknown'), true)
  assert.equal(current.native.snapshot.run.ledger.pass, 0)
  assert.equal(current.native.snapshot.run.ledger.fail, 0)
}
assert.deepEqual(repeated.journal, native.journal, 'repeated read changed events')
const fixture = 'F:/dsh/workflow-command-restart-v3-fixture-20260915'
const observation = await json(`${sample}/process-observation.json`)
for (const [file, digest] of Object.entries(observation.baselineHashes)) {
  assert.equal(hash(await readFile(`${fixture}/${file}`)), digest, `frozen fixture changed: ${file}`)
}
for (const [file, digest] of Object.entries(manifest.configHashes)) {
  assert.equal(hash(await readFile(`${root}/${file}`)), digest, `config changed: ${file}`)
}
const expectedBundles = {
  'workflow-engine.js': 'd8b424c0c573b69756b02b34398830b3afe522da5f0dbcfA7e3f554bca3ec0f6'.toLowerCase(),
  'workflow-pwsh.js': '2f4e4e4854149c8de81f18bf971c255736bfc8d7801763aa28e86840a0cf64f8',
  'client.js': '95ddd18b7eb6b276c3fcc6f1db4af86d5790f4552f64bb1bf69f0d3599f801d2',
}
for (const [file, digest] of Object.entries(expectedBundles)) assert.equal(hash(await readFile(`${root}/lib/${file}`)), digest)
const pids = [observation.proof.testPid, observation.proof.parentPid, observation.proof.childPid].map(pid => {
  let alive
  try { process.kill(pid, 0); alive = true } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false }
  return { pid, alive }
})
assert.equal(pids.some(item => item.alive), false)
const report = { checkedAt: new Date().toISOString(), result: 'pass', scope: 'authorized actual Host-loss sample',
  hostPid: owner.pid, hostInstance: owner.instanceId, ...facts, pids,
  repeatReadIntervalMs: Date.parse(repeated.checkedAt) - Date.parse(native.checkedAt),
  outageObservedMs: Date.parse(receipt.serviceRestoredAt) - Date.parse(receipt.stopRequestedAt),
  pidObservationBoundary: 'observed after restart; not a valid old managed-scope exit receipt and not used to clear unknown',
  frozenFixturesAndConfigsUnchanged: true, runtimeBundlesUnchanged: true }
await writeFile(`${sample}/verified.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(report, null, 2))
