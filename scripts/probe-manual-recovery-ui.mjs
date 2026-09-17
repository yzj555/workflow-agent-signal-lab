/** Real DSH renderer + saved request replay. No Host question, run or approval is created. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { manualCloseQuestion, MANUAL_CLOSE_LABEL, KEEP_UNKNOWN_LABEL, REQUIREMENTS_CONFIRM_LABEL } from '../lib/workflow-control.js'

const [coreRoot, launchLog, outputRoot] = process.argv.slice(2)
assert.ok(coreRoot && launchLog && outputRoot)
const output = resolve(outputRoot)
await mkdir(output, { recursive: true })
const saved = JSON.parse(await readFile('.dsh/activation/workflow-manual-recovery-20260915/fixture/recovery-close-receipt.json', 'utf8'))
const snapshot = saved.after, record = snapshot.run.manualClose
assert.equal(snapshot.run.outcome, 'ABANDONED')
const sessionId = snapshot.rootSessionId
const state = { assignments: Object.fromEntries(snapshot.run.agents.map(agent => [agent.assignmentId, agent])),
  records: Object.fromEntries(snapshot.run.agents.map(agent => [`task:${agent.taskId}`, { kind: 'task', data: { title: agent.taskTitle } }])) }
const question = manualCloseQuestion(state, record)
const candidate = await readFile('lib/client.js', 'utf8')
const url = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const { chromium } = await import(pathToFileURL(join(resolve(coreRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const browser = await chromium.launch({ headless: true })
const errors = [], blockedWrites = [], checks = []
let servedCandidate = 0, officialBridges = 0
async function open(snapshotValue) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) {
      const method = path.slice(5).replaceAll('.', '/')
      if (/^(respond|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(run|execute))$/.test(method)) {
        blockedWrites.push(method)
        return route.abort('blockedbyclient')
      }
    }
    if (path === '/workflow-runtime/snapshot') {
      const rpc = request.postDataJSON()
      assert.equal(rpc.payload.rootSessionId, sessionId)
      const value = structuredClone(snapshotValue)
      value.run.title = `【界面回放 · 非当前运行】${value.run.title}`
      return route.fulfill({ json: { type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } } })
    }
    if (request.resourceType() === 'script' && new URL(request.url()).origin === 'http://127.0.0.1:3080') {
      const response = await route.fetch(), body = await response.text()
      if (body.includes('id: "@local/workflow-agent-signal-lab"')) {
        const normalized = candidate.replace(/\r\n/g, '\n').split('//# sourceMappingURL=')[0].trim()
        if (!body.replace(/\r\n/g, '\n').includes(normalized)) {
          await writeFile(join(output, 'served-build-mismatch.json'), JSON.stringify({
            checkedAt: new Date().toISOString(), hasRecoveryComposer: body.includes('function ManualRecoveryGateComposer'),
            candidateLength: normalized.length, servedLength: body.length,
          }, null, 2))
          errors.push('DSH is not serving the tested client build')
        }
        servedCandidate++
      }
      // Expose the OFFICIAL PendingQuestion and its existing publisher only in this
      // throwaway page. The plugin code and component chain are not replaced.
      const hook = 'const registerPendingInteraction = ctx.uiSession.registerPendingInteraction((pending) => pending.kind === "plan-review" ? 2 : 1);'
      if (body.includes(hook)) {
        assert.equal(body.split(hook).length, 2)
        officialBridges++
        return route.fulfill({ response, body: body.replace(hook, `${hook}\nwindow.__manualUiReplay = { PendingQuestion, publish: registerPendingInteraction, receipts: [], pending: [] };`) })
      }
      return route.fulfill({ response, body })
    }
    return route.continue()
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => !!window.__manualUiReplay, { timeout: 15000 })
  const title = page.getByText(saved.sessionTitle, { exact: true })
  if (!await title.isVisible().catch(() => false)) {
    const sidebar = page.getByTitle('侧边对话(beta)', { exact: true })
    if (await sidebar.isVisible().catch(() => false)) await sidebar.click()
  }
  if (!await title.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '搜索会话', exact: true }).click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(saved.sessionTitle)
  }
  await title.waitFor({ state: 'visible' })
  assert.equal(await title.count(), 1)
  await title.click()
  const tab = page.getByRole('tab', { name: '工作流', exact: true })
  await tab.waitFor({ state: 'visible' })
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden' })
  const sidebar = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
  if (await sidebar.isVisible()) await sidebar.click()
  await tab.click()
  await page.locator('.wfr-view').waitFor({ state: 'visible' })
  return page
}
async function publish(page, questions, mode = 'normal') {
  return page.evaluate(({ sessionId, questions, mode }) => {
    const bridge = window.__manualUiReplay
    if (bridge.remove) bridge.remove()
    const pending = new bridge.PendingQuestion(sessionId, questions)
    const receipt = { id: questions[0].id, key: pending.key, dispatches: 0, mode }
    const original = pending.answer.bind(pending)
    pending.answer = async answer => {
      receipt.dispatches++
      if (mode === 'error' && receipt.dispatches === 1) throw new Error('界面回放：旧请求已失效，请重新核对')
      if (mode === 'deferred') return new Promise(() => {})
      return original(answer)
    }
    const remove = bridge.publish(pending, async () => { pending.cancel().catch(() => {}) })
    bridge.remove = remove
    bridge.receipts.push(receipt)
    bridge.pending.push(pending)
    pending.result.then(value => { receipt.answer = value; remove() }, error => { receipt.error = error.code ?? error.message; remove() })
    return pending.key
  }, { sessionId, questions, mode })
}
async function geometry(page, target, name) {
  // Native responsive layout updates on resize; measure after layout, not between frames.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const layout = await page.locator(target).evaluate(root => {
    const rect = root.getBoundingClientRect()
    const buttons = [...root.querySelectorAll('button')].map(button => {
      const r = button.getBoundingClientRect()
      return { label: button.textContent, x: r.x, right: r.right, top: r.top, bottom: r.bottom }
    })
    const style = getComputedStyle(root)
    const tokens = [...new Set(document.querySelector('#workflow-agent-runtime-style').textContent.match(/--dsw?-[\w-]+/g))]
    return { x: rect.x, right: rect.right, width: rect.width, viewport: innerWidth, height: innerHeight,
      scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
      overflow: root.scrollWidth > root.clientWidth, missingTokens: tokens.filter(token => !style.getPropertyValue(token).trim()),
      overflowingChildren: [...root.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > rect.right + 1).slice(0, 8).map(node => ({ tag: node.tagName, className: typeof node.className === 'string' ? node.className : '', right: node.getBoundingClientRect().right })),
      pluginInputs: root.querySelectorAll('input,textarea,[contenteditable=true]').length, buttons }
  })
  await writeFile(join(output, `${name}-geometry.json`), JSON.stringify(layout, null, 2) + '\n')
  assert.equal(layout.overflow, false)
  assert.equal(layout.pluginInputs, 0)
  assert.deepEqual(layout.missingTokens, [])
  assert.ok(layout.x >= 0 && layout.right <= layout.viewport + 1)
  if (target.includes('recovery-card')) for (const button of layout.buttons) {
    assert.ok(button.x >= 0 && button.right <= layout.viewport && button.top >= 0 && button.bottom <= layout.height, button.label)
  }
  checks.push({ name, ...layout })
  return layout
}
async function top(page) {
  await page.locator('.wfr-view').evaluate(node => {
    for (let parent = node; parent; parent = parent.parentElement) if (parent.scrollHeight > parent.clientHeight) parent.scrollTop = 0
  })
}
try {
  const page = await open(saved.after)
  for (const width of [1440, 540, 390]) for (const scheme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1050 })
    await page.evaluate(scheme => document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark'), scheme)
    await top(page)
    await page.waitForFunction(() => document.querySelector('.wfr-status[data-placement=header]')?.textContent === '人工结束')
    assert.equal(await page.locator('.wfr-view .wfr-status').innerText(), '人工结束')
    assert.equal(await page.locator('.wfr-status [data-state=done]').count(), 0)
    assert.equal(await page.locator('.wfr-verification-detail').count(), 0, 'records start folded')
    const agentCopy = await page.locator('.wfr-agents').innerText()
    for (const check of record.checks) for (const item of check.evidence) assert.equal(agentCopy.includes(item.observation), false)
    assert.equal((await page.locator('.wfr-orientation').innerText()).includes(record.reason), false)
    await geometry(page, '.wfr-view', `closed-${width}-${scheme}`)
    await page.screenshot({ path: join(output, `closed-${width}-${scheme}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1050 })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.getByRole('button', { name: '人工处置记录', exact: true }).click()
  assert.ok((await page.locator('.wfr-manual-record').innerText()).includes(record.reason))
  for (const row of await page.locator('.wfr-verification-disclosure [data-disclosure-row]').all()) await row.click()
  const evidenceText = await page.locator('.wfr-agents').innerText()
  for (const check of record.checks) for (const item of check.evidence) {
    assert.ok(evidenceText.includes(item.source)); assert.ok(evidenceText.includes(item.observation))
  }
  await page.locator('.wfr-verification-disclosure').first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'closed-evidence-expanded.png'), fullPage: true })
  await page.close()

  const gatePage = await open(saved.before)
  await gatePage.waitForFunction(() => document.querySelector('.wfr-status[data-placement=header]')?.textContent === '待人工处置')
  await publish(gatePage, [question])
  const card = gatePage.locator('.wfr-recovery-card')
  await card.waitFor({ state: 'visible' })
  assert.equal(await card.locator('header strong').innerText(), '人工处置')
  assert.equal(await card.locator('.wfr-requirements-question').innerText(), question.question)
  assert.equal(await card.getByRole('button', { name: '确认执行', exact: true }).count(), 0)
  assert.equal(await card.locator('.wfr-recovery-evidence').count(), 0)
  assert.match(await card.innerText(), /不停止进程、不撤销文件、不续跑/)
  await geometry(gatePage, '.wfr-recovery-card', 'manual-gate-folded')
  await gatePage.screenshot({ path: join(output, 'manual-gate-folded.png'), fullPage: true })
  await card.getByRole('button', { name: '核实陈述与处置范围', exact: true }).click()
  const detailText = await card.locator('.wfr-recovery-evidence').innerText()
  for (const check of record.checks) for (const item of check.evidence) assert.ok(detailText.includes(item.observation))
  await geometry(gatePage, '.wfr-recovery-card', 'manual-gate-expanded')
  await gatePage.screenshot({ path: join(output, 'manual-gate-expanded.png'), fullPage: true })
  await card.getByRole('button', { name: '保持阻塞', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  let receipts = await gatePage.evaluate(() => window.__manualUiReplay.receipts)
  assert.deepEqual(receipts.at(-1).answer, { answers: [{ id: question.id, selected: [KEEP_UNKNOWN_LABEL] }] })

  await publish(gatePage, [{ ...question, id: 'ui-error-retry' }], 'error')
  await card.getByRole('button', { name: '人工结束本轮', exact: true }).click()
  await card.getByRole('alert').waitFor({ state: 'visible' })
  assert.equal(await card.getByRole('button', { name: '人工结束本轮', exact: true }).isEnabled(), true)
  await card.getByRole('button', { name: '人工结束本轮', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  receipts = await gatePage.evaluate(() => window.__manualUiReplay.receipts)
  assert.deepEqual(receipts.at(-1).answer, { answers: [{ id: 'ui-error-retry', selected: [MANUAL_CLOSE_LABEL] }] })
  assert.equal(receipts.at(-1).dispatches, 2)

  await publish(gatePage, [{ ...question, id: 'ui-double-click' }], 'deferred')
  await card.waitFor({ state: 'visible' })
  await card.getByRole('button', { name: '核实陈述与处置范围', exact: true }).click()
  await card.getByRole('button', { name: '人工结束本轮', exact: true }).evaluate(button => { button.click(); button.click() })
  await gatePage.waitForFunction(() => window.__manualUiReplay.receipts.at(-1).dispatches === 1)
  await publish(gatePage, [{ ...question, id: 'ui-replacement' }])
  await gatePage.waitForFunction(() => !document.querySelector('.wfr-recovery-card button:last-child')?.disabled)
  assert.equal(await card.locator('.wfr-recovery-evidence').count(), 0)
  await gatePage.evaluate(() => window.__manualUiReplay.pending.find(pending => pending.questions[0].id === 'ui-double-click').cancel())
  assert.equal(await card.getByRole('button', { name: '人工结束本轮', exact: true }).isEnabled(), true, 'late old settlement cannot withdraw the replacement')
  await card.getByRole('button', { name: '返回对话', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  receipts = await gatePage.evaluate(() => window.__manualUiReplay.receipts)
  assert.equal(receipts.at(-1).error, 'ASK_CANCELLED')
  assert.equal(await gatePage.locator('textarea,[contenteditable=true]').count(), 1, 'only native composer returns')

  // Large content and inert evidence; all text remains available in the scroll area.
  const longQuestion = { ...question, id: 'ui-long-content', detail: `${question.detail}\n\n${Array.from({ length: 20 }, (_, i) => `**范围 ${i + 1}**\n\n${'完整核实陈述，不是自动退出凭证。'.repeat(100)}`).join('\n\n')}\n\n末尾核实记录-END` }
  await publish(gatePage, [longQuestion])
  for (const width of [540, 390]) for (const scheme of ['light', 'dark']) {
    await gatePage.setViewportSize({ width, height: 844 })
    await gatePage.evaluate(scheme => document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark'), scheme)
    const disclosure = card.getByRole('button', { name: '核实陈述与处置范围', exact: true })
    if (await disclosure.getAttribute('aria-expanded') === 'true') await disclosure.click()
    await geometry(gatePage, '.wfr-recovery-card', `long-folded-${width}-${scheme}`)
    await disclosure.press('Enter')
    assert.ok((await card.locator('.wfr-recovery-evidence').innerText()).endsWith('末尾核实记录-END'))
    await card.locator('.wfr-recovery-body').evaluate(node => { node.scrollTop = node.scrollHeight })
    await geometry(gatePage, '.wfr-recovery-card', `long-expanded-${width}-${scheme}`)
    await gatePage.screenshot({ path: join(output, `long-${width}-${scheme}.png`), fullPage: true })
    await card.locator('.wfr-recovery-body').evaluate(node => { node.scrollTop = 0 })
  }
  await gatePage.setViewportSize({ width: 1440, height: 1050 })
  const generic = { ...question, id: 'ui-generic-plan', header: '普通计划', question: '普通计划是否执行？',
    intent: { kind: 'plan-review', approve: '确认此计划' }, options: [{ label: '暂不执行' }, { label: '确认此计划' }] }
  await publish(gatePage, [generic])
  await card.waitFor({ state: 'hidden' })
  const genericPanel = gatePage.getByRole('region', { name: generic.question, exact: true })
  await genericPanel.waitFor({ state: 'visible' })
  assert.equal(await genericPanel.getByRole('button', { name: '确认执行', exact: true }).count(), 1)
  const firstGate = { ...generic, id: 'ui-requirements', intent: { kind: 'plan-review', approve: REQUIREMENTS_CONFIRM_LABEL }, options: [{ label: REQUIREMENTS_CONFIRM_LABEL }] }
  await publish(gatePage, [firstGate])
  await gatePage.locator('[data-requirements-gate-key]').waitFor({ state: 'visible' })
  assert.equal(await card.count(), 0)
  await gatePage.evaluate(() => window.__manualUiReplay.remove())
  await gatePage.locator('[data-requirements-gate-key]').waitFor({ state: 'hidden' })
  const decisions = await gatePage.evaluate(() => window.__manualUiReplay.receipts)
  checks.push({ name: 'native-pending-integration', decisions, firstGateUnaffected: true, ordinaryPlanUnaffected: true })
  await gatePage.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(blockedWrites, [])
  assert.equal(servedCandidate, 2)
  assert.equal(officialBridges, 2)
  const result = { checkedAt: new Date().toISOString(), status: 'passed', scope: 'Real DSH native renderer and official PendingQuestion; saved-record presentation replay; answers are local-only, not sent to Host.',
    servedCandidate, officialBridges, errors, blockedWrites, checks }
  await writeFile(join(output, 'report.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ status: result.status, checks: checks.length, servedCandidate, officialBridges, hostActions: 0 }))
} catch (error) {
  for (const [i, page] of browser.contexts().flatMap(c => c.pages()).entries()) {
    await page.screenshot({ path: join(output, `failure-${i}.png`), fullPage: true }).catch(() => {})
    await writeFile(join(output, `failure-${i}.txt`), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally { await browser.close() }
