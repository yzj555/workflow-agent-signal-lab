/** Read-only pre-reload check: fail unless every visible DSH Session is idle. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = process.argv[2] ?? 'F:/dsh/deepseek-harness'
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:3080/'
const launchLog = process.argv[4]
let navigationUrl = baseUrl
if (launchLog !== undefined) {
  const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
  assert.ok(matches.length > 0, 'launch log does not contain a DSH web URL')
  navigationUrl = matches.at(-1)[1]
}
const officialRequire = createRequire(join(sourceRoot, 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(sourceRoot, 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const response = await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(response?.status(), 200, 'DSH page did not return HTTP 200')
  const value = await page.evaluate(async () => {
    const rpcId = crypto.randomUUID()
    const response = await fetch('/api/session/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
    })
    if (!response.ok) throw new Error(`session/list returned HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new Error('session/list returned an invalid RPC envelope')
    }
    if (envelope.result?.ok !== true) {
      throw new Error(envelope.result?.error?.message ?? 'session/list failed')
    }
    return envelope.result.value
  })
  assert.ok(Array.isArray(value?.items), 'session/list did not return items')
  const running = value.items.filter(item => item?.running === true)
    .map(item => ({ sessionId: item.sessionId, title: item.displayTitle ?? item.title ?? null }))
  console.log(JSON.stringify({ httpStatus: 200, sessionCount: value.items.length, running }, null, 2))
  assert.equal(running.length, 0, 'DSH has running Sessions; reload is unsafe')
} finally {
  await browser.close()
}
