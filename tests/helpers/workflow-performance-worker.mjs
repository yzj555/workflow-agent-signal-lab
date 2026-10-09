/** Isolated native-storage reference or funded Journal soak; no Agent/model/network. */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../../lib/workflow-journal.js'
import { openWorkflowStorage, workflowReadHandler } from '../../lib/workflow-runtime.js'
import { WorkflowRunTime, resolveRunBudgetLimits } from '../../lib/workflow-control.js'
import { fixture, memoryTable } from './workflow-fixture.mjs'
import { padHistory } from './workflow-capacity-fixture.mjs'

const [input, token] = process.argv.slice(2), directory = await realpath(input)
assert.match(relative(await realpath(tmpdir()), directory), /^workflow-benchmark-[^\\/]+$/u)
const config = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'))
assert.equal(config.token, token)
const parentDisconnected = () => process.exit(97)
process.on('disconnect', parentDisconnected)
const fuse = setTimeout(() => process.exit(98), config.durationMs + 150000)
const send = data => new Promise((resolve, reject) => process.send(data, error => error ? reject(error) : resolve()))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return { count: 0, p50: null, p95: null, max: null }
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1) }
}
const limits = resolveRunBudgetLimits({ runTimeBudgetEnabled: true })
const fixtures = [], records = []
for (let i = 0; i < config.roots; i++) {
  const f = fixture('benchmark-root-' + i, 'benchmark-run-' + i), table = memoryTable(), journal = new WorkflowJournal(table)
  await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0,
    events: [...f.initial(), f.approve(), f.readyTask(), f.runTask(), f.assign()], runBudgetLimits: limits })
  padHistory(table, f.rootSessionId, config.events)
  let record = table.get(f.rootSessionId)
  if (config.historyBytes) {
    const mutable = structuredClone(record), bytes = Buffer.byteLength(JSON.stringify(record))
    assert.ok(config.historyBytes >= bytes, 'requested byte load is smaller than the event fixture')
    mutable.events[0].data.payload.reason += 'x'.repeat(config.historyBytes - bytes)
    record = parseWorkflowJournalRecord(mutable)
  }
  fixtures.push(f); records.push(record); await journal.close()
}
let runtime, ctx, clock, coldMs, read, write
const handles = [], stops = [], faults = [], counts = new Map(fixtures.map(f => [f.rootSessionId, { model: 0, command: 0 }]))
if (config.mode === 'workflow') {
  const data = join(directory, 'workflow')
  const created = await openWorkflowStorage(data); await created.close()
  const db = new DatabaseSync(join(data, 'journal.sqlite'))
  try { for (const record of records) db.prepare('INSERT INTO u_workflow_runtime_sessions (key,value) VALUES (?,?)').run(record.rootSessionId, JSON.stringify(record)) } finally { db.close() }
  const at = performance.now(); runtime = await openWorkflowStorage(data); coldMs = performance.now() - at
  clock = new WorkflowRunTime(runtime.journal, (root, run, error) => stops.push({ root, run, error: error.name }), error => faults.push(error.name))
  const rpc = workflowReadHandler(runtime.journal)
  read = async f => { const result = await rpc('snapshot', { schemaVersion: 1, rootSessionId: f.rootSessionId }, new AbortController().signal); assert.equal(result.ok, true); return result.value }
  write = (f, resource) => runtime.journal.consumeRunBudget(f.rootSessionId, f.runId, resource)
} else {
  const store = join(directory, 'native')
  ctx = new Context(); await ctx.plugin(Persistence, { root: store })
  for (const [i, f] of fixtures.entries()) {
    const handle = await ctx.sessionPersistence.create({ version: 3, id: SessionId(f.rootSessionId), createdAt: 1, isSeeded: false, delegationDepth: 0 })
    const events = records[i].events.map((event, seq) => ({ type: 'feedback/record', seq, time: seq + 1, data: { text: JSON.stringify(event.data) } }))
    for (let offset = 0; offset < events.length; offset += 128) await handle.append(events.slice(offset, offset + 128))
    await handle.close()
  }
  await ctx.fiber.dispose()
  const at = performance.now(); ctx = new Context(); await ctx.plugin(Persistence, { root: store })
  for (const f of fixtures) handles.push(await ctx.sessionPersistence.open(SessionId(f.rootSessionId), 'write'))
  coldMs = performance.now() - at
  const offsets = new Map(fixtures.map(f => [f.rootSessionId, config.events]))
  read = f => handles[fixtures.indexOf(f)].read(0)
  write = async (f, resource) => {
    const seq = offsets.get(f.rootSessionId)
    await handles[fixtures.indexOf(f)].append([{ type: 'feedback/record', seq, time: seq + 1, data: { text: JSON.stringify({ resource, attempt: counts.get(f.rootSessionId) }) } }])
    offsets.set(f.rootSessionId, seq + 1)
  }
}
const reads = [], writes = [], heartbeat = monitorEventLoopDelay({ resolution: 20 }), memory = []
let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed
const cpuStart = process.cpuUsage(), started = performance.now()
heartbeat.enable()
try {
  if (clock) for (const f of fixtures) {
    await clock.enter(f.rootSessionId, f.runId, 'root')
    await clock.enter(f.rootSessionId, f.runId, 'fixture-child-a')
    await clock.enter(f.rootSessionId, f.runId, 'fixture-child-b')
  }
  let nextRead = 0, nextModel = 0, nextCommand = 0, nextProgress = 30000, nextMemory = 0
  while (performance.now() - started < config.durationMs) {
    const elapsed = performance.now() - started
    if (elapsed >= nextRead) {
      for (let tab = 0; tab < 2; tab++) for (const f of fixtures) { const at = performance.now(); await read(f); reads.push(performance.now() - at) }
      nextRead = elapsed + 1000
    }
    if (elapsed >= nextModel || elapsed >= nextCommand) {
      const resources = [...(elapsed >= nextModel ? ['root-model'] : []), ...(elapsed >= nextCommand ? ['command'] : [])]
      for (const resource of resources) for (const f of fixtures) {
        if (stops.some(item => item.root === f.rootSessionId)) continue
        const at = performance.now(); await write(f, resource); writes.push(performance.now() - at)
        counts.get(f.rootSessionId)[resource === 'command' ? 'command' : 'model']++
      }
      if (elapsed >= nextModel) nextModel = elapsed + 10000
      if (elapsed >= nextCommand) nextCommand = elapsed + 60000
    }
    if (elapsed >= nextMemory) {
      const value = process.memoryUsage(); peakRss = Math.max(peakRss, value.rss); peakHeap = Math.max(peakHeap, value.heapUsed)
      memory.push({ elapsedMs: elapsed, rss: value.rss, heapUsed: value.heapUsed, external: value.external }); nextMemory = elapsed + 10000
    }
    if (elapsed >= nextProgress) { await send({ kind: 'progress', elapsedMs: Math.round(elapsed) }); nextProgress = elapsed + 30000 }
    await delay(20)
  }
  const elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuStart)
  heartbeat.disable()
  if (clock) for (const f of fixtures) {
    for (const actor of ['root', 'fixture-child-a', 'fixture-child-b']) clock.leave(f.rootSessionId, actor)
    await clock.flush(f.rootSessionId)
  }
  const accounts = []
  if (runtime) for (const f of fixtures) {
    const snapshot = runtime.journal.readSnapshot(f.rootSessionId), account = snapshot.run.budget, expected = counts.get(f.rootSessionId)
    assert.equal(snapshot.revision, config.events)
    assert.equal(snapshot.run.outcome, null); assert.equal(snapshot.run.ledger.fail, 0)
    assert.equal(account.used.rootModel, expected.model); assert.equal(account.used.commands, expected.command)
    assert.equal(account.time.reservedMs, 0); assert.equal(account.time.uncertainMs, 0)
    assert.ok(account.time.observedMs >= Math.min(config.durationMs, limits.activeMs) - 5000)
    assert.ok(account.time.observedMs <= Math.min(elapsedMs + 1000, limits.activeMs))
    accounts.push({ used: account.used, time: account.time, blocked: account.blocked?.resource ?? null })
  }
  let finalColdMs = null
  if (runtime) {
    const expected = fixtures.map(f => runtime.journal.readSnapshot(f.rootSessionId))
    await clock.close(); clock = undefined
    await runtime.close(); runtime = undefined
    const at = performance.now()
    runtime = await openWorkflowStorage(join(directory, 'workflow'))
    finalColdMs = performance.now() - at
    for (const [index, f] of fixtures.entries()) assert.deepEqual(runtime.journal.readSnapshot(f.rootSessionId), expected[index])
  }
  assert.equal(faults.length, 0)
  assert.ok(stops.length === 0 || (config.durationMs === limits.activeMs && stops.every(stop => stop.error === 'RunBudgetExceeded')))
  await send({ kind: 'result', result: { elapsedMs, coldMs, finalColdMs, samples: { reads: reads.length, writes: writes.length },
    readsMs: summarize(reads), writesMs: summarize(writes), eventLoopMs: { p95: heartbeat.percentile(95) / 1e6, p99: heartbeat.percentile(99) / 1e6, max: heartbeat.max / 1e6 },
    cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, peakRss, peakHeap, memory,
    inputBytesPerRoot: records.map(record => Buffer.byteLength(JSON.stringify(record))), accounts,
    checks: { passed: true, finalColdReplayMatches: config.mode === 'workflow', eventRevisionsUnchanged: config.mode === 'workflow', noFalseBusinessOutcome: true, faults: faults.length, budgetStops: stops.length } } })
} finally {
  heartbeat.disable(); await clock?.close(); await runtime?.close()
  for (const handle of handles) await handle.close()
  await ctx?.fiber.dispose(); clearTimeout(fuse)
  process.removeListener('disconnect', parentDisconnected)
  process.disconnect()
}
