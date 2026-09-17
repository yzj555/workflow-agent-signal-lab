/** Bounded read-only observer. Never answers questions, changes limits or kills PIDs. */
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { root, base, cases, guard, readJson, sha } from './budget-live-matrix-records.mjs'

const [scenario, label] = process.argv.slice(2)
assert.ok(scenario in cases)
assert.match(label, /^[a-z][a-z0-9-]{0,50}$/u)
const target = cases[scenario], output = join(base, `${scenario}-${label}.json`)
assert.equal(await access(output).then(() => true, () => false), false)
await guard()
const frozen = (await readJson(join(base, 'fixture-baseline.json')))[scenario].hashes
const db = new DatabaseSync(join(root, '.dsh/workflow-runtime/journal.sqlite'), { readOnly: true })
const query = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?')
const report = { scenario, sessionId: target.id, startedAt: new Date().toISOString(), observations: [], mode: 'read-only' }
const alive = pid => {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
function read() {
  const row = query.get(target.id)
  if (!row) return null
  const record = JSON.parse(row.value)
  const budget = record.budgets?.accounts?.at(-1)
  const events = record.events.filter(event => event.data.runId === budget?.runId)
  const starts = events.filter(event => event.data.name === 'command/started')
  const ends = events.filter(event => event.data.name === 'command/finished')
  const interruptions = Object.values(Object.fromEntries(events.filter(event => event.data.name === 'agent/runtime-interrupted')
    .map(event => [event.data.payload.assignmentId, event.data.payload])))
  return { revision: record.revision, budget, starts, ends, interruptions,
    outcomes: events.filter(event => event.data.name === 'outcome/declared'),
    artifacts: events.filter(event => event.data.name === 'artifact/recorded') }
}
try {
  const deadline = Date.now() + 360000
  let previous = ''
  while (Date.now() < deadline) {
    const state = read()
    if (state?.budget) {
      assert.ok(state.starts.length <= 1, 'More than one command started in this single-command budget sample')
      if (scenario === 'time' && !report.liveProcess) {
        try {
          const proof = await readJson(join(target.workspace, '.probe/process.json'))
          assert.equal(proof.marker, 'workflow-budget-live-time-20260917')
          assert.equal(resolve(proof.cwd), resolve(target.workspace))
          if (alive(proof.testPid) && alive(proof.childPid)) report.liveProcess = { ...proof, observedAt: new Date().toISOString(), bothAlive: true }
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
      }
      const observation = { revision: state.revision, commandStarts: state.starts.length, commandFinishes: state.ends.length,
        used: state.budget.used, blocked: state.budget.blocked, time: state.budget.time,
        interruptions: state.interruptions.map(item => ({ cause: item.cause, status: item.status })) }
      const key = JSON.stringify(observation)
      if (key !== previous) {
        report.observations.push({ at: new Date().toISOString(), ...observation })
        console.log(JSON.stringify({ scenario, ...observation }))
        previous = key
      }
      if (state.budget.blocked && state.starts.length === 1 && state.ends.length === 1
        && state.interruptions.length && state.interruptions.every(item => item.status === 'stopped')) {
        assert.equal(state.budget.blocked.resource, scenario === 'command' ? 'command' : 'active-time')
        assert.equal(state.budget.used.commands, 1)
        assert.equal(state.outcomes.length, 0, 'No automatic business or cancellation outcome')
        const end = state.ends[0].data.payload
        assert.equal(end.commandId, state.starts[0].data.payload.commandId)
        assert.equal(end.status, scenario === 'command' ? 'completed' : 'interrupted')
        assert.equal(end.exitConfirmed, true); assert.equal(end.toolSettled, true); assert.equal(end.processCount, 1)
        assert.ok(state.interruptions.every(item => item.cause === 'run-budget'))
        if (scenario === 'time') {
          assert.ok(report.liveProcess, 'Never observed the actual command and descendant alive')
          const gone = !alive(report.liveProcess.testPid) && !alive(report.liveProcess.childPid)
          if (!gone) { await new Promise(resolve => setTimeout(resolve, 200)); continue }
          report.pidsGone = { observedAt: new Date().toISOString(), bothGone: true, elapsedSinceStartedMs: Date.now() - report.liveProcess.startedAt }
          assert.ok(report.pidsGone.elapsedSinceStartedMs < report.liveProcess.safetyMs, 'Safety self-exit is not budget cancellation evidence')
          assert.equal(state.starts[0].data.payload.timeoutMs, 120000)
          assert.equal(state.budget.time.observedMs, 120000)
          assert.equal(state.budget.time.reservedMs, 0)
          assert.equal(state.budget.time.uncertainMs, 0)
        }
        report.final = state
        report.processEvents = (await readFile(join(target.workspace, '.probe/commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.deepEqual(report.processEvents.map(item => item.event), scenario === 'command' ? ['started', 'completed'] : ['started'])
        report.status = 'mechanism-observed'
        break
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.equal(report.status, 'mechanism-observed', 'Observation deadline; no passing outcome inferred')
  report.finalHashes = Object.fromEntries(await Promise.all(Object.keys(frozen).map(async file => [file, sha(await readFile(join(target.workspace, file)))])))
  assert.deepEqual(report.finalHashes, frozen, 'Frozen fixture changed')
  report.protectedRecords = (await guard()).protectedRecords
} catch (error) {
  report.status = 'failed-observation'; report.error = String(error); report.final ??= read(); process.exitCode = 1
} finally {
  db.close()
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: report.status, error: report.error, scenario, liveProcess: report.liveProcess,
    pidsGone: report.pidsGone, budget: report.final?.budget, output }))
}
