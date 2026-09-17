/** Read-only visual probe for an already pending native DSH plan review. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, targetOrLaunchLog, outputDirectory, sessionTitle] = process.argv.slice(2)
if (!sourceRoot || !targetOrLaunchLog || !outputDirectory || !sessionTitle) {
  throw new Error('usage: node scripts/capture-pending-plan-review.mjs <DSH source> <URL or launch log> <output directory> <session title>')
}
const target = /^https?:\/\//iu.test(targetOrLaunchLog)
  ? targetOrLaunchLog
  : [...(await readFile(targetOrLaunchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.ok(target, 'launch log does not contain a DSH web URL')
const targetUrl = new URL(target)
assert.equal(targetUrl.hostname, '127.0.0.1', 'probe is limited to the local app')
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const evidenceDirectory = resolve(outputDirectory)
await mkdir(evidenceDirectory, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  const errors = []
  const forbiddenRequests = []
  await page.route('**/api/**', route => {
    const method = new URL(route.request().url()).pathname.slice('/api/'.length)
    if (/^(respond|session\.(prompt|cancel|create|rename|selectModel)|subagent\.(prompt|interrupt)|agentPreset\.(select|remove)|goal\.(create|edit|resume|complete)|settings\.(update|replace|mutate))$/.test(method)) {
      forbiddenRequests.push(method)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })
  const session = page.getByText(sessionTitle, { exact: true }).first()
  if (!await session.isVisible().catch(() => false)) {
    let searchButton = page.locator('button[aria-label="搜索会话"]')
    if (!await searchButton.isVisible().catch(() => false)) {
      const currentToggle = page.locator('button[aria-label="展开侧边栏"], button[title="侧边对话(beta)"]').first()
      await currentToggle.evaluate(element => element.click())
      searchButton = page.locator('button[aria-label="搜索会话"]')
      await searchButton.waitFor({ state: 'visible', timeout: 20_000 })
    }
    await searchButton.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(sessionTitle)
  }
  await session.waitFor({ state: 'visible', timeout: 20_000 })
  await session.click()
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 })
  const panel = page.locator('[data-plan-review-key]')
  await panel.waitFor({ state: 'visible', timeout: 20_000 })
  const fileSidebarToggle = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
  if (await fileSidebarToggle.isVisible()) await fileSidebarToggle.click()
  await page.mouse.move(1400, 15)
  const details = await panel.evaluate(root => {
    const card = root.querySelector('section')
    const scroll = root.querySelector('[data-plan-review-scroll]')
    return {
      text: root.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      cardHeight: card?.getBoundingClientRect().height ?? 0,
      bodyClientHeight: scroll?.clientHeight ?? 0,
      bodyScrollHeight: scroll?.scrollHeight ?? 0,
      bodyRequiresScroll: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
      headings: root.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      listItems: root.querySelectorAll('li').length,
      paragraphs: root.querySelectorAll('p').length,
      horizontalOverflow: root.scrollWidth > root.clientWidth,
    }
  })
  const screenshot = join(evidenceDirectory, 'native-plan-review.png')
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
  console.log(JSON.stringify({ screenshot, errors, forbiddenRequests, ...details }, null, 2))
  assert.equal(errors.length, 0)
  assert.equal(forbiddenRequests.length, 0)
} finally {
  await browser.close()
}
