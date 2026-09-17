/** Return a pending native plan review to chat and submit one scoped revision request. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, sessionTitle, expectedFile, promptFile, reportFile] = process.argv.slice(2)
if (![sourceRoot, launchLog, sessionTitle, expectedFile, promptFile, reportFile].every(Boolean)) {
  throw new Error('usage: node scripts/revise-native-plan.mjs <DSH source> <launch log> <Session title> <expected JSON> <prompt file> <report file>')
}
const expected = JSON.parse(await readFile(expectedFile, 'utf8'))
assert.ok(Array.isArray(expected) && expected.every(item => typeof item === 'string'))
const prompt = (await readFile(promptFile, 'utf8')).trim()
assert.ok(prompt.length > 0, 'revision prompt is empty')
const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(matches.length > 0, 'launch log does not contain a DSH web URL')

const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  const observedPostPaths = []
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const canonical = path.slice('/api/'.length).replaceAll('.', '/')
    if (request.method() === 'POST') observedPostPaths.push(path)
    if (!['respond', '$events/result', 'session/prompt'].includes(canonical)
      && /^(session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate))$/.test(canonical)) {
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  const navigation = await page.goto(matches.at(-1)[1], { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(navigation?.status(), 200)
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })
  let session = page.getByText(sessionTitle, { exact: true }).first()
  if (!await session.isVisible().catch(() => false)) {
    let search = page.locator('button[aria-label="搜索会话"]')
    if (!await search.isVisible().catch(() => false)) {
      await page.locator('button[aria-label="展开侧边栏"], button[title="侧边对话(beta)"]').first().click()
      search = page.locator('button[aria-label="搜索会话"]')
      await search.waitFor({ state: 'visible', timeout: 20_000 })
    }
    await search.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(sessionTitle)
    session = page.getByText(sessionTitle, { exact: true }).first()
  }
  await session.waitFor({ state: 'visible', timeout: 20_000 })
  await session.click()
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 })
  const panel = page.locator('[data-plan-review-key]')
  await panel.waitFor({ state: 'visible', timeout: 20_000 })
  const cardText = (await panel.innerText()).replace(/\s+/gu, ' ').trim()
  for (const phrase of expected) assert.ok(cardText.includes(phrase), `plan review is missing: ${phrase}`)
  const stem = resolve(reportFile).replace(/\.json$/u, '')
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await page.screenshot({ path: `${stem}-before.png`, fullPage: true, animations: 'disabled' })
  await panel.getByRole('button', { name: '去聊天里说', exact: true }).click()
  await panel.waitFor({ state: 'hidden', timeout: 20_000 })
  const composer = page.locator('[data-composer-input]').first()
  await composer.waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-composer-input]')
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return !input.disabled
    return input?.getAttribute('contenteditable') === 'true'
  }, undefined, { timeout: 60_000 })
  await composer.fill(prompt)
  await composer.press('Enter')
  await page.waitForTimeout(750)
  await page.screenshot({ path: `${stem}-after.png`, fullPage: true, animations: 'disabled' })
  const report = {
    submittedAt: new Date().toISOString(),
    sessionTitle,
    action: 'returned-to-chat-and-submitted-revision',
    cardText,
    promptFile: resolve(promptFile),
    observedPostPaths: [...new Set(observedPostPaths)],
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, cardText: '[recorded in evidence file]' }, null, 2))
} finally {
  await browser.close()
}
