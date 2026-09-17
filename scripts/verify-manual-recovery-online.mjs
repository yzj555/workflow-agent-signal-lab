/** Read-only live acceptance. Outputs are immutable; no live Journal writer. */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../lib/workflow-journal.js'

const [phase, launchLog] = process.argv.slice(2)
assert.ok(['unknown', 'verified-stopped', 'kept', 'closed', 'persisted', 'new-request', 'finished'].includes(phase))
assert.ok(launchLog)
const root = resolve('F:/dsh/workflow-agent-signal-lab')
const base = join(root, '.dsh/activation/workflow-manual-recovery-20260915')
const fixture = resolve('F:/dsh/workflow-command-manual-recovery-fixture-20260915')
const id = 'workflow-command-online-manual-recovery-20260915'
const runId = '807e066e-eeb3-47df-9b20-902f61012fb4'
const out = join(base, 'checks')
await mkdir(out, { recursive: true })
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const nativePath = join(out, `${phase}-native.json`)
// The called helper only uses read RPCs and signal-0 probes; boot writes denied.
execFileSync(process.execPath, [join(root, 'scripts/read-command-online-evidence.mjs'),
  'F:/dsh/deepseek-harness', resolve(launchLog), join(root, '.dsh/workflow-runtime/journal.sqlite'),
  id, nativePath, fixture], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
const native = await json(nativePath)
const baseline = await json(join(base, 'activation/before/manifest.json'))
const db = new DatabaseSync(join(root, '.dsh/workflow-runtime/journal.sqlite'), { readOnly: true })
let rows
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
} finally { db.close() }
const rowsById = new Map(rows.map(row => [row.key, row]))
for (const [otherId, old] of Object.entries(baseline.records)) {
  assert.equal(hash(rowsById.get(otherId).value), old.sha256, `protected existing record changed: ${otherId}`)
}
assert.equal(rows.length, Object.keys(baseline.records).length + 1)
const table = new Map(rows.map(row => [row.key, parseWorkflowJournalRecord(JSON.parse(row.value))]))
const reader = new WorkflowJournal({ get: key => table.get(key), entries: () => table.entries(),
  put: async () => { throw new Error('live writes forbidden') } })
const snapshots = [...table.keys()].map(key => reader.readSnapshot(key))
const snapshot = reader.readSnapshot(id), state = reader.readRunState(id, runId)
const record = table.get(id)
assert.deepEqual(snapshot, native.native.snapshot, 'read crossed a state change; capture a fresh epoch')
const starts = record.events.filter(event => event.data.name === 'command/started')
assert.equal(starts.length, 1, 'test command must never be replayed')
assert.equal(Object.keys(state.commands).length, 1)
const command = Object.values(state.commands)[0]
assert.equal(command.status, 'unknown')
assert.equal(command.observation.exitConfirmed, false)
assert.equal(command.observation.toolSettled, false)
assert.equal(command.observation.exitCode, null)
assert.ok(Object.values(state.assignments).some(agent => agent.runtimeIssue?.status === 'unknown'))
assert.equal(Object.values(state.assignments).some(agent => agent.role === 'acceptance_qa'), false)
assert.equal(Object.keys(state.acceptance).length, 0)
const frozen = await json(join(base, 'fixture/initial-state.json'))
assert.deepEqual(native.fixtureHashes, frozen.fixtureHashes)
const proof = await json(join(fixture, '.probe/process.json'))
assert.equal(proof.marker, 'workflow-command-manual-recovery-fixture-20260915')
assert.equal(resolve(proof.cwd), fixture)
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code !== 'ESRCH') throw error; return false } }
const processObservation = { observedAt: new Date().toISOString(), proof,
  testAlive: alive(proof.testPid), childAlive: alive(proof.childPid), parentAlive: alive(proof.parentPid),
  oldHostAlive: alive(4940) }
