/** Read-only final assertions for the authorized 2026-09-17 two-Session experiment. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { root, base, cases, readJson, records, guard, checkConfig, sha } from './budget-live-matrix-records.mjs'

const report = { checkedAt: new Date().toISOString(), scope: 'read-only final verification; no Host mutation', samples: {} }
const checked = await guard()
assert.equal(checked.currentRecords, 20)
report.config = await checkConfig('baseline')
assert.deepEqual(await readFile(join(root, 'cordis.patch.yml')), await readFile(join(base, 'baseline/cordis.patch.yml')))
const hashes = Object.fromEntries((await records()).map(row => [row.key, sha(row.value)]))
for (const label of ['restore-before', 'restore-after', 'final-journal']) {
  assert.deepEqual(hashes, await readJson(join(base, label, 'records.json')), `${label} differs from restored Journal`)
}
report.protectedHistoricalRows = checked.protectedRecords
report.allTwentyRowsUnchangedAcrossRestore = true
report.restartReceipts = []
for (const phase of ['command', 'time', 'restore']) {
  const stop = await readJson(join(base, `restart-${phase}/stop.json`))
  const start = await readJson(join(base, `restart-${phase}/start.json`))
  assert.equal(stop.status, 'stopped-and-backed-up')
  assert.equal(start.status, 'ready')
  assert.equal(start.oldPid, stop.oldPid)
  report.restartReceipts.push({ phase, oldPid: stop.oldPid, newPid: start.newPid, readyAt: start.finishedAt })
}
report.writer = await readJson(join(root, '.dsh/workflow-runtime/writer.lock'))
assert.deepEqual(report.writer, (await readJson(join(base, 'restart-restore/start.json'))).newOwner)
const frozen = await readJson(join(base, 'fixture-baseline.json'))
for (const [scenario, target] of Object.entries(cases)) {
  const observation = await readJson(join(base, `${scenario}-${scenario === 'time' ? 'observed-after-revision' : 'observed-exhaustion'}.json`))
  assert.equal(observation.status, 'mechanism-observed')
  const ended = await readJson(join(base, `${scenario}-ended-native.json`))
  const restored = await readJson(join(base, `${scenario}-restored-ui.json`))
  assert.equal(ended.status, 'complete'); assert.equal(restored.status, 'complete')
  assert.equal(restored.after.session.running, false)
  assert.deepEqual(restored.record, ended.record)
  const run = restored.after.snapshot.run
  assert.equal(run.outcome, 'CANCELLED'); assert.equal(run.budget.recovery.closed, true)
  assert.equal(run.budget.recovery.resumes, 0)
  assert.equal(run.budget.recovery.controlUsed, 0)
  assert.deepEqual(run.budget.used, observation.final.budget.used)
  assert.equal(run.ledger.pass, 0); assert.equal(run.ledger.fail, 0)
  assert.equal(run.agents.filter(agent => agent.runtimeIssue?.status === 'stopped').length, 1)
  assert.ok(run.agents.every(agent => agent.status === 'idle' || agent.runtimeIssue?.status === 'stopped'))
  assert.equal(restored.record.events.filter(event => event.data.name === 'command/started').length, 1)
  const outcomeEvents = restored.record.events.filter(event => event.data.name === 'outcome/declared')
  const approved = run.budget.recovery.requests.filter(request => request.status === 'approved')
  assert.equal(outcomeEvents.length, 1); assert.equal(approved.length, 1)
  assert.equal(approved[0].action, 'end')
  assert.equal(outcomeEvents[0].time, approved[0].settledAt)
  assert.equal(approved[0].decisionAudit.channel, 'native-question')
  for (const [file, hash] of Object.entries(frozen[scenario].hashes)) {
    assert.equal(sha(await readFile(join(target.workspace, file))), hash, `Frozen fixture changed: ${scenario}/${file}`)
  }
  const artifacts = restored.record.events.filter(event => event.data.name === 'record/published'
    && event.data.payload.record.kind === 'artifact').map(event => event.data.payload.record.data)
  assert.equal(artifacts.length, 1)
  assert.equal(resolve(artifacts[0].locator), resolve(target.workspace, 'src/add.cjs'))
  assert.equal(sha(await readFile(artifacts[0].locator)), artifacts[0].digest)
  assert.equal(restored.errors.length, 0); assert.equal(restored.mutations.length, 0)
  assert.match(restored.workflowBody, /本轮已结束，无需操作/u)
  assert.match(restored.workflowBody, /已停止 · 需处理/u) // Known OPEN display inconsistency, not a passing UX claim.
  report.samples[scenario] = { rootSessionId: target.id, runId: run.runId, revision: restored.after.snapshot.revision,
    used: run.budget.used, time: run.budget.time, ledger: run.ledger, outcome: run.outcome,
    evidenceRetained: true, frozenFixturesUnchanged: true, artifact: artifacts[0],
    model: restored.after.session.projections.values.modelSelection.lastUsed,
    knownDisplayIssue: 'ended run retains an actionable stopped-role label' }
}
const idle = await readJson(join(base, 'idle-final.json'))
for (const key of ['running', 'active', 'failures', 'residentDiagnostics', 'unclassifiedResident']) assert.equal(idle[key].length, 0)
assert.ok(Object.values(idle.resident.queues).every(value => value === 0))
assert.ok(Object.values(idle.resident.jobs).every(value => value.length === 0))
report.idle = { checkedAt: idle.checkedAt, sessionCount: idle.sessionCount, historicalDiagnostics: idle.diagnostics.length }
report.compatibility = {}
for (const [label, revision] of [['protected-pass', 126], ['protected-unknown', 35]]) {
  const ui = await readJson(join(base, label, 'report.json'))
  assert.equal(ui.rpc.revision, revision)
  assert.equal(ui.errors.length, 0); assert.equal(ui.forbiddenRequests.length, 0)
  assert.equal(ui.nativeInputCount, 1); assert.equal(ui.workflowInputCount, 0)
  report.compatibility[label] = { revision, outcome: ui.rpc.run.outcome, agentStatuses: ui.agentStatuses }
}
const regressionBase = join(root, '.dsh/activation/workflow-budget-process-matrix-20260917/post-live-regression')
const regression = await readJson(join(regressionBase, 'result.json'))
assert.equal(regression.exitCode, 0)
const tests = await readFile(join(regressionBase, 'tests.log'), 'utf8')
assert.match(tests, /pass 321\b/u); assert.match(tests, /fail 0\b/u); assert.match(tests, /skipped 0\b/u)
report.regression = { directory: regressionBase, checks: regression.checks, pass: 321, fail: 0, skipped: 0 }
report.core = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: 'F:/dsh/deepseek-harness', encoding: 'utf8', windowsHide: true }).trim(),
  status: execFileSync('git', ['status', '--porcelain'], { cwd: 'F:/dsh/deepseek-harness', encoding: 'utf8', windowsHide: true }).trim() }
assert.equal(report.core.commit, '183f08e9c6dde7e36cd2318eaee70b0da08fb35e')
assert.equal(report.core.status, '')
await guard()
report.status = 'mechanisms-and-restoration-verified-with-open-ui-finding'
await writeFile(join(base, 'final-verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: report.status, config: report.config, writer: report.writer, protectedHistoricalRows: report.protectedHistoricalRows,
  allTwentyRowsUnchangedAcrossRestore: true, idle: report.idle, output: join(base, 'final-verification.json') }, null, 2))
