/** Isolated browser presentation fixtures. Never sends prompts, approvals or runtime writes. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixture, memoryTable } from '../tests/helpers/workflow-fixture.mjs'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { controllerFixture } from '../tests/helpers/workflow-controller-fixture.mjs'

const [coreRoot, outputDirectory, sessionTitle, ...selectedNames] = process.argv.slice(2)
if (!coreRoot || !outputDirectory || !sessionTitle) throw new Error('usage: node scripts/probe-workflow-layout.mjs <DSH source> <evidence directory> <existing session title>')
const { chromium } = await import(pathToFileURL(join(resolve(coreRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const directory = resolve(outputDirectory)
await mkdir(directory, { recursive: true })
const variants = [
  { name: 'empty-narrow-light', width: 540, scheme: 'light', state: 'absent' },
  { name: 'gate-wide-light', width: 1440, scheme: 'light', state: 'gate' },
  { name: 'gate-narrow-dark', width: 540, scheme: 'dark', state: 'gate' },
  { name: 'running-medium-light', width: 980, scheme: 'light', state: 'running' },
  { name: 'failed-medium-dark', width: 980, scheme: 'dark', state: 'failed' },
  { name: 'qualified-medium-light', width: 980, scheme: 'light', state: 'qualified' },
  { name: 'text-pass-wide-light', width: 1440, scheme: 'light', state: 'text-pass' },
  { name: 'text-pass-narrow-dark', width: 540, scheme: 'dark', state: 'text-pass' },
  { name: 'text-pass-wide-dark', width: 1440, scheme: 'dark', state: 'text-pass' },
  { name: 'project-rollback-wide-light', width: 1440, scheme: 'light', state: 'project-rollback' },
  { name: 'project-rollback-narrow-dark', width: 540, scheme: 'dark', state: 'project-rollback' },
  { name: 'project-rollback-wide-dark', width: 1440, scheme: 'dark', state: 'project-rollback' },
  { name: 'project-rollback-pending-wide-light', width: 1440, scheme: 'light', state: 'project-rollback-pending' },
]

let textSnapshot
async function textPresentation(rootSessionId) {
  if (!textSnapshot) {
    const dispose = []
    const f = await controllerFixture({ after: callback => dispose.push(callback) })
    try {
      await f.setup(); await f.author('测试功能已就绪'); await f.qa(true); await f.advance()
      textSnapshot = f.snapshot()
    } finally { for (const callback of dispose) await callback() }
  }
  const snapshot = structuredClone(textSnapshot)
  snapshot.rootSessionId = rootSessionId
  snapshot.run.title = '【界面测试数据】完整结束后的阶段标识'
  return snapshot
}

function rollbackPresentation(rootSessionId) {
  const tasks = [
    ['implementation', '在确认范围内实现工程变更', 'implementation', 'engineer'],
    ['engineering-test', '执行源码可见的工程验证', 'verification', 'test_engineer'],
    ['code-review', '独立审查当前代码变更', 'review', 'code_reviewer'],
    ['acceptance', '在模型侧源码隔离下执行独立黑盒验收', 'review', 'acceptance_qa'],
  ].map(([taskId, title, stage, role], index) => ({
    taskId, version: 1, title, stage, role, status: 'completed', reason: '界面测试记录',
    dependsOn: index === 0 ? [] : index < 3 ? ['implementation'] : ['engineering-test', 'code-review'],
    stale: false,
  }))
  return {
    schemaVersion: 1, source: 'plugin-journal', rootSessionId, revision: 31, availability: 'ready', history: [],
    run: {
      runId: 'ui-project-rollback', title: '【界面测试数据】工程交付后撤销文件', stage: 'delivery',
      executionProfile: 'workflow-project-pilot/1', riskLevel: 'L1', outcome: 'PASS', needsUser: false,
      tasks,
      gates: [
        { gateId: 'signal', kind: 'signal', stage: 'requirements', summary: '需求已确认', status: 'approved', requiredActor: 'user', scopeTaskIds: tasks.map(task => task.taskId), stale: false },
        { gateId: 'rollback', kind: 'rollback', stage: 'delivery', summary: '撤销预览已确认', status: 'approved', requiredActor: 'user', scopeTaskIds: ['implementation'], stale: false },
      ],
      agents: tasks.map(task => ({ assignmentId: `assignment-${task.taskId}`, agentSessionId: `agent-${task.taskId}`, taskId: task.taskId, taskVersion: 1, taskTitle: task.title, role: task.role, status: 'idle', lastSummary: '本角色历史工作已结束' })),
      ledger: { pass: 1, fail: 0, waived: 0, pending: 0, hardOutcome: 'PASS' }, latestReturn: null,
      rollback: { availableCheckpoints: 0, latestApplied: { checkpointId: 'implementation@1', fileCount: 2, reason: '用户通过原生撤销门禁确认' } },
      proposedLearningCount: 0, learningDecided: false,
    },
  }
}

async function presentation(rootSessionId, variant) {
  if (variant === 'absent') return { schemaVersion: 1, source: 'plugin-journal', rootSessionId, revision: 0, availability: 'absent', run: null, history: [] }
  if (variant === 'text-pass') return textPresentation(rootSessionId)
  if (variant === 'project-rollback-pending') {
    const snapshot = rollbackPresentation(rootSessionId)
    snapshot.run.rollback.availableCheckpoints = 1
    snapshot.run.gates.push({ ...snapshot.run.gates.at(-1), gateId: 'rollback-next', status: 'waiting', summary: '等待确认撤销更早的文件变化' })
    snapshot.run.needsUser = true
    return snapshot
  }
  if (variant === 'project-rollback') return rollbackPresentation(rootSessionId)
  const f = fixture(rootSessionId, 'ui-fixture-only')
  const journal = new WorkflowJournal(memoryTable())
  const snapshot = structuredClone(await journal.commit({ rootSessionId, expectedRevision: 0, events: [
    ...f.initial(), ...variant === 'gate' ? [] : [f.approve(), f.readyTask(), f.runTask(), f.assign()],
  ] }))
  snapshot.run.title = '【界面测试数据】起草一则服务维护通知'
  snapshot.run.gates[0].summary = '请确认合并后的需求与文本交付范围'
  if (variant !== 'gate') {
    snapshot.run.stage = variant === 'failed' ? 'verification' : 'implementation'
    snapshot.run.tasks[0].title = '起草通知正文，核对时间、影响范围与联系渠道'
    snapshot.run.agents[0].taskTitle = snapshot.run.tasks[0].title
    snapshot.run.agents[0].lastSummary = '这是浏览器内的渲染数据，不是真实 Agent 活动。'
    snapshot.run.agents[0].status = variant === 'failed' ? 'failed' : 'running'
    if (variant === 'failed') snapshot.run.tasks[0].status = 'failed'
    if (variant === 'qualified') {
      snapshot.run.stage = 'delivery'
      snapshot.run.outcome = 'QUALIFIED'
      snapshot.run.tasks[0].status = 'completed'
      snapshot.run.agents[0].status = 'completed'
      snapshot.run.ledger.waived = 1
      snapshot.run.ledger.pending = 0
    }
  }
  return snapshot
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const checks = []
try {
  assert.ok(selectedNames.every(name => variants.some(variant => variant.name === name)), 'unknown layout variant')
  for (const variant of variants.filter(variant => selectedNames.length === 0 || selectedNames.includes(variant.name))) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
    const errors = []
    const forbiddenRequests = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', route => {
      const method = new URL(route.request().url()).pathname.slice('/api/'.length)
      if (/^(respond|session\.(prompt|cancel|create|rename|selectModel)|subagent\.(prompt|interrupt)|agentPreset\.(select|remove)|goal\.(create|edit|resume|complete)|settings\.(update|replace|mutate))$/.test(method)) {
        forbiddenRequests.push(method)
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    await page.route('**/workflow-runtime/snapshot', async route => {
      const request = route.request().postDataJSON()
      await route.fulfill({ json: {
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: await presentation(request.payload.rootSessionId, variant.state) },
      } })
    })
    await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' })
    await page.getByText(sessionTitle, { exact: true }).click()
    const tab = page.getByRole('tab', { name: '工作流', exact: true })
    await tab.waitFor({ state: 'visible' })
    await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden' })
    const fileSidebarToggle = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
    if (await fileSidebarToggle.isVisible()) {
      await fileSidebarToggle.click()
      await fileSidebarToggle.waitFor({ state: 'hidden' })
    }
    await tab.click()
    const heading = page.locator('.wfr-view h2')
    await heading.waitFor()
    const headingText = await heading.innerText()
    if (variant.state === 'absent') assert.match(headingText, /还没有.*工作流记录|目标已收到|等待你描述|需求/)
    else if (variant.state === 'project-rollback') {
      assert.equal(headingText, '已撤销')
      assert.match(await page.locator('.wfr-task-context').innerText(), /【界面测试数据】/)
    }
    else assert.match(headingText, /【界面测试数据】/)
    // Select through the visible native sidebar before testing the narrow layout,
    // where the host intentionally collapses that navigation surface.
    await page.setViewportSize({ width: variant.width, height: 1050 })
    await page.waitForFunction(() => {
      const view = document.querySelector('.wfr-view')
      if (!view) return false
      const rect = view.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    // Official ThemePresenter palette selector, confined to this throwaway browser;
    // no theme/settings RPC and no change to the user's active app preferences.
    await page.evaluate(scheme => {
      document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
      document.documentElement.style.colorScheme = scheme
    }, variant.scheme)
    await page.mouse.move(variant.width - 8, 8)
    const layout = await page.evaluate(() => {
      const view = document.querySelector('.wfr-view')
      const style = getComputedStyle(view)
      const rect = view.getBoundingClientRect()
      const tokenNames = [...new Set(document.querySelector('#workflow-agent-runtime-style').textContent.match(/--dsw-[\w-]+/g))]
      const steps = [...document.querySelectorAll('.wfr-step')]
      return {
        viewport: innerWidth, x: rect.x, right: rect.right, width: rect.width,
        horizontalOverflow: view.scrollWidth > view.clientWidth,
        position: style.position, color: style.color,
        backgroundToken: style.getPropertyValue('--dsw-alias-bg-base').trim(),
        fontFamily: style.fontFamily,
        missingTokens: tokenNames.filter(name => !style.getPropertyValue(name).trim()),
        nativeInputCount: document.querySelectorAll('textarea, [contenteditable="true"]').length,
        pluginInputCount: view.querySelectorAll('input, textarea, [contenteditable="true"]').length,
        legacySurfaceCount: document.querySelectorAll('.wfr-dock, .wfr-layer, .wfr-panel').length,
        stepCount: steps.length,
        stageLabels: steps.map(step => step.querySelector('.wfr-step-status')?.textContent),
        stageStates: steps.map(step => step.dataset.state),
        currentStageCount: steps.filter(step => step.hasAttribute('aria-current')).length,
        completionNotice: view.querySelector('.wfr-completion')?.textContent ?? null,
        distinctStepTops: new Set(steps.map(step => step.getBoundingClientRect().top)).size,
        columnCount: steps.length ? getComputedStyle(document.querySelector('.wfr-track')).gridTemplateColumns.split(' ').length : 0,
      }
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(forbiddenRequests, [])
    assert.deepEqual(layout.missingTokens, [])
    assert.equal(layout.legacySurfaceCount, 0)
    assert.equal(layout.pluginInputCount, 0)
    assert.equal(layout.nativeInputCount, 1)
    assert.equal(layout.horizontalOverflow, false)
    assert.ok(layout.x >= 0 && layout.right <= variant.width + 1)
    if (variant.state !== 'absent') {
      assert.equal(layout.stepCount, 7)
      if (layout.width - 64 <= 550) assert.equal(layout.columnCount, 1)
    }
    if (variant.state === 'qualified') {
      assert.match(await page.locator('.wfr-view .wfr-status').innerText(), /有条件通过/)
      assert.equal(await page.locator('.wfr-view .wfr-status [data-state="done"]').count(), 0, 'qualified is not a green PASS')
      assert.equal(layout.currentStageCount, 0, 'ended delivery cannot remain an active phase')
      assert.equal(layout.stageLabels[5], '有条件交付')
    }
    if (variant.state === 'text-pass') {
      assert.deepEqual(layout.stageLabels, ['已确认', '并入需求确认', '已完成', '已完成', '本次无需', '已交付', '尚未接入'])
      assert.equal(layout.currentStageCount, 0)
      assert.match(layout.completionNotice, /本轮已结束/)
      assert.deepEqual(layout.stageStates, ['done', 'merged', 'done', 'done', 'not_required', 'done', 'unavailable'])
    }
    if (variant.state === 'project-rollback') {
      const headerStatus = page.locator('.wfr-status[data-placement="header"]')
      assert.equal(await headerStatus.innerText(), '已撤销')
      const headerPresentation = await headerStatus.evaluate(node => {
        const style = getComputedStyle(node)
        const separator = getComputedStyle(node, ':before')
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          separatorHeight: separator.height,
          separatorWidth: separator.width,
        }
      })
      assert.equal(headerPresentation.backgroundColor, 'rgba(0, 0, 0, 0)')
      assert.equal(headerPresentation.fontSize, '13px')
      assert.equal(headerPresentation.fontWeight, '600')
      assert.equal(headerPresentation.separatorHeight, '14px')
      assert.equal(headerPresentation.separatorWidth, '1px')
      assert.equal(await page.locator('.wfr-overview .wfr-rollback-heading').innerText(), '已撤销')
      assert.match(await page.locator('.wfr-result-summary').innerText(), /2 个文件/)
      assert.equal(layout.stageLabels[5], '已撤销')
      assert.equal(layout.stageStates[5], 'rolled_back')
      assert.match(layout.completionNotice, /撤销前的历史结果/)
      assert.equal(await page.locator('.wfr-step[data-state="rolled_back"] .wfr-rollback-icon').count(), 1)
      assert.equal(layout.currentStageCount, 0)
    }
    if (variant.state === 'project-rollback-pending') {
      assert.equal(await page.locator('.wfr-view .wfr-status').innerText(), '待撤销确认')
      assert.equal(await page.locator('.wfr-rollback-heading').count(), 0)
      assert.equal(layout.stageLabels[5], '待撤销确认')
      assert.equal(layout.stageStates[5], 'waiting')
      assert.match(layout.completionNotice, /本次撤销仍待你确认/)
    }
    // The native conversation can restore a previous bottom scroll position.
    // Capture the workflow's actual top so the state is reviewable on first view.
    await page.locator('.wfr-view-heading').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }))
    await page.screenshot({ path: join(directory, `${variant.name}.png`), fullPage: true, animations: 'disabled' })
    await page.getByText('各阶段做什么', { exact: true }).click()
    assert.equal(await page.locator('.wfr-stage-row').count(), 7)
    assert.equal(await page.locator('.wfr-stage-reason').count(), 7, 'every displayed phase has an accessible explanation')
    await page.getByText('各阶段做什么', { exact: true }).click()
    assert.equal(await page.locator('.wfr-stage-row').count(), 0)
    checks.push({ ...variant, themeFixture: true, runtimeFixture: true, fileSidebarCollapsedInTest: true, ...layout, errors, forbiddenRequests })
    await page.close()
  }
} finally { await browser.close() }
await writeFile(join(directory, 'layout-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), readonly: true, scope: 'Presentation fixtures only; no task was executed or approved.', checks }, null, 2) + '\n')
console.log(JSON.stringify(checks, null, 2))
