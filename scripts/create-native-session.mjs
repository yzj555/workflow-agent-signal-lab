/** Create one explicit-preset DSH Session and submit one native prompt. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [sourceRoot, baseUrl, launchLog, cwd, sessionId, title, agentPreset, promptFile, reportFile] = process.argv.slice(2)
if (![sourceRoot, baseUrl, launchLog, cwd, sessionId, title, agentPreset, promptFile, reportFile].every(Boolean)) {
  throw new Error('usage: node scripts/create-native-session.mjs <DSH source> <URL> <launch log> <cwd> <session id> <title> <preset> <prompt file> <report file>')
}
const target = new URL(baseUrl)
assert.equal(target.hostname, '127.0.0.1', 'native Session helper is limited to local DSH')
const launchMatches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(launchMatches.length > 0, 'launch log does not contain a DSH web URL')
const navigationUrl = launchMatches.at(-1)[1]
const prompt = await readFile(promptFile, 'utf8')
assert.ok(prompt.trim().length > 0, 'prompt file is empty')

const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const navigation = await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(navigation?.status(), 200, 'authenticated DSH navigation failed')
  const result = await page.evaluate(async ({ cwd, sessionId, title, agentPreset, prompt }) => {
    const rpc = async (endpoint, request) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId, method: endpoint,
          payload: endpoint === 'session/list' ? { args: { _request: request } } : { args: { request } },
        }),
      })
      if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`${endpoint} returned an invalid RPC envelope`)
      if (envelope.result?.ok !== true) throw new Error(envelope.result?.error?.message ?? `${endpoint} failed`)
      return envelope.result.value
    }
    const listed = await rpc('session/list', {})
    if (listed.items.some(item => item.sessionId === sessionId)) throw new Error('target Session already exists')
    const created = await rpc('session/create', { cwd, sessionId, agentPreset })
    if (created.sessionId !== sessionId) throw new Error('Host returned a different Session id')
    const renamed = await rpc('session/rename', { sessionId, title })
    const requestId = crypto.randomUUID()
    const submitted = await rpc('session/prompt', {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      clientTimeZone: 'Asia/Shanghai',
    })
    return { created, renamed, submitted, requestId }
  }, { cwd, sessionId, title, agentPreset, prompt })
  const report = {
    createdAt: new Date().toISOString(),
    sessionId,
    title,
    cwd,
    agentPreset,
    promptFile: resolve(promptFile),
    requestId: result.requestId,
    createdPreset: result.created.agentPreset ?? null,
    renameSeq: result.renamed.seq ?? null,
    accepted: true,
  }
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
