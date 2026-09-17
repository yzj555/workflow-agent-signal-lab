/** Read-only verification of the native workflow plan surface on real DSH. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, outputDirectory, sessionTitle, sessionId, viewMode = 'actual'] = process.argv.slice(2)
if (!sourceRoot || !outputDirectory || !sessionTitle || !sessionId) {
  throw new Error('usage: node scripts/probe-layered-plan-ui.mjs <DSH source> <evidence directory> <session title> <session id> [actual|layered-simulation]')
}
assert.ok(['actual', 'layered-simulation'].includes(viewMode))
const target = new URL('http://127.0.0.1:3080/')
const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const evidenceDirectory = resolve(outputDirectory)
await mkdir(evidenceDirectory, { recursive: true })

function asLayeredSimulation(envelope) {
  if (viewMode !== 'layered-simulation') return envelope
  const result = structuredClone(envelope)
  const run = result.result?.value?.run
  if (!run?.plan) throw new Error('layered visual simulation requires an existing project plan')
  if (run.gates.some(gate => gate.gateId === 'visual-execution')) return result
  run.title = '复杂工程变更 · 分层确认视觉样例'
  run.stage = 'planning'
  run.needsUser = true
  run.tasks.unshift({
    taskId: 'architecture', version: 1, title: '核对跨模块影响并形成执行方案', stage: 'planning', role: 'architect',
    status: 'completed', reason: '只读方案已形成', dependsOn: [], stale: false,
  })
  run.gates.push({
    gateId: 'visual-requirements', kind: 'signal', stage: 'requirements', summary: '需求理解已确认，只允许只读规划',
    status: 'approved', requiredActor: 'user', scopeTaskIds: ['architecture'], stale: false,
  }, {
    gateId: 'visual-execution', kind: 'execution', stage: 'planning', summary: '方案已形成，请确认执行范围与检查',
    status: 'waiting', requiredActor: 'user', scopeTaskIds: ['implementation', 'engineering-test', 'code-review', 'acceptance'], stale: false,
  })
  run.plan.confirmationMode = 'layered'
  run.plan.tasks.unshift({
    taskId: 'architecture', version: 1, title: '核对跨模块影响并形成执行方案', stage: 'planning', role: 'architect',
    dependsOn: [], allowedActions: ['读取工作区源码', '检索工程结构', '提交方案与回滚路径'],
    forbiddenActions: ['改写文件', 'Shell', '网络', '进程操作', '委派', '批准门禁'], writeScopes: [],
  })
  run.plan.design = {
    version: 1,
    summary: '沿用现有构建入口，在脚本边界内增加提示，不改变运行、验收或依赖方向。',
    decisions: [{ id: 'ADR-1', decision: '保持现有入口与模块边界', rationale: '把影响限制在已确认的单一脚本中' }],
    affectedAreas: ['scripts/build.ps1', '构建输出契约'], interfaces: ['npm run build'],
    rollback: ['恢复 scripts/build.ps1 的执行授权前检查点'],
  }
  return result
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  const errors = []
  const forbiddenRequests = []
  await page.route('**/workflow-runtime/snapshot', async route => {
    const response = await route.fetch()
    const envelope = asLayeredSimulation(await response.json())
    await route.fulfill({ response, json: envelope })
  })
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
    const conversationSidebar = page.getByTitle('侧边对话(beta)', { exact: true })
    if (await conversationSidebar.isVisible().catch(() => false)) await conversationSidebar.click()
  }
  await session.waitFor({ state: 'visible', timeout: 20_000 })
  await session.click()
  const workflowTab = page.getByRole('tab', { name: '工作流', exact: true })
  await workflowTab.waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 15_000 })
  const fileSidebarToggle = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
  if (await fileSidebarToggle.isVisible()) await fileSidebarToggle.click()
  await workflowTab.click()
  const view = page.locator('.wfr-view')
  await view.waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('计划与授权', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(evidenceDirectory, `${viewMode}-collapsed-plan.png`), fullPage: true, animations: 'disabled' })
  const fullPlanToggle = page.getByText('完整计划', { exact: true })
  await fullPlanToggle.click()
  await page.locator('.wfr-plan-detail').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(evidenceDirectory, `${viewMode}-expanded-plan.png`), fullPage: true, animations: 'disabled' })

  const rpcId = randomUUID()
  const response = await page.request.post(new URL('/workflow-runtime/snapshot', target.origin).href, {
    data: { type: 'client-request', rpcId, method: 'snapshot', payload: { schemaVersion: 1, rootSessionId: sessionId } },
  })
  const envelope = asLayeredSimulation(await response.json())
  assert.equal(response.status(), 200)
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true)
  const run = envelope.result.value.run
  assert.ok(run?.plan)

  const details = await page.evaluate(() => {
    const workflow = document.querySelector('.wfr-view')
    const plan = document.querySelector('.wfr-plan-detail')
    return {
      workflowStyles: document.querySelectorAll('style[data-plugin="@local/workflow-agent-signal-lab"]').length,
      workflowInputCount: document.querySelectorAll('.wfr-view textarea, .wfr-view input, .wfr-view [contenteditable="true"]').length,
      nativeInputCount: document.querySelectorAll('textarea, [contenteditable="true"]').length,
      horizontalOverflow: workflow ? workflow.scrollWidth > workflow.clientWidth : null,
      planHorizontalOverflow: plan ? plan.scrollWidth > plan.clientWidth : null,
      planMode: document.querySelector('.wfr-plan-section .wfr-section-heading span')?.textContent?.trim() ?? null,
      milestones: [...document.querySelectorAll('.wfr-plan-milestone')].map(item => ({
        label: item.querySelector('strong')?.textContent?.trim() ?? '',
        status: item.querySelector('em')?.textContent?.trim() ?? '',
        tone: item.getAttribute('data-tone'),
      })),
      taskRows: document.querySelectorAll('.wfr-plan-tasks > li').length,
      checkRows: document.querySelectorAll('.wfr-plan-checks > li').length,
      planText: plan?.textContent ?? '',
    }
  })
  const report = { checkedAt: new Date().toISOString(), readonly: true, viewMode, details, errors, forbiddenRequests,
    rpc: { revision: envelope.result.value.revision, runId: run.runId, plan: run.plan } }
  await writeFile(join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ checkedAt: report.checkedAt, ...details, planText: undefined,
    planTextLength: details.planText.length, errors, forbiddenRequests,
    rpc: { revision: report.rpc.revision, runId: report.rpc.runId, mode: run.plan.confirmationMode,
      tasks: run.plan.tasks.length, criteria: run.plan.criteria.length } }, null, 2))

  assert.equal(errors.length, 0)
  assert.equal(forbiddenRequests.length, 0)
  assert.equal(details.workflowStyles, 1)
  assert.equal(details.workflowInputCount, 0)
  assert.equal(details.nativeInputCount, 1)
  assert.equal(details.horizontalOverflow, false)
  assert.equal(details.planHorizontalOverflow, false)
  assert.equal(details.taskRows, run.plan.tasks.length)
  assert.equal(details.checkRows, run.plan.criteria.length + run.plan.engineeringChecks.length + run.plan.acceptanceChecks.length)
  for (const heading of ['目标', '包含', '明确不做', '约束', '当前假设', '角色与依赖', '写入与权限边界', '验收标准', '工程检查', '独立黑盒检查']) {
    assert.ok(details.planText.includes(heading), `missing plan section: ${heading}`)
  }
} finally {
  await browser.close()
}
