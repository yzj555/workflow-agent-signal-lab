/** Cancel one exact active DSH Session turn and verify it settles. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, sessionId, reportFile] = process.argv.slice(2)
if (![sourceRoot, launchLog, sessionId, reportFile].every(Boolean)) {
  throw new Error('usage: node scripts/cancel-native-turn.mjs <DSH source> <launch log> <Session id> <report file>')
}
const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(matches.length > 0, 'launch log does not contain a DSH web URL')
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const navigation = await page.goto(matches.at(-1)[1], { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(navigation?.status(), 200)
  const result = await page.evaluate(async sessionId => {
    const rpc = async (endpoint, request) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`/api/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { request } } }),
      })
      if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope?.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error(envelope.result?.error?.message ?? `${endpoint} failed`)
      return envelope.result.value
    }
    const list = async () => {
      const rpcId = crypto.randomUUID()
      const response = await fetch('/api/session/list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }),
      })
      const envelope = await response.json()
      if (envelope?.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('session/list failed')
      return envelope.result.value.items.find(candidate => candidate.sessionId === sessionId)
    }
    const before = await list()
    const cancelled = await rpc('session/cancel', { sessionId })
    const deadline = Date.now() + 20_000
    let item
    do {
      item = await list()
      if (item?.running === false) break
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    return { beforeRunning: before?.running ?? null, cancelled, afterRunning: item?.running ?? null }
  }, sessionId)
  assert.equal(result.beforeRunning, true, 'target Session was not running')
  assert.equal(result.afterRunning, false, 'target Session did not settle after cancellation')
  const report = { cancelledAt: new Date().toISOString(), sessionId, ...result }
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
