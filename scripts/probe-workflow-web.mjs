/** Read-only smoke check against the real, already running official DSH web app. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, target = 'http://127.0.0.1:3080/', outputDirectory, sessionTitle, expectedPassSessionId, launchLog, expectedRecoverySessionId, expectedChildRuntimeStatus, expectedBudgetEndSessionId] = process.argv.slice(2)
if (!sourceRoot || !outputDirectory) throw new Error('usage: node scripts/probe-workflow-web.mjs <DSH source> <URL> <evidence directory> [existing session title] [expected PASS session id] [launch log]')
if (expectedPassSessionId && !sessionTitle) throw new Error('a completed-run check requires its exact existing session title')
if (expectedRecoverySessionId && (!sessionTitle || expectedPassSessionId)) throw new Error('a recovery check requires one exact title and no expected PASS Session')
if (expectedChildRuntimeStatus) assert.ok(expectedRecoverySessionId && ['stopped', 'unknown'].includes(expectedChildRuntimeStatus), 'child-runtime check requires a named recovery Session and stopped|unknown')
if (expectedBudgetEndSessionId) assert.ok(sessionTitle && !expectedPassSessionId && !expectedRecoverySessionId, 'budget end requires one exact ended Session')
const url = new URL(target)
assert.equal(url.hostname, '127.0.0.1', 'probe is limited to the local app')
let navigationTarget = target
if (launchLog !== undefined) {
  const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
  assert.ok(matches.length > 0, 'launch log does not contain a DSH web URL')
  navigationTarget = matches.at(-1)[1]
}
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const evidenceDirectory = resolve(outputDirectory)
await mkdir(evidenceDirectory, { recursive: true })
// Use Playwright's pinned Chromium so the probe follows DSH's modern-browser
// target instead of silently inheriting an arbitrarily stale system Edge.
const browser = await chromium.launch({ headless: true })
const browserVersion = browser.version()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  const errors = []
  const consoleErrors = []
  const failedRequests = []
  const benignAbortedRequests = []
  const workflowReads = []
  const forbiddenRequests = []
  await page.route('**/api/**', route => {
    const method = new URL(route.request().url()).pathname.slice('/api/'.length)
    const canonicalMethod = method.replaceAll('.', '/')
    if (/^(respond|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(run|execute))$/.test(canonicalMethod)) {
      forbiddenRequests.push(method)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('requestfailed', request => {
    const failure = {
      url: request.url(),
      error: request.failure()?.errorText ?? 'unknown request failure',
    }
    // Selecting a search result unmounts DSH's session-search view and aborts
    // its now-obsolete request. The target Session is already visible at that
    // point, so this cancellation is navigation cleanup rather than a runtime
    // or plugin failure. Keep it in evidence but outside the failure count.
    if (new URL(request.url()).pathname === '/api/session/search' && failure.error === 'net::ERR_ABORTED') {
      benignAbortedRequests.push(failure)
      return
    }
    failedRequests.push(failure)
  })
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/workflow-runtime/snapshot') workflowReads.push(response.status())
  })
  const navigation = await page.goto(navigationTarget, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  try {
    await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })
  } catch (error) {
    const startupFailure = {
      status: navigation?.status() ?? null,
      url: await page.evaluate(() => `${location.origin}${location.pathname}`),
      title: await page.title(),
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000),
      errors,
      consoleErrors,
      failedRequests,
    }
    await page.screenshot({ path: join(evidenceDirectory, 'startup-failure.png'), fullPage: true, animations: 'disabled' })
    await writeFile(join(evidenceDirectory, 'startup-failure.json'), JSON.stringify(startupFailure, null, 2) + '\n')
    console.error(JSON.stringify(startupFailure, null, 2))
    throw error
  }
  if (sessionTitle) {
    const session = page.getByText(sessionTitle, { exact: true })
    if (!await session.isVisible().catch(() => false)) {
      const conversationSidebar = page.getByTitle('侧边对话(beta)', { exact: true })
      if (await conversationSidebar.isVisible().catch(() => false)) await conversationSidebar.click()
    }
    // DSH 0.1.5 groups sessions under collapsed workspace rows by default.
    // Use the native search affordance to reveal an existing session without
    // changing workspace ordering, expansion preferences, or session state.
    if (!await session.isVisible().catch(() => false)) {
      const searchButton = page.getByRole('button', { name: '搜索会话', exact: true })
      if (await searchButton.isVisible().catch(() => false)) {
        await searchButton.click()
        await page.getByPlaceholder('搜索会话…', { exact: true }).fill(sessionTitle)
      }
    }
    await session.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await session.count(), 1, 'existing session title must be unambiguous')
    await session.click()
    const workflowTab = page.getByRole('tab', { name: '工作流', exact: true })
    try {
      await workflowTab.waitFor({ state: 'visible', timeout: 15_000 })
    } catch (error) {
      await page.screenshot({ path: join(evidenceDirectory, 'session-open-failure.png'), fullPage: true, animations: 'disabled' })
      await writeFile(join(evidenceDirectory, 'session-open-failure.json'), JSON.stringify({
        url: await page.evaluate(() => `${location.origin}${location.pathname}`),
        title: await page.title(),
        body: (await page.locator('body').innerText().catch(() => '')).slice(0, 8000),
        errors,
        consoleErrors,
        failedRequests,
      }, null, 2) + '\n')
      throw error
    }
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 15_000 })
    const fileSidebarToggle = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
    if (await fileSidebarToggle.isVisible()) {
      await fileSidebarToggle.click()
      await fileSidebarToggle.waitFor({ state: 'hidden' })
    }
    assert.equal(await page.locator('.wfr-dock, .wfr-layer').count(), 0, 'no independent composer card or overlay')
    await page.mouse.move(1400, 15)
    await page.screenshot({ path: join(evidenceDirectory, 'native-chat.png'), fullPage: true, animations: 'disabled' })
    await workflowTab.click()
    await page.locator('.wfr-view').waitFor({ state: 'visible' })
    if (expectedPassSessionId) {
      await page.waitForFunction(() => ['通过', '待沉淀'].includes(document.querySelector('.wfr-view .wfr-status')?.textContent?.trim() ?? ''), { timeout: 10_000 })
      await page.waitForFunction(() => {
        const statuses = [...document.querySelectorAll('.wfr-agent-status')]
        return statuses.length > 0 && statuses.every(item => item.textContent === '已完成')
      }, { timeout: 10_000 })
    } else if (expectedChildRuntimeStatus) {
      await page.waitForFunction(text => document.querySelector('.wfr-view')?.textContent?.includes(text),
        expectedChildRuntimeStatus === 'unknown' ? '未确认停止' : '已停止', { timeout: 10_000 })
    } else if (expectedRecoverySessionId) {
      await page.waitForFunction(() => document.querySelector('.wfr-view')?.textContent?.includes('需要处理'), undefined, { timeout: 10_000 })
    } else if (expectedBudgetEndSessionId) {
      await page.waitForFunction(() => document.querySelector('.wfr-status[data-placement=header]')?.textContent === '已取消')
      assert.equal(await page.locator('.wfr-view .wfr-status').innerText(), '已取消')
      assert.match(await page.locator('.wfr-orientation').innerText(), /本轮已结束，无需操作/)
      assert.doesNotMatch(await page.locator('.wfr-view').innerText(), /正在整理|待沉淀/)
      assert.match(await page.locator('.wfr-track').innerText(), /未整理/)
    } else {
      await page.getByText('还没有工作流记录', { exact: true }).waitFor({ state: 'visible' })
    }
    assert.equal(await workflowTab.getAttribute('aria-selected'), 'true', 'the official tab owns selection')
    await page.mouse.move(1400, 15)
  }
  const rpcId = randomUUID()
  const response = await page.request.post(new URL('/workflow-runtime/snapshot', url.origin).href, {
    data: { type: 'client-request', rpcId, method: 'snapshot', payload: { schemaVersion: 1, rootSessionId: expectedPassSessionId || expectedRecoverySessionId || expectedBudgetEndSessionId || 'slice2-read-only-smoke-probe' } },
  })
  assert.equal(response.status(), 200)
  const envelope = await response.json()
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true)
  if (expectedPassSessionId) {
    assert.equal(envelope.result.value.rootSessionId, expectedPassSessionId)
    assert.equal(envelope.result.value.run?.outcome, 'PASS')
    assert.ok(envelope.result.value.run.agents.every(agent => agent.status === 'idle' || agent.status === 'completed'))
  } else if (expectedRecoverySessionId) {
    assert.equal(envelope.result.value.rootSessionId, expectedRecoverySessionId)
    if (expectedChildRuntimeStatus) {
      assert.ok(envelope.result.value.run?.agents.some(agent => agent.runtimeIssue?.status === expectedChildRuntimeStatus))
      assert.notEqual(envelope.result.value.run.outcome, 'PASS')
      if (expectedChildRuntimeStatus === 'unknown') assert.notEqual(envelope.result.value.run.outcome, 'CANCELLED')
    } else {
      assert.equal(envelope.result.value.run, null)
      assert.equal(envelope.result.value.preRunRecovery?.status, 'needs-attention')
    }
  } else if (expectedBudgetEndSessionId) {
    assert.equal(envelope.result.value.rootSessionId, expectedBudgetEndSessionId)
    assert.equal(envelope.result.value.run.outcome, 'CANCELLED')
    assert.equal(envelope.result.value.run.budget.recovery.closed, true)
    assert.equal(envelope.result.value.run.agents.length, 0)
  } else {
    assert.equal(envelope.result.value.availability, 'absent')
    assert.equal(envelope.result.value.revision, 0)
  }
  const details = await page.evaluate(() => ({
    title: document.title,
    pluginLoadFailure: document.body.innerText.includes('Failed to load plugins'),
    url: `${location.origin}${location.pathname}`,
    buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.innerText, label: button.getAttribute('aria-label'), title: button.title })).filter(button => button.text || button.label || button.title),
    links: [...document.querySelectorAll('a[href]')].map(link => ({ text: link.textContent, href: link.getAttribute('href') })),
    workflowStyles: document.querySelectorAll('style[data-plugin="@local/workflow-agent-signal-lab"]').length,
    workflowViewStyle: (() => {
      const view = document.querySelector('.wfr-view')
      if (!view) return null
      const style = getComputedStyle(view)
      return { position: style.position, color: style.color, fontFamily: style.fontFamily, horizontalOverflow: view.scrollWidth > view.clientWidth }
    })(),
    legacySurfaceCount: document.querySelectorAll('.wfr-dock, .wfr-layer, .wfr-panel').length,
    workflowView: document.querySelector('.wfr-view')?.textContent ?? null,
    agentStatuses: [...document.querySelectorAll('.wfr-agent-status')].map(item => item.textContent),
    stageLabels: [...document.querySelectorAll('.wfr-step-status')].map(item => item.textContent),
    stageStates: [...document.querySelectorAll('.wfr-step')].map(item => item.dataset.state),
    currentStageCount: document.querySelectorAll('.wfr-step[aria-current]').length,
    completionNotice: document.querySelector('.wfr-completion')?.textContent ?? null,
    nativeTabs: [...document.querySelectorAll('[role="tab"]')].map(tab => ({ label: tab.textContent, selected: tab.getAttribute('aria-selected') })),
    workflowInputCount: document.querySelectorAll('.wfr-view textarea, .wfr-view input, .wfr-view [contenteditable="true"]').length,
    nativeInputCount: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    pendingQuestionCount: document.querySelectorAll('[data-question-key]').length,
    pendingQuestionOverflow: [...document.querySelectorAll('[data-question-key]')]
      .some(item => item.scrollWidth > item.clientWidth),
  }))
  // DSH's content is a nested scroller; fullPage alone can capture only its
  // retained bottom position and omit the actual workflow status header.
  await page.evaluate(() => {
    let item = document.querySelector('.wfr-view')
    while (item) { if (item.scrollHeight > item.clientHeight) item.scrollTop = 0; item = item.parentElement }
  })
  await page.screenshot({ path: join(evidenceDirectory, 'real-dsh.png'), fullPage: true, animations: 'disabled' })
  const report = {
    checkedAt: new Date().toISOString(), readonly: true, browserVersion,
    ...details, errors, consoleErrors, failedRequests, benignAbortedRequests, forbiddenRequests,
    workflowReads, rpc: envelope.result.value,
  }
  await writeFile(join(evidenceDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ checkedAt: report.checkedAt, browserVersion, title: details.title, workflowStyles: details.workflowStyles,
    legacySurfaceCount: details.legacySurfaceCount, nativeTabs: details.nativeTabs, workflowViewStyle: details.workflowViewStyle,
    workflowInputCount: details.workflowInputCount, nativeInputCount: details.nativeInputCount,
    pendingQuestionCount: details.pendingQuestionCount, pendingQuestionOverflow: details.pendingQuestionOverflow,
    errors, benignAbortedRequestCount: benignAbortedRequests.length, forbiddenRequests, workflowReads, agentStatuses: details.agentStatuses,
    stageLabels: details.stageLabels, stageStates: details.stageStates, currentStageCount: details.currentStageCount, completionNotice: details.completionNotice,
    rpc: { rootSessionId: report.rpc.rootSessionId, revision: report.rpc.revision, availability: report.rpc.availability, outcome: report.rpc.run?.outcome ?? null }, evidenceDirectory }, null, 2))
  assert.equal(errors.length, 0, 'real page must not throw')
  assert.equal(consoleErrors.length, 0, 'real page must not log client errors')
  assert.equal(failedRequests.length, 0, 'real page must not have failed requests')
  assert.equal(details.pluginLoadFailure, false, 'the plugin bundle must load completely')
  assert.equal(details.workflowStyles, 1, 'plugin client must be mounted exactly once')
  assert.equal(details.legacySurfaceCount, 0, 'legacy standalone surfaces must be removed')
  assert.equal(forbiddenRequests.length, 0, 'UI inspection must not execute a task or change its preset')
  if (sessionTitle) {
    assert.equal(details.workflowInputCount, 0, 'plugin must not contain a second chat input')
    assert.equal(details.nativeInputCount, details.pendingQuestionCount > 0 ? 2 : 1,
      'the official composer remains mounted; a pending native question contributes only its standard custom-answer field')
    assert.equal(details.pendingQuestionOverflow, false, 'the native question must not overflow horizontally')
    assert.equal(details.workflowViewStyle?.position, 'static', 'the workflow is inside the native view, not an overlay')
    assert.equal(details.workflowViewStyle?.horizontalOverflow, false)
    assert.ok(workflowReads.length > 0 && workflowReads.every(status => status === 200))
    if (expectedPassSessionId) {
      assert.equal(details.agentStatuses.length, envelope.result.value.run.agents.length)
      assert.ok(details.agentStatuses.every(status => status === '已完成'))
      assert.ok(!details.workflowView.includes('待续接'))
      assert.ok(details.workflowView.includes(`revision ${envelope.result.value.revision}`))
      if (envelope.result.value.run.executionProfile === 'workflow-text-pilot/1') {
        assert.deepEqual(details.stageLabels, ['已确认', '并入需求确认', '已完成', '已完成', '本次无需', '已交付', '未整理'])
        assert.equal(details.currentStageCount, 0)
        assert.match(details.completionNotice, /本轮已结束.*经验未整理/)
      }
    }
  }
} finally { await browser.close() }
