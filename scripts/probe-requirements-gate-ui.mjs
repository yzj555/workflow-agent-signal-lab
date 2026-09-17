/** Read-only visual probe for the workflow's first native-composer gate. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, outputDirectory, sessionTitle, workspaceTitle] = process.argv.slice(2)
if (!sourceRoot || !outputDirectory || !sessionTitle || !workspaceTitle) {
  throw new Error('usage: node scripts/probe-requirements-gate-ui.mjs <DSH source> <evidence directory> <session title> <workspace title>')
}
const target = new URL('http://127.0.0.1:3080/')
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const evidenceDirectory = resolve(outputDirectory)
await mkdir(evidenceDirectory, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
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
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })

  const session = page.getByText(sessionTitle, { exact: true }).first()
  if (!await session.isVisible().catch(() => false)) {
    const workspace = page.getByText(workspaceTitle, { exact: true }).first()
    if (await workspace.isVisible().catch(() => false)) await workspace.click()
  }
  if (!await session.isVisible().catch(() => false)) {
    const searchButton = page.getByRole('button', { name: '搜索会话', exact: true })
    if (await searchButton.isVisible().catch(() => false)) {
      await searchButton.click()
      await page.getByPlaceholder('搜索会话…', { exact: true }).fill(sessionTitle)
    }
  }
  await session.waitFor({ state: 'visible', timeout: 20_000 })
  await session.click()
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 })

  const panel = page.locator('[data-requirements-gate-key]')
  await panel.waitFor({ state: 'visible', timeout: 20_000 })
  const fileSidebarToggle = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
  if (await fileSidebarToggle.isVisible()) await fileSidebarToggle.click()
  await page.mouse.move(1400, 15)

  const details = await panel.evaluate(root => {
    const card = root.querySelector('section')
    const scroll = root.querySelector('[data-requirements-gate-scroll]')
    return {
      text: root.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      cardHeight: card?.getBoundingClientRect().height ?? 0,
      bodyClientHeight: scroll?.clientHeight ?? 0,
      bodyScrollHeight: scroll?.scrollHeight ?? 0,
      bodyRequiresScroll: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
      horizontalOverflow: root.scrollWidth > root.clientWidth,
      inputCount: root.querySelectorAll('input,textarea,[contenteditable="true"]').length,
      buttons: [...root.querySelectorAll('button')].map(button => button.textContent?.trim() ?? ''),
    }
  })
  const report = {
    checkedAt: new Date().toISOString(),
    readonly: true,
    details,
    workflowStyles: await page.locator('style[data-plugin="@local/workflow-agent-signal-lab"]').count(),
    officialPlanReviewVisible: await page.locator('[data-plan-review-key]').count(),
    errors,
    forbiddenRequests,
  }
  const screenshot = join(evidenceDirectory, 'requirements-gate-composer.png')
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
  await writeFile(join(evidenceDirectory, 'requirements-gate-report.json'), `${JSON.stringify({ ...report, screenshot }, null, 2)}\n`)
  console.log(JSON.stringify({ ...report, screenshot }, null, 2))

  assert.equal(errors.length, 0)
  assert.equal(forbiddenRequests.length, 0)
  assert.equal(report.workflowStyles, 1)
  assert.equal(report.officialPlanReviewVisible, 0)
  assert.equal(details.horizontalOverflow, false)
  assert.equal(details.inputCount, 0)
  assert.deepEqual(details.buttons, ['返回对话修改', '确认理解并开始只读规划'])
  for (const text of ['需求理解', '只读规划', '只读分析', '不写文件', '不运行检查']) {
    assert.ok(details.text.includes(text), `missing first-gate copy: ${text}`)
  }
} finally {
  await browser.close()
}
