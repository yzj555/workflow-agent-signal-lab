/** Read-only, authenticated diagnostics for child-runtime incidents; never prompts or cancels a Session. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, outputDirectory] = process.argv.slice(2)
if (!sourceRoot || !launchLog || !outputDirectory) throw new Error('usage: node scripts/audit-child-runtime.mjs <DSH source> <launch log> <evidence directory>')
const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(matches.length)
const navigationUrl = matches.at(-1)[1]
assert.equal(new URL(navigationUrl).hostname, '127.0.0.1')
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    return route.request().method() === 'POST' && path !== '/api/session/list' ? route.abort('blockedbyclient') : route.continue()
  })
  assert.equal((await page.goto(navigationUrl, { waitUntil: 'domcontentloaded' })).status(), 200)
  const result = await page.evaluate(async () => {
    const rpc = async (path, method, payload) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !envelope.result?.ok) throw new Error(`${method}: invalid response`)
      return envelope.result.value
    }
    const sessions = await rpc('/api/session/list', 'session/list', { args: { _request: {} } })
    const affected = [], failures = []
    for (let i = 0; i < sessions.items.length; i += 4) {
      await Promise.all(sessions.items.slice(i, i + 4).map(async session => {
        try {
          const snapshot = await rpc('/workflow-runtime/snapshot', 'snapshot', { schemaVersion: 1, rootSessionId: session.sessionId })
          const agents = snapshot.run?.agents.filter(agent => agent.runtimeIssue) ?? []
          if (agents.length) affected.push({ rootSessionId: session.sessionId, revision: snapshot.revision,
            title: session.displayTitle ?? session.projections?.values?.title ?? snapshot.run.title,
            outcome: snapshot.run.outcome, agents })
        } catch (error) { failures.push({ rootSessionId: session.sessionId, error: String(error) }) }
      }))
    }
    return { sessionCount: sessions.items.length, runningCount: sessions.items.filter(session => session.running === true).length,
      affected, failures }
  })
  const evidence = { checkedAt: new Date().toISOString(), mode: 'read-only-current-run-snapshots', ...result }
  await mkdir(resolve(outputDirectory), { recursive: true })
  await writeFile(join(resolve(outputDirectory), 'child-runtime-audit.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  assert.equal(result.failures.length, 0, 'some snapshots failed; do not claim complete visibility')
} finally { await browser.close() }
