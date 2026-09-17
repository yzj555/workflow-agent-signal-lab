/** Exact two-Session official Web driver. No direct Journal/Controller writes. */
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { base, cases, guard, checkConfig, records, sha } from './budget-live-matrix-records.mjs'

const [action, scenario, launchLog, label, promptFile] = process.argv.slice(2)
assert.ok(['create', 'inspect', 'prompt', 'approve-execution', 'end', 'approve-end', 'end-and-approve'].includes(action))
assert.ok(scenario in cases)
assert.match(label, /^[a-z][a-z0-9-]{0,60}$/u)
const target = cases[scenario], output = join(base, `${scenario}-${label}.json`)
assert.equal(await access(output).then(() => true, () => false), false, 'Evidence already exists')
await guard()
if (action !== 'inspect') await checkConfig(scenario)
const url = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
assert.equal(new URL(url).origin, 'http://127.0.0.1:3080')
const { chromium } = await import(pathToFileURL('F:/dsh/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs').href)
const browser = await chromium.launch({ headless: true })
const report = { action, scenario, sessionId: target.id, title: target.title, startedAt: new Date().toISOString(),
  operator: 'assistant-proxy under explicit test authorization; native audit remains unverified', mutations: [], errors: [] }
let armedQuestionKey = null, armedAnswer = null
const containsString = (value, wanted) => typeof value === 'string' ? value === wanted
  : value && typeof value === 'object' && Object.values(value).some(item => containsString(item, wanted))
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => report.errors.push(error.message))
  await page.route('**/api/**', route => {
    const request = route.request(), name = new URL(request.url()).pathname.slice(5).replaceAll('.', '/')
    if (/^(respond|\$events\/result|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt|interruptByParent)|agentPresets?\/(select|remove|copy|deletePreset)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(execute|run))$/u.test(name)) {
      const allowedNames = action === 'create' ? ['session/create', 'session/rename', 'session/prompt']
        : action === 'prompt' ? ['session/prompt'] : action === 'end-and-approve' ? ['commands/execute', 'respond', '$events/result'] : action === 'end' ? ['commands/execute']
        : action.startsWith('approve-') ? ['respond', '$events/result'] : []
      let body
      try { body = JSON.parse(request.postData() ?? '{}') } catch { body = {} }
      const answers = body.payload?.args?.outcome?.value?.answers
      const correctIdentity = name === 'respond' || name === '$events/result'
        ? armedAnswer && answers?.length === 1 && answers[0].id === armedAnswer.id
          && answers[0].selected?.length === 1 && answers[0].selected[0] === armedAnswer.label
        : containsString(body, target.id)
      const allowed = allowedNames.includes(name) && Boolean(correctIdentity)
      report.mutations.push({ name, allowed, body })
      if (!allowed) return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  assert.equal((await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })).status(), 200)
  async function rpc(method, args) {
    return page.evaluate(async ({ method, args }) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(method === 'snapshot' ? '/workflow-runtime/snapshot' : `/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: method === 'snapshot' ? args : { args } }),
        signal: AbortSignal.timeout(15000),
      })
      const envelope = await response.json()
      if (!response.ok || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw Error(`${method} rejected: ${JSON.stringify(envelope.result?.error ?? response.status)}`)
      return envelope.result.value
    }, { method, args })
  }
  async function inspect() {
    const listed = await rpc('session/list', { _request: {} })
    const session = listed.items.find(item => item.sessionId === target.id)
    assert.ok(session, 'Exact test Session is missing')
    const snapshot = await rpc('snapshot', { schemaVersion: 1, rootSessionId: target.id })
    assert.equal(snapshot.rootSessionId, target.id)
    const children = await rpc('subagents/list', { parentSessionId: target.id })
    const history = await rpc('session/page', { request: { address: { kind: 'session', sessionId: target.id },
      throughSeq: Math.max(-1, session.projections.asOfSeq - 1), maxMessages: 35 } })
    return { session, snapshot, children, history }
  }
  async function select() {
    await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20000 })
    let search = page.getByRole('button', { name: '搜索会话', exact: true })
    if (!await search.isVisible().catch(() => false)) {
      await page.locator('button[aria-label="展开侧边栏"],button[title="侧边对话(beta)"]').first().click()
      await search.waitFor({ state: 'visible', timeout: 20000 })
    }
    await search.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(target.title)
    await page.getByText(target.title, { exact: true }).first().click()
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 20000 })
  }
  async function settledSnapshot(check) {
    const deadline = Date.now() + 20000
    do {
      const snapshot = await rpc('snapshot', { schemaVersion: 1, rootSessionId: target.id })
      if (check(snapshot)) return snapshot
      await page.waitForTimeout(100)
    } while (Date.now() < deadline)
    throw Error('Native answer was not durably settled within the observation window')
  }
  async function prompt() {
    const file = resolve(promptFile)
    assert.ok(file.startsWith(base + '\\'))
    const text = (await readFile(file, 'utf8')).trim()
    assert.ok(text && !text.startsWith('/'))
    report.prompt = text
    report.accepted = await rpc('session/prompt', { request: { sessionId: target.id, requestId: crypto.randomUUID(), mode: 'queue',
      content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' } })
  }
  if (action === 'create') {
    const listed = await rpc('session/list', { _request: {} })
    assert.ok(!listed.items.some(item => item.sessionId === target.id))
    report.created = await rpc('session/create', { request: { sessionId: target.id, cwd: target.workspace, agentPreset: 'workflow-agent-signal-lab' } })
    assert.equal(report.created.sessionId, target.id)
    report.renamed = await rpc('session/rename', { request: { sessionId: target.id, title: target.title } })
    await prompt()
  } else {
    report.before = await inspect()
    await select()
    if (action === 'prompt') {
      assert.equal(report.before.session.running, false)
      assert.ok(!report.before.snapshot.run?.budget?.blocked, 'Cannot prompt execution past the budget gate')
      await prompt()
    }
    if (action === 'approve-execution') {
      const snapshot = await rpc('snapshot', { schemaVersion: 1, rootSessionId: target.id })
      const run = snapshot.run, plan = run?.plan
      assert.equal(run?.riskLevel, 'L1')
      assert.equal(run?.executionProfile, 'workflow-project-pilot/1')
      assert.equal(resolve(plan.workspaceRoot), resolve(target.workspace))
      assert.deepEqual(plan.writeScopes, ['src'])
      for (const checks of [plan.engineeringChecks, plan.acceptanceChecks]) {
        assert.equal(checks.length, 1)
        assert.equal(checks[0].command, 'node --test tests/budget.test.cjs')
        assert.equal(checks[0].workdir, '.')
      }
      assert.equal(run.budget.limits.commands, scenario === 'command' ? 1 : 40)
      assert.equal(run.budget.limits.activeMs, scenario === 'time' ? 120000 : undefined)
      assert.equal(run.budget.used.commands, 0)
      assert.equal(run.agents.length, 0)
      assert.equal(run.outcome, null)
      const gate = run.gates.find(item => item.kind === 'execution' && item.status === 'waiting' && !item.stale)
      assert.ok(gate)
      const panel = page.locator('[data-plan-review-key]')
      await panel.waitFor({ state: 'visible', timeout: 20000 })
      armedQuestionKey = await panel.getAttribute('data-plan-review-key')
      armedAnswer = { id: gate.gateId, label: '确认此版本并允许执行' }
      report.gate = { gateId: gate.gateId, snapshot, key: armedQuestionKey, text: await panel.innerText() }
      await page.screenshot({ path: join(base, `${scenario}-${label}-before.png`), fullPage: true })
      await guard()
      await panel.getByRole('button', { name: '确认执行', exact: true }).click()
      await panel.waitFor({ state: 'hidden', timeout: 20000 })
      const after = await settledSnapshot(value => value.run?.gates.some(item => item.gateId === gate.gateId && item.status === 'approved'))
      assert.equal(after.run.gates.find(item => item.gateId === gate.gateId)?.status, 'approved')
      report.decision = after
    }
    if (action === 'end' || action === 'end-and-approve') {
      assert.equal(report.before.session.running, false)
      assert.ok(report.before.snapshot.run?.budget?.blocked)
      assert.ok(report.before.snapshot.run.agents.every(agent => agent.status === 'idle' || agent.runtimeIssue?.status === 'stopped'), 'Test roles not all confirmed stopped')
      const composer = page.locator('[data-composer-input]').first()
      await composer.fill('/workflow-budget end')
      await composer.press('Enter')
      await page.locator('[data-budget-gate-key]').waitFor({ state: 'visible', timeout: 20000 })
    }
    if (action === 'approve-end' || action === 'end-and-approve') {
      const snapshot = await rpc('snapshot', { schemaVersion: 1, rootSessionId: target.id })
      const pending = snapshot.run?.budget?.recovery?.requests.filter(item => item.status === 'pending')
      assert.equal(pending?.length, 1)
      const request = pending[0]
      assert.equal(request.action, 'end')
      assert.equal(request.add.modelRequests, 0)
      assert.equal(request.add.commands, 0)
      assert.equal(request.add.activeMs ?? 0, 0)
      assert.equal(snapshot.run.outcome, null)
      assert.ok(snapshot.run.agents.every(agent => agent.status === 'idle' || agent.runtimeIssue?.status === 'stopped'))
      const panel = page.locator('[data-budget-gate-key]')
      await panel.waitFor({ state: 'visible', timeout: 20000 })
      assert.equal(await panel.locator('section').getAttribute('aria-label'), '是否结束本轮工作流？')
      armedQuestionKey = await panel.getAttribute('data-budget-gate-key')
      armedAnswer = { id: request.id, label: '确认结束本轮，不继续执行' }
      report.gate = { request, key: armedQuestionKey, text: await panel.innerText() }
      await page.screenshot({ path: join(base, `${scenario}-${label}-before.png`), fullPage: true })
      await guard()
      await panel.getByRole('button', { name: '确认结束本轮', exact: true }).click()
      await panel.waitFor({ state: 'hidden', timeout: 20000 })
      const after = await settledSnapshot(value => value.run?.budget?.recovery?.requests.some(item => item.id === request.id && item.status === 'approved'))
      assert.equal(after.run.budget.recovery.requests.find(item => item.id === request.id)?.status, 'approved')
      assert.equal(after.run.outcome, 'CANCELLED')
      assert.equal(after.run.budget.recovery.closed, true)
      assert.deepEqual(after.run.budget.used, snapshot.run.budget.used)
      report.decision = after
    }
    report.body = await page.locator('body').innerText()
    report.cards = await page.locator('[data-question-key],[data-plan-review-key],[data-budget-gate-key]').allTextContents()
    await page.screenshot({ path: join(base, `${scenario}-${label}.png`), fullPage: true })
    if (action === 'inspect') {
      await page.getByRole('tab', { name: '工作流', exact: true }).click()
      await page.locator('.wfr-view').waitFor({ state: 'visible', timeout: 20000 })
      await page.waitForFunction(() => {
        const text = document.querySelector('.wfr-view')?.textContent ?? ''
        return text.length > 0 && !/插件日志读取未完成|正在读取已保存的工作流/u.test(text)
      }, undefined, { timeout: 20000 })
      report.workflowBody = await page.locator('.wfr-view').innerText()
      await page.screenshot({ path: join(base, `${scenario}-${label}-workflow.png`), fullPage: true })
    }
  }
  report.after = await inspect()
  const checked = await guard()
  report.record = checked.testRecords[target.id] ?? null
  report.protectedRecords = checked.protectedRecords
  report.fixtureHashes = Object.fromEntries(await Promise.all(['README.md', '.gitignore', 'tests/budget.test.cjs'].map(async file => [file, sha(await readFile(join(target.workspace, file)))])))
  assert.equal(report.errors.length, 0, 'Browser page errors')
  assert.ok(report.mutations.every(item => item.allowed), 'Unexpected mutation was blocked')
  report.status = 'complete'
} catch (error) {
  report.status = 'failed'
  report.error = String(error).replaceAll(url, 'http://127.0.0.1:3080/[auth-redacted]')
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  await browser.close()
  const after = report.after, run = after?.snapshot.run
  console.log(JSON.stringify({ status: report.status, error: report.error, action, scenario, running: after?.session.running,
    revision: after?.snapshot.revision, stage: run?.stage, outcome: run?.outcome, budget: run?.budget,
    agents: run?.agents, cards: report.cards, protectedRecords: report.protectedRecords, output }, null, 2))
}
