/** Read-only root AND recursive native child catalogue audit. No prompts/cancellation. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [sourceRoot, log, reportFile, exceptRoot] = process.argv.slice(2)
assert.ok(sourceRoot && log && reportFile)
const url = [...(await readFile(log, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const { chromium } = await import(pathToFileURL(join(resolve(sourceRoot),
  'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method())
    || ['/api/session/list', '/api/subagents/list'].includes(new URL(route.request().url()).pathname)
    ? route.continue() : route.abort('blockedbyclient'))
  assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded' })).status(), 200)
  const audit = await page.evaluate(async exceptRoot => {
    const rpc = async (method, args) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(15000) })
      const envelope = await response.json()
      if (!response.ok || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error(`${method} rejected`)
      return envelope.result.value
    }
    const sessions = await rpc('session/list', { _request: {} })
    const queue = sessions.items.map(item => ({ sessionId: item.sessionId, rootSessionId: item.sessionId }))
    const active = [], diagnostics = [], failures = [], catalog = []
    const seen = new Set()
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const item = queue.shift()
        if (seen.has(item.sessionId)) continue
        seen.add(item.sessionId)
        try {
          const children = await rpc('subagents/list', { parentSessionId: item.sessionId })
          for (const entry of children.entries) {
            const detail = { parent: item.sessionId, root: item.rootSessionId, entry }
            catalog.push(detail)
            if (entry.kind === 'diagnostic') diagnostics.push(detail)
            if (entry.activity === 'running') active.push(detail)
            if (entry.hasChildren) queue.push({ sessionId: entry.id, rootSessionId: item.rootSessionId })
          }
        } catch (error) { failures.push({ parent: item.sessionId, error: String(error) }) }
      }
    }))
    // Official session.control's opening baseline enumerates every resident
    // Session, including children; a historical broken descriptor is not by
    // itself evidence of a live Agent. Keep both independent observations.
    const resident = await new Promise((resolve, reject) => {
      const streamId = crypto.randomUUID()
      const socket = new WebSocket(`ws://${location.host}/api/remote.mux`)
      const timer = setTimeout(() => { socket.close(); reject(new Error('control baseline timeout')) }, 10000)
      const finish = (error, value) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value) }
      socket.onopen = () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } }))
      socket.onerror = () => finish(new Error('control socket failed'))
      socket.onmessage = event => {
        const frame = JSON.parse(event.data)
        if (frame.streamId !== streamId) return
        if (frame.type === 'error') return finish(new Error(JSON.stringify(frame.error)))
        if (frame.type !== 'item' || frame.value?.type !== 'baseline') return
        const value = frame.value.value
        finish(null, { observedAt: new Date().toISOString(), ids: Object.keys(value.projections),
          queues: Object.fromEntries(Object.entries(value.queues).map(([id, items]) => [id, items.length])),
          jobs: Object.fromEntries(Object.entries(value.jobs).map(([id, jobs]) => [id, jobs.map(job => ({ kind: job.kind, status: job.status }))])) })
      }
    })
    const latest = await rpc('session/list', { _request: {} })
    return { sessionCount: latest.items.length, exceptRoot: exceptRoot ?? null,
      running: latest.items.filter(item => item.running).map(item => ({ id: item.sessionId, title: item.projections?.values?.title })),
      active, diagnostics, failures, catalog, resident,
      residentDiagnostics: diagnostics.filter(item => resident.ids.includes(item.entry.id)),
      unclassifiedResident: resident.ids.filter(id => !latest.items.some(item => item.sessionId === id)
        && !catalog.some(item => item.entry.kind === 'child' && item.entry.id === id)) }
  }, exceptRoot)
  const report = { checkedAt: new Date().toISOString(), mode: 'read-only', ...audit }
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, diagnostics: `[${audit.diagnostics.length} entries retained in report]`,
    catalog: `[${audit.catalog.length} entries retained in report]` }, null, 2))
  if (audit.running.some(item => item.id !== exceptRoot) || audit.active.some(item => item.root !== exceptRoot)
    || audit.residentDiagnostics.length || audit.unclassifiedResident.length || audit.failures.length
    || Object.entries(audit.resident.queues).some(([id, count]) => id !== exceptRoot && count > 0)
    || Object.entries(audit.resident.jobs).some(([id, jobs]) => id !== exceptRoot && jobs.length > 0)) process.exitCode = 1
} finally { await browser.close() }
