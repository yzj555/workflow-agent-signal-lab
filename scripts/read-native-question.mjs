/** Read the current DSH native question for one existing Session without answering it. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, sessionTitle] = process.argv.slice(2)
const readGroup = process.argv.includes('--group')
if (![sourceRoot, launchLog, sessionTitle].every(Boolean)) {
  throw new Error('usage: node scripts/read-native-question.mjs <DSH source> <launch log> <Session title>')
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  await page.route('**/*', route => route.request().method() === 'GET' || route.request().method() === 'HEAD'
    || !new URL(route.request().url()).pathname.match(/\/api\/(respond|\$events\/result|session[./](prompt|cancel|create|rename|selectModel|fork))/u)
    ? route.continue() : route.abort('blockedbyclient'))
  const navigation = await page.goto(matches.at(-1)[1], { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(navigation?.status(), 200)
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })
  let card = page.locator('[data-question-key]')
  if (!await card.isVisible().catch(() => false)) {
    let search = page.getByRole('button', { name: '搜索会话', exact: true })
    if (!await search.isVisible().catch(() => false)) {
      const toggle = page.getByTitle('侧边对话(beta)', { exact: true })
      await toggle.evaluate(element => element.click())
      search = page.getByRole('button', { name: '搜索会话', exact: true })
      await search.waitFor({ state: 'visible', timeout: 20_000 })
    }
    await search.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(sessionTitle)
    await page.getByText(sessionTitle, { exact: true }).first().click()
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 })
    card = page.locator('[data-question-key]')
  }
  const visible = await card.isVisible().catch(() => false)
  if (!visible) console.log('null')
  else if (readGroup) {
    const pages = []
    while (true) {
      const text = (await card.innerText()).replace(/\s+/gu, ' ').trim()
      pages.push(text)
      const progress = /\b(\d+)\s*\/\s*(\d+)\b/u.exec(text)
      if (!progress || Number(progress[1]) >= Number(progress[2])) break
      await card.getByRole('button', { name: '下一题', exact: true }).first().click()
      await page.waitForFunction(previous => {
        const current = document.querySelector('[data-question-key]')?.textContent?.replace(/\s+/gu, ' ').trim()
        return current !== previous
      }, text, { timeout: 5_000 })
    }
    console.log(JSON.stringify({ key: await card.getAttribute('data-question-key'), pages }, null, 2))
  } else {
    console.log(JSON.stringify({
      key: await card.getAttribute('data-question-key'),
      text: (await card.innerText()).replace(/\s+/gu, ' ').trim(),
      html: (await card.evaluate(element => element.outerHTML)).slice(0, 20_000),
    }, null, 2))
  }
} finally {
  await browser.close()
}