if (phase !== 'unknown') {
  for (const key of ['testAlive', 'childAlive', 'parentAlive', 'oldHostAlive']) assert.equal(processObservation[key], false, key)
  assert.equal(native.native.children.some(child => child.activity === 'running'), false)
}
const contents = {}
async function scan(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'unexpected fixture link')
    const relative = prefix + entry.name
    if (entry.isDirectory()) await scan(join(directory, entry.name), relative + '/')
    else if (entry.isFile()) contents[relative] = hash(await readFile(join(directory, entry.name)))
  }
}
await scan(fixture)
assert.deepEqual(Object.keys(contents).sort(), ['.probe/process.json', 'README.md', 'src/add.cjs', 'tests/hang.test.cjs'].sort())
const immutable = Object.fromEntries(['commands', 'assignments', 'tasks', 'acceptance', 'records', 'returns'].map(key => [key, state[key]]))
if (!['unknown', 'verified-stopped'].includes(phase)) {
  const unknown = await json(join(out, 'unknown.json'))
  assert.deepEqual(immutable, unknown.immutable)
  assert.deepEqual(record.events.slice(0, unknown.events.length), unknown.events)
  assert.deepEqual(contents, unknown.contents)
}
if (['closed', 'persisted', 'new-request', 'finished'].includes(phase)) {
  assert.equal(state.outcome.outcome, 'ABANDONED')
  assert.equal(Object.keys(state.manualCloseRequests).length, 2)
  assert.equal(record.events.filter(event => event.data.name === 'runtime/manual-close-recorded').length, 1)
  assert.deepEqual(state.manualClose.decisionAudit, { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: state.manualClose.gateId })
  if (phase === 'persisted') {
    const closed = await json(join(out, 'closed.json'))
    assert.equal(record.revision, closed.revision)
    assert.deepEqual(record.events, closed.events)
  }
  if (['new-request', 'finished'].includes(phase)) {
    assert.notEqual(snapshot.run.runId, runId, 'new target requires a different run')
    assert.equal(snapshot.run.agents.length, 0, 'new run must not dispatch without a new approval')
    assert.ok(snapshot.run.gates.length > 0)
    assert.equal(snapshot.run.gates.some(gate => gate.status === 'approved'), false)
    assert.equal(snapshot.run.gates.some(gate => gate.gateId === state.manualClose.gateId), false)
    if (phase === 'new-request') {
      assert.equal(snapshot.run.outcome, null)
      assert.ok(snapshot.run.gates.some(gate => gate.status === 'waiting'))
      assert.equal(snapshot.run.needsUser, true)
    } else {
      assert.equal(snapshot.run.outcome, 'CANCELLED')
      assert.equal(native.native.running, false)
    }
  }
} else {
  assert.equal(state.outcome, undefined)
  assert.equal(state.manualClose, undefined)
  if (phase === 'kept') assert.equal(Object.values(state.gates).filter(gate => gate.kind === 'runtime-recovery' && gate.status === 'rejected').length, 1)
}
const result = { checkedAt: new Date().toISOString(), result: 'pass', phase, sessionId: id, runId,
  revision: record.revision, protectedRecordCount: Object.keys(baseline.records).length,
  currentRun: { runId: snapshot.run.runId, outcome: snapshot.run.outcome, gates: snapshot.run.gates,
    agents: snapshot.run.agents, needsUser: snapshot.run.needsUser },
  owner: await json(join(root, '.dsh/workflow-runtime/writer.lock')), processObservation,
  command, immutable, contents, manualClose: state.manualClose ?? null, outcome: state.outcome ?? null,
  events: record.events, snapshots: snapshots.map(s => ({ sessionId: s.rootSessionId, revision: s.revision, outcome: s.run?.outcome ?? null })),
  limitation: 'External fixture inspection is not a replacement for lost Host exit evidence; scripted gate operator remains unverified.' }
await reader.close()
await writeFile(join(out, `${phase}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ result: result.result, phase, revision: record.revision,
  currentRun: { runId: result.currentRun.runId, outcome: result.currentRun.outcome },
  protectedRecordsUnchanged: result.protectedRecordCount, commandStatus: command.status,
  exitConfirmed: command.observation.exitConfirmed, manualClose: Boolean(state.manualClose),
  outcome: state.outcome ?? null, processObservation, report: join(out, `${phase}.json`) }, null, 2))
