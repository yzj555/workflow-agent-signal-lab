/** Observe only named online fixtures; optionally interrupt one exact native test child.
 * PID probes use signal 0 only. This helper never terminates an OS process or a Host.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readNativeControlBaseline, classifyInterruptionSafety } from './native-control-baseline.mjs'

const [sourceRoot, launchLog, journalFile, sessionId, fixtureRoot, mode, reportFile] = process.argv.slice(2)
assert.ok([sourceRoot, launchLog, journalFile, sessionId, fixtureRoot, mode, reportFile].every(Boolean))
const restartCase = { 'workflow-command-online-restart-20260915': 'restart',
  'workflow-command-online-restart-v2-20260915': 'restart-v2',
  'workflow-command-online-restart-v3-20260915': 'restart-v3',
  'workflow-command-online-manual-recovery-20260915': 'manual-recovery' }[sessionId]
const scenario = { observe: 'timeout', cancel: 'cancel', live: restartCase }[mode]
assert.ok(scenario, 'mode must be observe, cancel or live')
assert.equal(sessionId, `workflow-command-online-${scenario}-20260915`)
const fixture = resolve(fixtureRoot), marker = `workflow-command-${scenario}-fixture-20260915`
assert.equal(fixture, resolve('F:/dsh', marker))
assert.equal(resolve(journalFile), resolve('F:/dsh/workflow-agent-signal-lab/.dsh/workflow-runtime/journal.sqlite'))
const db = new DatabaseSync(resolve(journalFile), { readOnly: true })
const hashes = async () => Object.fromEntries(await Promise.all(['README.md', 'tests/hang.test.cjs'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(fixture, name))).digest('hex')])))
const report = { startedAt: new Date().toISOString(), sessionId, fixture, mode, baselineHashes: await hashes() }
let browser
const pidAlive = pid => {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
const state = () => {
  const row = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?').get(sessionId)
  const record = row ? JSON.parse(row.value) : null
  if (record) assert.equal(record.rootSessionId, sessionId)
  const events = record?.events ?? []
  const starts = events.filter(event => event.data.name === 'command/started')
  assert.ok(starts.length <= 1, 'fixture command was replayed; do not act on a replacement')
  const start = starts[0]
  const end = start && events.find(event => event.data.name === 'command/finished'
    && event.data.payload.commandId === start.data.payload.commandId)
  const assignment = start && events.find(event => event.data.name === 'agent/assigned'
    && event.data.payload.assignmentId === start.data.payload.assignmentId)
  return { revision: record?.revision ?? 0, start, end, assignment }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 100))
try {
  let initial, proof
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    initial = state()
    if (initial.start) {
      try { proof = JSON.parse(await readFile(join(fixture, '.probe/process.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (proof) break
    }
    await pause()
  }
  assert.ok(initial?.start && proof, 'no real test process was observed before the deadline')
  assert.equal(initial.end, undefined, 'test already ended before observation; do not count as a live sample')
  assert.equal(initial.start.data.payload.checkId, 'ENG-1')
  assert.equal(initial.assignment?.data.payload.role, 'test_engineer')
  assert.equal(proof.marker, marker)
  assert.equal(resolve(proof.cwd), fixture)
  assert.ok(Date.now() - proof.startedAt >= 0 && Date.now() - proof.startedAt < (mode === 'live' ? 45000 : 10000))
  assert.equal(pidAlive(proof.testPid), true)
  assert.equal(pidAlive(proof.childPid), true)
  report.liveObservedAt = new Date().toISOString()
  report.proof = proof
  report.commandStart = initial.start
  report.assignment = initial.assignment
  report.bothPidsInitiallyAlive = true

  if (mode !== 'observe') {
    const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
    assert.ok(matches.length)
    assert.equal(new URL(matches.at(-1)[1]).origin, 'http://127.0.0.1:3080')
    const { chromium } = await import(pathToFileURL(join(resolve(sourceRoot),
      'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const permitted = new Set(['/api/session/list', '/api/subagents/list', '/workflow-runtime/snapshot'])
    if (mode === 'cancel') permitted.add('/api/subagents/interruptByParent')
    await page.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method())
      || permitted.has(new URL(route.request().url()).pathname) ? route.continue() : route.abort('blockedbyclient'))
    assert.equal((await page.goto(matches.at(-1)[1], { waitUntil: 'domcontentloaded', timeout: 30000 })).status(), 200)
    report.native = await page.evaluate(async ({ sessionId, childId, mode, fixture }) => {
      const rpc = async (path, method, payload) => {
        const rpcId = crypto.randomUUID()
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
        const envelope = await response.json()
        if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error(`${method}: rejected`)
        return envelope.result.value
      }
      const snapshot = await rpc('/workflow-runtime/snapshot', 'snapshot', { schemaVersion: 1, rootSessionId: sessionId })
      if (snapshot.run?.plan?.workspaceRoot !== fixture || snapshot.run?.outcome
        || !snapshot.run.gates.some(gate => gate.kind === 'execution' && gate.status === 'approved' && !gate.stale)
        || !snapshot.run.agents.some(agent => agent.agentSessionId === childId && agent.role === 'test_engineer')) {
        throw new Error('native workflow does not match the approved test child')
      }
      const catalog = await rpc('/api/subagents/list', 'subagents/list', { args: { parentSessionId: sessionId } })
      if (!catalog.entries.some(entry => entry.id === childId && entry.activity === 'running')) throw new Error('exact child not running')
      if (mode === 'cancel') {
        const receipt = await rpc('/api/subagents/interruptByParent', 'subagents/interruptByParent',
          { args: { childSessionId: childId, parentSessionId: sessionId, mode: 'continuable' } })
        return { action: 'native-child-interrupt', childId, receipt, actionAt: new Date().toISOString() }
      }
      const sessions = await rpc('/api/session/list', 'session/list', { args: { _request: {} } })
      const otherActiveChildren = [], catalogDiagnostics = [], knownChildren = []
      const queue = sessions.items.map(item => ({ sessionId: item.sessionId, rootSessionId: item.sessionId }))
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (queue.length) {
          const item = queue.shift()
          if (item.rootSessionId === sessionId) continue
          const children = await rpc('/api/subagents/list', 'subagents/list', { args: { parentSessionId: item.sessionId } })
          for (const entry of children.entries) {
            if (entry.kind === 'child') knownChildren.push(entry.id)
            if (entry.kind === 'diagnostic') catalogDiagnostics.push({ parent: item.sessionId, entry })
            if (entry.activity === 'running') otherActiveChildren.push({ parent: item.sessionId, child: entry.id })
            if (entry.hasChildren) queue.push({ sessionId: entry.id, rootSessionId: item.rootSessionId })
          }
        }
      }))
      const latest = await rpc('/api/session/list', 'session/list', { args: { _request: {} } })
      const testIds = new Set([sessionId, ...catalog.entries.filter(item => item.kind === 'child').map(item => item.id)])
      const otherRunning = latest.items.filter(item => !testIds.has(item.sessionId) && item.running).map(item => item.sessionId)
      return { action: 'read-only-restart-preflight', childId, otherRunning, otherActiveChildren,
        catalogDiagnostics, knownChildren, rootIds: latest.items.map(item => item.sessionId),
        sessionCount: latest.items.length, testChildren: catalog.entries, checkedAt: new Date().toISOString() }
    }, { sessionId, childId: initial.assignment.data.payload.agentSessionId, mode, fixture })
    if (mode === 'live') {
      const resident = await page.evaluate(readNativeControlBaseline)
      report.native.resident = resident
      Object.assign(report.native, classifyInterruptionSafety(report.native, sessionId))
    }
  }
  if (mode === 'live') {
    assert.equal(report.native.otherRunning.length + report.native.otherActiveChildren.length
      + report.native.residentDiagnostics.length + report.native.unclassifiedResident.length
      + report.native.otherQueues.length + report.native.otherJobs.length,
    0, 'another task is active or its live status is unverifiable; Host interruption forbidden')
    assert.equal(state().end, undefined, 'test command settled during preflight')
    assert.equal(pidAlive(proof.testPid), true)
    assert.equal(pidAlive(proof.childPid), true)
    report.status = 'ready-for-authorized-interruption'
  } else {
    const endDeadline = Date.now() + 45000
    while (Date.now() < endDeadline) {
      const current = state()
      if (current.end && !pidAlive(proof.testPid) && !pidAlive(proof.childPid)) {
        report.commandEnd = current.end
        report.pidsGoneObservedAt = new Date().toISOString()
        report.processLifetimeObservedMs = Date.now() - proof.startedAt
        report.goneBeforeSafetyTimeout = report.processLifetimeObservedMs < proof.safetyMs
        report.status = 'observed-command-settlement-and-pids-gone'
        break
      }
      await pause()
    }
    assert.ok(report.commandEnd, 'no confirmed command settlement and disappearance in observation window')
    assert.equal(report.goneBeforeSafetyTimeout, true, 'self-exit cannot count as supervised termination')
  }
  report.finalHashes = await hashes()
  assert.deepEqual(report.finalHashes, report.baselineHashes, 'frozen test files changed')
} catch (error) {
  report.status = 'failed-observation'
  report.error = String(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  db.close()
  await browser?.close()
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
