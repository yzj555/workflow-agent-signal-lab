/** Read one test Session and its durable command events without mutating the Host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, journalPath, sessionId, reportFile, fixtureRoot] = process.argv.slice(2)
assert.ok([sourceRoot, launchLog, journalPath, sessionId, reportFile].every(Boolean),
  'usage: node scripts/read-command-online-evidence.mjs <DSH source> <launch log> <journal sqlite> <test Session id> <report json> [fixture root]')
assert.match(sessionId, /^workflow-command-online-[a-z0-9-]+$/u)
assert.notEqual(resolve(journalPath), resolve(reportFile))
const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(matches.length > 0)
const navigationUrl = matches.at(-1)[1]
assert.equal(new URL(navigationUrl).origin, 'http://127.0.0.1:3080')
const { chromium } = await import(pathToFileURL(join(resolve(sourceRoot),
  'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const blockedWrites = []
  await page.route('**/*', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!['GET', 'HEAD'].includes(request.method())
      && !['/api/session/list', '/api/session/page', '/api/subagents/list', '/workflow-runtime/snapshot'].includes(path)) {
      blockedWrites.push(path)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  assert.equal((await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })).status(), 200)
  const native = await page.evaluate(async sessionId => {
    const rpc = async (path, method, payload) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
      const result = await response.json()
      if (result.rpcId !== rpcId || result.result?.ok !== true) throw new Error(`${method}: invalid response`)
      return result.result.value
    }
    const sessions = await rpc('/api/session/list', 'session/list', { args: { _request: {} } })
    const session = sessions.items.find(item => item.sessionId === sessionId)
    if (!session) throw new Error('test Session not found')
    const children = await rpc('/api/subagents/list', 'subagents/list', { args: { parentSessionId: sessionId } })
    const snapshot = await rpc('/workflow-runtime/snapshot', 'snapshot', { schemaVersion: 1, rootSessionId: sessionId })
    const values = session.projections?.values ?? {}
    // Deliberately trail the observed projection cursor by one event so this
    // diagnostic page never requests beyond the durable prefix it has seen.
    const history = await rpc('/api/session/page', 'session/page', { args: { request: {
      address: { kind: 'session', sessionId }, throughSeq: Math.max(-1, session.projections.asOfSeq - 1), maxMessages: 5,
    } } })
    const eventTimeline = history.records.map(({ event }) => ({ seq: event.seq, time: event.time,
      type: event.type, keys: event.data && typeof event.data === 'object' ? Object.keys(event.data) : [],
      ...(event.type === 'tool/call' ? { toolName: event.data.name, arguments: event.data.arguments } : {}),
      ...(event.type === 'tool/result' ? { result: event.data.message, error: event.data.error ?? null } : {}) }))
    return { running: session.running, title: values.title, asOfSeq: session.projections?.asOfSeq,
      permissions: values.permissions, modelSelection: values.modelSelection,
      lastTurn: values.turnOutline?.at(-1), children: children.entries, snapshot, eventTimeline }
  }, sessionId)
  const db = new DatabaseSync(resolve(journalPath), { readOnly: true })
  let journal
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    const row = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?').get(sessionId)
    const record = row ? JSON.parse(row.value) : null
    if (record) assert.equal(record.rootSessionId, sessionId)
    journal = { revision: record?.revision ?? 0,
      events: record?.events.filter(event => /^(command\/|agent\/runtime-interrupted|runtime\/|outcome\/|gate\/decided|acceptance\/|evidence\/|artifact\/)/u.test(event.data.name)) ?? [] }
  } finally { db.close() }
  const fixture = resolve(fixtureRoot ?? 'F:/dsh/workflow-command-fixture-20260915')
  assert.ok(['workflow-command-fixture-20260915', 'workflow-command-timeout-fixture-20260915',
    'workflow-command-cancel-fixture-20260915', 'workflow-command-restart-fixture-20260915',
    'workflow-command-restart-v2-fixture-20260915', 'workflow-command-restart-v3-fixture-20260915',
    'workflow-command-manual-recovery-fixture-20260915']
    .some(name => fixture === resolve('F:/dsh', name)), 'diagnostic fixture is outside the approved test directories')
  if (native.snapshot.run?.plan?.workspaceRoot) {
    assert.equal(resolve(native.snapshot.run.plan.workspaceRoot), fixture, 'fixture differs from the actual workflow workspace')
  }
  const fixtureHashes = {}
  const testFile = fixture === resolve('F:/dsh/workflow-command-fixture-20260915') ? 'tests/smoke.test.cjs' : 'tests/hang.test.cjs'
  for (const file of ['README.md', testFile]) {
    fixtureHashes[file] = createHash('sha256').update(await readFile(join(fixture, file))).digest('hex')
  }
  const report = { checkedAt: new Date().toISOString(), sessionId, mode: 'read-only', native, journal, fixtureRoot: fixture, fixtureHashes, blockedWrites }
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ checkedAt: report.checkedAt, sessionId, running: native.running,
    permissions: native.permissions, modelSelection: native.modelSelection, lastTurn: native.lastTurn,
    workflowRevision: native.snapshot.revision, outcome: native.snapshot.run?.outcome ?? null,
    needsUser: native.snapshot.run?.needsUser ?? null, preRunRecovery: native.snapshot.preRunRecovery ?? null,
    agents: native.snapshot.run?.agents ?? [], events: journal.events,
    eventTimeline: native.eventTimeline, fixtureHashes, reportFile: resolve(reportFile) }, null, 2))
} finally { await browser.close() }
