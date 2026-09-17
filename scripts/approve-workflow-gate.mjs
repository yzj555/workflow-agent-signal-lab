/** Approve one exact Workflow Agent native gate and verify the Journal decision. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [sourceRoot, launchLog, sessionTitle, rootSessionId, action, expectedFile, reportFile] = process.argv.slice(2)
const recovery = ['runtime-recovery', 'runtime-recovery-keep'].includes(action)
const gateKind = recovery ? 'runtime-recovery' : action
const keeping = action === 'runtime-recovery-keep'
if (![sourceRoot, launchLog, sessionTitle, rootSessionId, gateKind, expectedFile, reportFile].every(Boolean)) {
  throw new Error('usage: node scripts/approve-workflow-gate.mjs <DSH source> <launch log> <Session title> <root Session id> <signal|execution> <expected JSON> <report file>')
}
assert.ok(['signal', 'execution', 'runtime-recovery'].includes(gateKind), 'unsupported gate kind')
if (recovery) assert.equal(rootSessionId, 'workflow-command-online-manual-recovery-20260915',
  'manual recovery automation is authorized only for this independent test')
const expected = JSON.parse(await readFile(expectedFile, 'utf8'))
assert.ok(Array.isArray(expected) && expected.every(item => typeof item === 'string'), 'expected JSON must be a string array')
const matches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(matches.length > 0, 'launch log does not contain a DSH web URL')
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

async function workflowSnapshot(page) {
  return page.evaluate(async rootSessionId => {
    const rpcId = crypto.randomUUID()
    const response = await fetch('/workflow-runtime/snapshot', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'snapshot', payload: { schemaVersion: 1, rootSessionId } }),
    })
    if (!response.ok) throw new Error(`snapshot returned HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope?.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('snapshot RPC failed')
    return envelope.result.value
  }, rootSessionId)
}

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
  const selector = gateKind === 'signal' ? '[data-requirements-gate-key]' : '[data-plan-review-key]'
  let panel = page.locator(selector)
  if (!await panel.isVisible().catch(() => false)) {
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
    panel = page.locator(selector)
  }
  await panel.waitFor({ state: 'visible', timeout: 20_000 })
  const approvedText = (await panel.innerText()).replace(/\s+/gu, ' ').trim()
  const accessibleQuestion = await panel.locator('section').getAttribute('aria-label')
  for (const phrase of expected) assert.ok(`${accessibleQuestion ?? ''} ${approvedText}`.includes(phrase), `gate is missing: ${phrase}; card=${approvedText}`)
  const before = await workflowSnapshot(page)
  const gate = before.run?.gates.find(item => item.kind === gateKind && item.status === 'waiting' && !item.stale)
  assert.ok(gate, `no current waiting ${gateKind} gate`)
  if (rootSessionId === 'workflow-command-online-manual-recovery-20260915') {
    const plan = before.run.plan
    assert.equal(resolve(plan.workspaceRoot), resolve('F:/dsh/workflow-command-manual-recovery-fixture-20260915'))
    assert.deepEqual(plan.writeScopes, ['src'])
    for (const checks of [plan.engineeringChecks, plan.acceptanceChecks]) {
      assert.equal(checks.length, 1)
      assert.equal(checks[0].command, 'node --test tests/hang.test.cjs')
      assert.equal(checks[0].workdir, '.')
    }
    assert.ok(JSON.stringify(plan).includes('120000'))
    assert.ok(JSON.stringify(plan).includes('unknown'))
  }
  if (recovery) {
    assert.equal(before.run.outcome, null)
    assert.equal(resolve(before.run.plan.workspaceRoot), resolve('F:/dsh/workflow-command-manual-recovery-fixture-20260915'))
    assert.ok(before.run.agents.some(agent => agent.runtimeIssue?.status === 'unknown'))
    assert.equal(accessibleQuestion, '已核实旧执行停止及其影响，结束本轮吗？')
  }
  // Official 0.1.5-rc.1 PlanReviewPanel.tsx renders localized generic labels,
  // while its handlers return review.approve/decline.label verbatim.
  // Record this UI mismatch; do not pretend the intended labels are visible.
  const buttonLabel = recovery
    ? keeping ? '拒绝' : '确认执行'
    : gateKind === 'signal' ? '确认理解并开始只读规划' : '确认执行'
  const confirm = panel.getByRole('button', { name: buttonLabel, exact: true })
  assert.equal(await confirm.count(), 1)
  if (recovery) assert.equal(await confirm.getAttribute('title'), keeping
    ? '保留未确认停止，不产生结束结论。' : '记录本次核实与处置决定，不声称 Host 已证实进程退出。')
  const stem = resolve(reportFile).replace(/\.json$/u, '')
  await mkdir(dirname(resolve(reportFile)), { recursive: true })
  await page.screenshot({ path: `${stem}-before.png`, fullPage: true, animations: 'disabled' })
  await confirm.click()
  await panel.waitFor({ state: 'hidden', timeout: 20_000 })
  let after
  const deadline = Date.now() + 20_000
  do {
    after = await workflowSnapshot(page)
    if (after.run?.gates.some(item => item.gateId === gate.gateId && item.status === (keeping ? 'rejected' : 'approved'))) break
    await page.waitForTimeout(250)
  } while (Date.now() < deadline)
  const approvedGate = after.run?.gates.find(item => item.gateId === gate.gateId)
  assert.equal(approvedGate?.status, keeping ? 'rejected' : 'approved')
  assert.ok(after.revision > before.revision)
  if (recovery) {
    assert.equal(after.run.outcome, keeping ? null : 'ABANDONED')
    assert.deepEqual(after.run.agents, before.run.agents, 'manual decision must not rewrite Agent evidence')
    assert.deepEqual(after.run.tasks, before.run.tasks, 'manual decision must not complete unfinished tasks')
    assert.deepEqual(after.run.ledger, before.run.ledger, 'manual decision must not manufacture acceptance')
    if (!keeping) assert.equal(after.run.manualClose.hostExitVerified, false)
  }
  await page.screenshot({ path: `${stem}-after.png`, fullPage: true, animations: 'disabled' })
  const report = {
    approvedAt: new Date().toISOString(),
    sessionTitle,
    rootSessionId,
    gateKind,
    action,
    gateId: gate.gateId,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    approvedStatus: approvedGate.status,
    operator: approvedGate.decisionAudit?.operator ?? 'unverified',
    approvedText,
    accessibleQuestion,
    displayedButtonLabel: buttonLabel,
    ...(recovery ? { expectedAnswerLabel: keeping ? '尚未核实，保持阻塞' : '已核实停止及影响，人工结束本轮',
      uiIssue: 'Official plan-review hides question in aria-label and substitutes generic plan/execute labels; usability not passed.' } : {}),
    observedPostPaths: [...new Set(observedPostPaths)],
    ...(recovery ? { before, after } : {}),
  }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, approvedText: '[recorded in evidence file]',
    ...(recovery ? { before: '[recorded]', after: '[recorded]' } : {}) }, null, 2))
} finally {
  await browser.close()
}
