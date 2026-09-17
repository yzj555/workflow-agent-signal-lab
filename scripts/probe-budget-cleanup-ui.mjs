/** Official DSH renderer/PendingQuestion, local presentation replay only. No Host decisions. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { budgetQuestion } from '../lib/workflow-budget-recovery.js'
import { workflowSnapshotSchema } from '../lib/workflow-journal.js'

const [coreRoot, launchLog, outputRoot] = process.argv.slice(2)
assert.ok(coreRoot && launchLog && outputRoot)
const output = resolve(outputRoot)
await mkdir(output)
const old = '.dsh/activation/workflow-budget-online-20260916'
const saved = {}
for (const name of ['resumed-blocked', 'topup-pending', 'topup-waiting', 'end-approved', 'ended-after-restore']) {
  saved[name] = JSON.parse(await readFile(join(old, name + '.json'), 'utf8'))
}
const sessionId = saved['topup-pending'].testId, title = saved['topup-pending'].testTitle
const candidate = (await readFile('lib/client.js', 'utf8')).replace(/\r\n/g, '\n').split('//# sourceMappingURL=')[0].trim()
const url = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const { chromium } = await import(pathToFileURL(join(resolve(coreRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const browser = await chromium.launch({ headless: true })
const errors = [], blockedWrites = [], checks = []
let servedCandidate = 0, officialBridges = 0
async function open(snapshot) {
  workflowSnapshotSchema.parse(snapshot)
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) {
      const method = path.slice(5).replaceAll('.', '/')
      if (/^(respond|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(run|execute))$/.test(method)) {
        blockedWrites.push(method); return route.abort('blockedbyclient')
      }
    }
    if (path === '/workflow-runtime/snapshot') {
      const rpc = request.postDataJSON()
      if (rpc.payload.rootSessionId !== sessionId) return route.continue()
      const value = structuredClone(snapshot)
      value.run.title = `【只读回放 · 非当前运行】${value.run.title}`
      return route.fulfill({ json: { type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } } })
    }
    if (request.resourceType() === 'script' && new URL(request.url()).origin === 'http://127.0.0.1:3080') {
      const response = await route.fetch(), body = await response.text()
      if (body.includes('id: "@local/workflow-agent-signal-lab"')) {
        assert.ok(body.replace(/\r\n/g, '\n').includes(candidate), 'DSH must serve the candidate build, not an injected replacement')
        servedCandidate++
      }
      const hook = 'const registerPendingInteraction = ctx.uiSession.registerPendingInteraction((pending) => pending.kind === "plan-review" ? 2 : 1);'
      if (body.includes(hook)) {
        assert.equal(body.split(hook).length, 2); officialBridges++
        return route.fulfill({ response, body: body.replace(hook, `${hook}\nwindow.__budgetReplay = { PendingQuestion, publish: registerPendingInteraction, receipts: [], pending: [] };`) })
      }
      return route.fulfill({ response, body })
    }
    return route.continue()
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { throw new Error('Authenticated local DSH navigation failed (URL redacted)') })
  await page.waitForFunction(() => !!window.__budgetReplay)
  const selected = page.getByText(title, { exact: true })
  if (!await selected.isVisible().catch(() => false)) {
    const sidebar = page.getByTitle('侧边对话(beta)', { exact: true })
    if (await sidebar.isVisible().catch(() => false)) await sidebar.click()
  }
  if (!await selected.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '搜索会话', exact: true }).click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(title)
  }
  await selected.waitFor({ state: 'visible' })
  assert.equal(await selected.count(), 1)
  await selected.click()
  await page.getByRole('tab', { name: '工作流', exact: true }).waitFor({ state: 'visible' })
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden' })
  const sidebar = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
  if (await sidebar.isVisible()) await sidebar.click()
  await page.getByRole('tab', { name: '工作流', exact: true }).click()
  await page.locator('.wfr-view').waitFor({ state: 'visible' })
  return page
}
async function geometry(page, selector, name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const result = await page.locator(selector).evaluate(root => {
    const bounds = root.getBoundingClientRect(), style = getComputedStyle(root)
    const tokens = [...new Set(document.querySelector('#workflow-agent-runtime-style').textContent.match(/--dsw?-[\w-]+/g))]
    return { x: bounds.x, right: bounds.right, viewport: innerWidth, height: innerHeight,
      overflow: root.scrollWidth > root.clientWidth, pluginInputs: root.querySelectorAll('input,textarea,[contenteditable=true]').length,
      missingTokens: tokens.filter(token => !style.getPropertyValue(token).trim()),
      buttons: [...root.querySelectorAll('footer button')].map(button => {
        const r = button.getBoundingClientRect(); return { label: button.textContent, x: r.x, right: r.right, top: r.top, bottom: r.bottom }
      }) }
  })
  assert.equal(result.overflow, false); assert.equal(result.pluginInputs, 0)
  assert.deepEqual(result.missingTokens, [])
  assert.ok(result.x >= 0 && result.right <= result.viewport + 1)
  for (const button of result.buttons) assert.ok(button.x >= 0 && button.right <= result.viewport + 1 && button.top >= 0 && button.bottom <= result.height, button.label)
  checks.push({ name, ...result })
}
async function publish(page, question, mode = 'normal') {
  await page.evaluate(({ sessionId, question, mode }) => {
    const bridge = window.__budgetReplay
    bridge.remove?.()
    const pending = new bridge.PendingQuestion(sessionId, [question])
    const receipt = { id: question.id, key: pending.key, dispatches: 0 }
    const answer = pending.answer.bind(pending)
    pending.answer = async value => {
      receipt.dispatches++
      if (mode === 'error' && receipt.dispatches === 1) throw new Error('回放：请求已失效，请重新核对')
      if (mode === 'deferred') return new Promise((_, reject) => { receipt.reject = reject })
      return answer(value)
    }
    const remove = bridge.publish(pending, async () => { pending.cancel().catch(() => {}) })
    bridge.remove = remove; bridge.receipts.push(receipt); bridge.pending.push(pending)
    pending.result.then(value => { receipt.answer = value; remove() }, error => { receipt.error = error.code ?? error.message; remove() })
  }, { sessionId, question, mode })
}
try {
  const timed = structuredClone(saved['resumed-blocked'].after.snapshot)
  // Explicit synthetic fixture derived from a saved record, never served to the Host.
  timed.run.budget.blocked.resource = 'active-time'
  timed.run.budget.time.observedMs = timed.run.budget.limits.activeMs - timed.run.budget.time.uncertainMs
  timed.run.budget.time.reservedMs = 0; timed.run.budget.time.ownerId = null
  const endPending = structuredClone(saved['end-approved'].before.snapshot)
  const endRequest = structuredClone(saved['end-approved'].after.snapshot.run.budget.recovery.requests.at(-1))
  endRequest.status = 'pending'; delete endRequest.decisionAudit; delete endRequest.settledAt
  endPending.run.budget.recovery.requests.push(endRequest)
  for (const [name, snapshot, badge] of [
    ['exhausted', saved['resumed-blocked'].after.snapshot, '预算耗尽'],
    ['time-exhausted-synthetic', timed, '时长预算耗尽'],
    ['topup-pending', saved['topup-pending'].after.snapshot, '待补额确认'],
    ['awaiting-resume', saved['topup-waiting'].after.snapshot, '等待继续'],
    ['end-pending-synthetic', endPending, '待结束确认'],
    ['ended', saved['ended-after-restore'].after.snapshot, '已取消'],
  ]) {
    const page = await open(snapshot)
    await page.waitForFunction(badge => document.querySelector('.wfr-status[data-placement=header]')?.textContent === badge, badge)
    assert.equal(await page.locator('.wfr-view .wfr-status').innerText(), badge)
    if (name === 'ended') {
      assert.doesNotMatch(await page.locator('.wfr-orientation').innerText(), /正在整理|待沉淀/)
      assert.match(await page.locator('.wfr-track').innerText(), /未整理/)
    }
    await geometry(page, '.wfr-view', name)
    await page.screenshot({ path: join(output, name + '.png'), fullPage: true })
    await page.close()
  }
  const gatePage = await open(saved['topup-pending'].after.snapshot)
  const topupAccount = saved['topup-pending'].after.snapshot.run.budget
  const topup = budgetQuestion(topupAccount, topupAccount.recovery.requests.at(-1))
  const end = budgetQuestion(endPending.run.budget, endRequest)
  const card = gatePage.locator('.wfr-budget-card')
  for (const [action, question, button] of [['topup', topup, '确认增加额度'], ['end', end, '确认结束本轮']]) {
    await publish(gatePage, question)
    await card.waitFor({ state: 'visible' })
    assert.equal(await card.locator('.wfr-requirements-question').innerText(), question.question)
    assert.equal(await card.getByRole('button', { name: '确认执行', exact: true }).count(), 0)
    assert.equal(await card.locator('table tbody tr').count(), 2)
    for (const width of [1440, 540, 390]) for (const scheme of ['light', 'dark']) {
      await gatePage.setViewportSize({ width, height: width === 1440 ? 1050 : 844 })
      await gatePage.evaluate(scheme => document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark'), scheme)
      await geometry(gatePage, '.wfr-budget-card', `${action}-${width}-${scheme}`)
      await gatePage.screenshot({ path: join(output, `${action}-${width}-${scheme}.png`), fullPage: true })
    }
    await card.getByRole('button', { name: button, exact: true }).click()
    await card.waitFor({ state: 'hidden' })
    const receipt = await gatePage.evaluate(() => window.__budgetReplay.receipts.at(-1))
    assert.deepEqual(receipt.answer, { answers: [{ id: question.id, selected: [question.intent.approve] }] })
  }
  await publish(gatePage, { ...topup, id: 'keep-paused' })
  await card.getByRole('button', { name: '保持暂停', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  assert.deepEqual((await gatePage.evaluate(() => window.__budgetReplay.receipts.at(-1))).answer,
    { answers: [{ id: 'keep-paused', selected: ['保持暂停'] }] })
  await publish(gatePage, { ...topup, id: 'retry' }, 'error')
  await card.getByRole('button', { name: '确认增加额度', exact: true }).click()
  await card.getByRole('alert').waitFor({ state: 'visible' })
  assert.equal(await card.getByRole('button', { name: '确认增加额度', exact: true }).isEnabled(), true)
  await card.getByRole('button', { name: '确认增加额度', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  assert.equal((await gatePage.evaluate(() => window.__budgetReplay.receipts.at(-1))).dispatches, 2)
  await publish(gatePage, { ...topup, id: 'double-click-old' }, 'deferred')
  await card.getByRole('button', { name: '确认增加额度', exact: true }).evaluate(button => { button.click(); button.click() })
  await gatePage.waitForFunction(() => window.__budgetReplay.receipts.at(-1).dispatches === 1)
  await publish(gatePage, { ...end, id: 'new-request' })
  await card.getByRole('button', { name: '确认结束本轮', exact: true }).waitFor({ state: 'visible' })
  await gatePage.evaluate(() => window.__budgetReplay.receipts.find(receipt => receipt.id === 'double-click-old').reject(new Error('late old failure')))
  assert.equal(await card.getByRole('alert').count(), 0)
  assert.equal(await card.getByRole('button', { name: '确认结束本轮', exact: true }).isEnabled(), true)
  await card.getByRole('button', { name: '返回对话', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  assert.equal((await gatePage.evaluate(() => window.__budgetReplay.receipts.at(-1))).error, 'ASK_CANCELLED')
  assert.equal(await gatePage.locator('textarea,[contenteditable=true]').count(), 1)
  const long = { ...topup, id: 'long-detail', detail: topup.detail + '\n\n' + ('补充依据与权限边界。'.repeat(100) + '\n\n').repeat(20) + '完整详情-END' }
  await publish(gatePage, long)
  await card.waitFor({ state: 'visible' })
  assert.ok((await card.locator('.wfr-budget-detail').innerText()).endsWith('完整详情-END'))
  await card.locator('.wfr-budget-body').evaluate(node => { node.scrollTop = node.scrollHeight })
  await geometry(gatePage, '.wfr-budget-card', 'long-detail-mobile')
  await gatePage.screenshot({ path: join(output, 'long-detail-mobile.png'), fullPage: true })
  const generic = { ...topup, id: 'ordinary-plan', header: '普通计划', question: '普通计划是否执行？',
    intent: { kind: 'plan-review', approve: '确认此计划' }, options: [{ label: '暂不执行' }, { label: '确认此计划' }] }
  await publish(gatePage, generic)
  await card.waitFor({ state: 'hidden' })
  await gatePage.getByRole('region', { name: generic.question, exact: true }).getByRole('button', { name: '确认执行', exact: true }).waitFor({ state: 'visible' })
  await gatePage.evaluate(() => window.__budgetReplay.remove())
  checks.push({ name: 'native-pending-lifecycle', decisions: await gatePage.evaluate(() => window.__budgetReplay.receipts.map(({ reject, ...r }) => r)),
    doubleClickGuard: true, retry: true, lateErrorIsolation: true, nativeInputRestored: true, genericUnaffected: true })
  await gatePage.close()
  assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, [])
  assert.equal(servedCandidate, 7); assert.equal(officialBridges, 7)
  await writeFile(join(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), status: 'passed',
    scope: 'Official native renderer and PendingQuestion with client-only saved/synthetic fixtures; no Host approvals or model tasks.',
    servedCandidate, officialBridges, errors, blockedWrites, checks }, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, servedCandidate, officialBridges, hostActions: 0 }))
} catch (error) {
  for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
    await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {})
    await writeFile(join(output, `failure-${index}.txt`), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally { await browser.close() }
