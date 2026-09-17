/** Select one option on the current DSH native question and verify card progression. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, sessionTitle, expectedQuestionText, optionIndexText, answerLabel, reportFile] = process.argv.slice(2)
if (![sourceRoot, launchLog, sessionTitle, expectedQuestionText, optionIndexText, answerLabel, reportFile].every(Boolean)) {
  throw new Error('usage: node scripts/answer-native-choice.mjs <DSH source> <launch log> <Session title> <expected question text> <zero-based option index> <answer label> <report file>')
}
const optionIndex = Number(optionIndexText)
assert.ok(Number.isSafeInteger(optionIndex) && optionIndex >= 0, 'option index must be a non-negative integer')
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
  const observedWrites = []
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const canonical = path.slice('/api/'.length).replaceAll('.', '/')
    if (request.method() === 'POST') observedWrites.push(path)
    if (canonical !== 'respond' && /^(session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate))$/.test(canonical)) {
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
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
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  const questionText = (await card.innerText()).replace(/\s+/gu, ' ').trim()
  assert.ok(questionText.includes(expectedQuestionText), `unexpected native question: ${questionText}`)
  const questionKey = await card.getAttribute('data-question-key')
  assert.ok(questionKey, 'native question has no stable key')
  const progressText = await card.getByText(/^\d+\s*\/\s*\d+$/u).innerText()
  const progressMatch = /^(\d+)\s*\/\s*(\d+)$/u.exec(progressText.trim())
  assert.ok(progressMatch, 'native question has no readable progress')
  const currentIndex = Number(progressMatch[1])
  const totalQuestions = Number(progressMatch[2])
  const radios = card.getByRole('radio')
  const stem = resolve(reportFile).replace(/\.json$/u, '')
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await page.screenshot({ path: `${stem}-before.png`, fullPage: true, animations: 'disabled' })
  if (await radios.count() > optionIndex) {
    await radios.nth(optionIndex).click()
  }
  else {
    const choice = card.getByText(answerLabel, { exact: false }).first()
    await choice.waitFor({ state: 'visible' })
    await choice.click()
  }
  let actionLabel
  if (currentIndex < totalQuestions) {
    actionLabel = '自动进入下一题'
    await page.waitForFunction(previous => {
      const current = document.querySelector('[data-question-key]')?.textContent?.replace(/\s+/gu, ' ').trim() ?? null
      return current !== previous
    }, questionText, { timeout: 5_000 })
  } else {
    const submit = card.locator('button').filter({ hasText: /^提交$/u }).last()
    await submit.waitFor({ state: 'visible' })
    await page.waitForFunction(() => [...(document.querySelector('[data-question-key]')?.querySelectorAll('button') ?? [])]
      .some(button => button.textContent?.trim() === '提交' && !button.disabled), undefined, { timeout: 5_000 })
    actionLabel = '提交'
    await submit.click()
    await page.waitForFunction(previous => {
      const current = document.querySelector('[data-question-key]')?.textContent?.replace(/\s+/gu, ' ').trim() ?? null
      return current !== previous
    }, questionText, { timeout: 20_000 })
  }
  await page.screenshot({ path: `${stem}-after.png`, fullPage: true, animations: 'disabled' })
  const nextCard = page.locator('[data-question-key]')
  const report = {
    answeredAt: new Date().toISOString(),
    sessionTitle,
    questionKey,
    expectedQuestionText,
    selectedOptionIndex: optionIndex,
    answerLabel,
    actionLabel,
    progress: `${String(currentIndex)}/${String(totalQuestions)}`,
    nextQuestion: await nextCard.isVisible().catch(() => false)
      ? (await nextCard.innerText()).replace(/\s+/gu, ' ').trim()
      : null,
    observedWritePaths: [...new Set(observedWrites)],
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
