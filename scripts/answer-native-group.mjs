/** Answer every page in the current native DSH question group in one browser context. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, sessionTitle, answersFile, reportFile] = process.argv.slice(2)
if (![sourceRoot, launchLog, sessionTitle, answersFile, reportFile].every(Boolean)) {
  throw new Error('usage: node scripts/answer-native-group.mjs <DSH source> <launch log> <Session title> <answers JSON> <report file>')
}
const answers = JSON.parse(await readFile(answersFile, 'utf8'))
assert.ok(Array.isArray(answers) && answers.length > 0, 'answers JSON must be a non-empty array')
for (const answer of answers) {
  assert.equal(typeof answer.expectedQuestionText, 'string')
  assert.ok((Number.isSafeInteger(answer.optionIndex) && answer.optionIndex >= 0)
    || (typeof answer.custom === 'string' && answer.custom.trim().length > 0))
  assert.equal(typeof answer.answerLabel, 'string')
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
  const observedPostPaths = []
  await page.route('**/api/**', route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const canonical = path.slice('/api/'.length).replaceAll('.', '/')
    if (request.method() === 'POST') observedPostPaths.push(path)
    if (!['respond', '$events/result'].includes(canonical)
      && /^(session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate))$/.test(canonical)) {
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
      await page.getByTitle('侧边对话(beta)', { exact: true }).evaluate(element => element.click())
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
  const questionKey = await card.getAttribute('data-question-key')
  assert.ok(questionKey, 'native question has no stable key')
  const stem = resolve(reportFile).replace(/\.json$/u, '')
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await page.screenshot({ path: `${stem}-before.png`, fullPage: true, animations: 'disabled' })

  const decisions = []
  for (let index = 0; index < answers.length; index += 1) {
    const answer = answers[index]
    const before = (await card.innerText()).replace(/\s+/gu, ' ').trim()
    assert.ok(before.includes(answer.expectedQuestionText), `unexpected question at page ${String(index + 1)}: ${before}`)
    const progress = await card.getByText(/^\d+\s*\/\s*\d+$/u).innerText()
    assert.equal(progress.replaceAll(' ', ''), `${String(index + 1)}/${String(answers.length)}`)
    if (typeof answer.custom === 'string') {
      const field = card.getByPlaceholder('输入你的答案', { exact: true })
      await field.fill(answer.custom)
      if (index < answers.length - 1) await field.press('Enter')
    } else {
      const options = card.getByRole('radio')
      assert.ok(await options.count() > answer.optionIndex, `option ${String(answer.optionIndex)} is absent on page ${String(index + 1)}`)
      await options.nth(answer.optionIndex).click()
    }
    decisions.push({
      expectedQuestionText: answer.expectedQuestionText,
      ...(answer.optionIndex === undefined ? {} : { optionIndex: answer.optionIndex }),
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      answerLabel: answer.answerLabel,
    })
    if (index < answers.length - 1) {
      await page.waitForFunction(previous => {
        const current = document.querySelector('[data-question-key]')?.textContent?.replace(/\s+/gu, ' ').trim()
        return current !== previous
      }, before, { timeout: 5_000 })
    }
  }

  const submit = card.locator('button').filter({ hasText: /^提交$/u }).last()
  await page.waitForFunction(() => [...(document.querySelector('[data-question-key]')?.querySelectorAll('button') ?? [])]
    .some(button => button.textContent?.trim() === '提交' && !button.disabled), undefined, { timeout: 5_000 })
  const finalText = (await card.innerText()).replace(/\s+/gu, ' ').trim()
  await submit.click()
  await page.waitForFunction(previous => {
    const current = document.querySelector('[data-question-key]')?.textContent?.replace(/\s+/gu, ' ').trim() ?? null
    return current !== previous
  }, finalText, { timeout: 20_000 })
  await page.screenshot({ path: `${stem}-after.png`, fullPage: true, animations: 'disabled' })
  const nextCard = page.locator('[data-question-key]')
  const report = {
    submittedAt: new Date().toISOString(),
    sessionTitle,
    questionKey,
    decisions,
    nextQuestion: await nextCard.isVisible().catch(() => false)
      ? (await nextCard.innerText()).replace(/\s+/gu, ' ').trim()
      : null,
    observedPostPaths: [...new Set(observedPostPaths)],
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
