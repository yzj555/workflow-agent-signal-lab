/** Real official DSH browser acceptance, limited to one authorized text-only Session. */
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { base, root, testId, testTitle, guard } from './budget-online-records.mjs'

const [action, launchLog, label, promptFile] = process.argv.slice(2)
assert.ok(['create', 'capture', 'prompt', 'approve-topup', 'end'].includes(action))
assert.match(label, /^[a-z0-9-]+$/u)
const output = join(base, `${label}.json`)
assert.equal(await access(output).then(() => true, () => false), false, 'receipt already exists')
await guard()
const url = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const { chromium } = await import(pathToFileURL('F:/dsh/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs').href)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  const errors = [], mutations = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/api/**', route => {
    const req = route.request(), name = new URL(req.url()).pathname.slice(5).replaceAll('.', '/')
    const mutation = /^(respond|\$events\/result|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(execute|run))$/u.test(name)
    if (mutation) {
      const allowed = action === 'create' ? ['session/create', 'session/rename'] : action === 'prompt' ? ['session/prompt']
        : action === 'approve-topup' ? ['respond', '$events/result'] : action === 'end' ? ['commands/execute', 'respond', '$events/result'] : []
      mutations.push({ name, allowed: allowed.includes(name) })
      if (!allowed.includes(name)) return route.abort('blockedbyclient')
      if (name.startsWith('session/')) assert.ok(req.postData()?.includes(testId), 'mutation addressed to wrong Session')
    }
    return route.continue()
  })
  assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded' })).status(), 200)
  async function rpc(method, args) {
    return page.evaluate(async ({ method, args }) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(method === 'snapshot' ? '/workflow-runtime/snapshot' : `/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: method === 'snapshot' ? args : { args } }),
        signal: AbortSignal.timeout(15000),
      })
      const e = await response.json()
      if (!response.ok || e.rpcId !== rpcId || !e.result?.ok) throw Error(JSON.stringify(e.result?.error ?? response.status))
      return e.result.value
    }, { method, args })
  }
  async function inspect() {
    const sessions = await rpc('session/list', { _request: {} }), session = sessions.items.find(x => x.sessionId === testId)
    assert.ok(session, 'test Session not found')
    const snapshot = await rpc('snapshot', { schemaVersion: 1, rootSessionId: testId })
    const children = await rpc('subagents/list', { parentSessionId: testId })
    assert.equal(children.entries.length, 0, 'this experiment must not dispatch child roles')
    const history = await rpc('session/page', { request: { address: { kind: 'session', sessionId: testId },
      throughSeq: Math.max(-1, session.projections.asOfSeq - 1), maxMessages: 100 } })
    return { session, snapshot, children, history }
  }
  async function selectTest() {
    await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20000 })
    let search = page.getByRole('button', { name: '搜索会话', exact: true })
    if (!await search.isVisible().catch(() => false)) {
      await page.locator('button[aria-label="展开侧边栏"],button[title="侧边对话(beta)"]').first().click()
      await search.waitFor({ state: 'visible', timeout: 20000 })
    }
    await search.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(testTitle)
    await page.getByText(testTitle, { exact: true }).first().click()
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 20000 })
  }
  const report = { action, testId, testTitle, startedAt: new Date().toISOString(), operator: 'assistant-proxy; native audit remains unverified' }
  if (action === 'create') {
    const list = await rpc('session/list', { _request: {} })
    assert.ok(!list.items.some(x => x.sessionId === testId))
    report.created = await rpc('session/create', { request: { cwd: root, sessionId: testId, agentPreset: 'workflow-agent-signal-lab' } })
    assert.equal(report.created.sessionId, testId)
    report.renamed = await rpc('session/rename', { request: { sessionId: testId, title: testTitle } })
  } else {
    report.before = await inspect()
    const blankFirstPrompt = action === 'prompt' && report.before.session.blank
    if (!blankFirstPrompt) await selectTest()
    if (action === 'prompt') {
      assert.equal(report.before.session.running, false)
      assert.ok(resolve(promptFile).startsWith(base + '\\') || resolve(promptFile).startsWith(base + '/'))
      const prompt = (await readFile(promptFile, 'utf8')).trim()
      assert.ok(prompt && !prompt.startsWith('/'))
      report.prompt = prompt
      if (blankFirstPrompt) {
        // The official search omits blank Sessions. Submit its first message
        // through the same native Session API, then navigate after engagement.
        report.accepted = await rpc('session/prompt', { request: { sessionId: testId,
          requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai' } })
        report.submissionSurface = 'official Session prompt API (blank Session omitted by search)'
      } else {
        const composer = page.locator('[data-composer-input]').first()
        const accepted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/prompt')
        await composer.fill(prompt)
        await composer.press('Enter')
        const envelope = await (await accepted).json()
        assert.equal(envelope.result?.ok, true)
        report.accepted = envelope.result.value
        report.submissionSurface = 'official native composer'
      }
    }
    if (action === 'approve-topup' || action === 'end') {
      if (action === 'end') {
        assert.equal(report.before.session.running, false)
        assert.ok(report.before.snapshot.run?.budget?.blocked)
        const composer = page.locator('[data-composer-input]').first()
        await composer.fill('/workflow-budget end')
        await composer.press('Enter')
      }
      const panel = page.locator('[data-plan-review-key]')
      await panel.waitFor({ state: 'visible', timeout: 20000 })
      const snapshot = await rpc('snapshot', { schemaVersion: 1, rootSessionId: testId })
      const budget = snapshot.run?.budget, pending = budget?.recovery?.requests.filter(x => x.status === 'pending')
      assert.equal(pending?.length, 1)
      const request = pending[0]
      assert.equal(request.action, action === 'end' ? 'end' : 'topup')
      assert.equal(request.add.modelRequests, action === 'end' ? 0 : 1)
      assert.equal(request.add.commands, 0)
      assert.equal(request.add.activeMs ?? 0, 0)
      assert.equal(snapshot.run.agents.length, 0)
      assert.equal(snapshot.run.outcome, null)
      const question = await panel.locator('section').getAttribute('aria-label')
      assert.equal(question, action === 'end' ? '是否结束本轮工作流？' : '是否增加本轮执行额度？')
      report.question = { question, text: await panel.innerText(), request, key: await panel.getAttribute('data-plan-review-key') }
      await page.screenshot({ path: join(base, `${label}-before.png`), fullPage: true })
      const confirm = panel.getByRole('button', { name: '确认执行', exact: true })
      assert.equal(await confirm.count(), 1)
      await guard()
      await confirm.click()
      await panel.waitFor({ state: 'hidden', timeout: 20000 })
      const after = await rpc('snapshot', { schemaVersion: 1, rootSessionId: testId })
      assert.equal(after.run.budget.recovery.requests.find(x => x.id === request.id)?.status, 'approved')
      assert.deepEqual(after.run.budget.used, budget.used)
      if (action === 'approve-topup') {
        assert.equal(after.run.budget.limits.modelRequests, budget.limits.modelRequests + 1)
        assert.equal(after.run.budget.recovery.awaitingResume, true)
        assert.equal(after.run.outcome, null)
      } else { assert.equal(after.run.outcome, 'CANCELLED'); assert.equal(after.run.budget.recovery.closed, true) }
      report.afterDecision = after
    }
    await page.screenshot({ path: join(base, `${label}.png`), fullPage: true, animations: 'disabled' })
    report.body = await page.locator('body').innerText()
    if (action === 'capture') {
      const tab = page.getByRole('tab', { name: '工作流', exact: true })
      await tab.click()
      await page.locator('.wfr-view').waitFor({ state: 'visible', timeout: 20000 })
      await page.waitForFunction(() => {
        const text = document.querySelector('.wfr-view')?.textContent ?? ''
        return text.length > 0 && !text.includes('插件日志读取未完成') && !text.includes('正在读取已保存的工作流')
      }, undefined, { timeout: 20000 })
      report.workflowBody = await page.locator('.wfr-view').innerText()
      await page.screenshot({ path: join(base, `${label}-workflow.png`), fullPage: true, animations: 'disabled' })
    }
  }
  report.after = await inspect()
  const checked = await guard()
  report.protectedRecords = checked.protectedRecords
  report.testRecord = checked.testRecord
  report.errors = errors; report.mutations = mutations; report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' })
  const s = report.after.snapshot
  console.log(JSON.stringify({ action, testId, running: report.after.session.running, revision: s.revision,
    outcome: s.run?.outcome, budget: s.run?.budget, protectedRecords: checked.protectedRecords, errors, output }, null, 2))
} finally { await browser.close() }
