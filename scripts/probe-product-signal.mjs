/**
 * Product Signal v3: deterministic read-only replay inside the official DSH UI.
 * It rewrites browser responses only; every business write route is blocked.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { controllerFixture, proposal, signal } from '../tests/helpers/workflow-controller-fixture.mjs'

const [coreRoot, outputDirectory] = process.argv.slice(2)
if (!coreRoot || !outputDirectory) throw new Error('usage: node scripts/probe-product-signal.mjs <DSH source> <evidence directory>')
const { chromium } = await import(pathToFileURL(join(resolve(coreRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')).href)
const baseUrl = 'http://127.0.0.1:3080/'
const rootSessionId = 'workflow-text-restart-check-20260903'
const directory = resolve(outputDirectory)
await mkdir(directory, { recursive: true })

async function rpc(path, method, payload) {
  const rpcId = randomUUID()
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(5000),
  })
  const envelope = await response.json()
  assert.equal(response.status, 200)
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true)
  return envelope.result.value
}

function journalLogicalHash() {
  const db = new DatabaseSync('.dsh/workflow-runtime/journal.sqlite', { readOnly: true })
  try {
    const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  } finally { db.close() }
}

const sessionsBefore = await rpc('/api/session.list', 'session.list', {})
const target = sessionsBefore.items.find(item => item.sessionId === rootSessionId)
assert.ok(target, 'a persisted native session is required only as a read-only UI shell')
assert.equal(sessionsBefore.items.some(item => item.running), false)
const journalBefore = journalLogicalHash()
const artifactBefore = createHash('sha256').update(await readFile('.dsh/workflow-runtime/text-artifacts/5f9dcdec26e2c511b5b590a5b6ca6360430cfa50289f626d087ee9884bc46727.txt')).digest('hex')

const cleanups = []
const f = await controllerFixture({ after: callback => cleanups.push(callback) })
let reworkSnapshot
try {
  await f.controller.propose(f.root, {
    ...proposal(0), title: 'S2 · 会议室设备报障说明',
    goal: '起草包含报障入口、响应时限和紧急联系人的报障说明',
    inScope: ['会议室设备报障说明'], outOfScope: ['实际提交报障', '修改设备配置'],
    criteria: ['同时写明报障入口、响应时限和紧急联系人', '保持简洁指引语气'],
  }, signal)
  await f.controller.confirm(f.root, f.revision(), signal)
  await f.author('请在内部服务台提交报障，常规响应时限为两小时。')
  await f.advance()
  const qa = f.child('acceptance')
  await f.controller.report(qa, { role: 'acceptance_qa', results: [
    { criterionId: 'AC-1', status: 'FAIL', observation: '初稿没有写明紧急联系人' },
    { criterionId: 'AC-2', status: 'PASS', observation: '说明保持简洁指引语气' },
  ] }, signal)
  await f.settle(qa)
  await f.controller.returnForRework(f.root, f.revision(), signal)
  await f.advance()
  reworkSnapshot = structuredClone(f.snapshot())
  reworkSnapshot.rootSessionId = rootSessionId
  reworkSnapshot.run.title = '【SIMULATION · 非真实运行】S2 · 验证退回返工'
} finally {
  for (const callback of cleanups) await callback()
}

const absent = title => ({
  schemaVersion: 1, source: 'plugin-journal', rootSessionId,
  revision: 0, availability: 'absent', run: null, history: [],
})
const scenarios = [
  {
    id: 'S1', order: 'chat-first', title: '【SIMULATION · 非真实运行】S1 · 需求仍含糊',
    user: '帮我整理一份本季度供应商沟通摘要，给采购复盘会使用。',
    assistant: '这是只读场景，不会启动任务。当前还缺少供应商范围、沟通记录来源、覆盖日期和输出长度；请先补充这些要点，之后再合并需求供你确认。',
    snapshot: absent('S1'),
    expected: { now: '需求澄清，尚未开始整理', nextStep: '用户补充关键范围后合并确认', attention: '需要用户回答' },
  },
  {
    id: 'S2', order: 'workflow-first', title: '【SIMULATION · 非真实运行】S2 · 验证退回返工',
    user: '写一份会议室设备报障说明；必须包含报障入口、响应时限和紧急联系人，完成后独立验收。',
    assistant: '这是只读场景，不会启动任务。独立 QA 发现初稿缺少紧急联系人，已返回内容 Agent 在原范围内补充；修正后会重新独立验收。目前不需要你操作。',
    snapshot: reworkSnapshot,
    expected: { now: '验证已退回，内容 Agent 正在原范围内补充紧急联系人（日志记录，不是实时心跳）', nextStep: '修正版由独立 QA 重新验收', attention: '当前不需要用户操作' },
  },
  {
    id: 'S3', order: 'chat-first', title: '【SIMULATION · 非真实运行】S3 · 决定不执行',
    user: '评估是否把客服录音样本交给外部质检服务；没有合规批准就不要上传。',
    assistant: '这是只读场景，不会启动任务。由于缺少允许的录音范围和合规批准，本次评估结论是不执行；没有后台任务。以后取得明确范围与批准时，可以在原生输入中重新提出。',
    snapshot: absent('S3'),
    expected: { now: '评估结束并决定不执行', nextStep: '没有自动下一步，可在条件具备时重新提出', attention: '当前不需要用户操作' },
  },
]

function projectionValues(scenario) {
  const prior = target.projections?.values ?? {}
  return {
    title: scenario.title,
    goal: null,
    sessionListMetadata: { blank: false, lastPromptAt: 1_788_760_000_000 },
    sessionStats: { turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
    tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    contextPressure: { pressureTokens: 0, projectedTokens: 0, contextWindow: 1_000_000 },
    contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    subagentTiming: { settledMs: 0 }, subagent: null,
    ...(prior.permissions ? { permissions: prior.permissions } : {}),
    ...(prior.imageLimits ? { imageLimits: prior.imageLimits } : {}),
  }
}

function historyValue(scenario) {
  const time = 1_788_760_000_000
  const event = (type, seq, data, surfaceOp) => ({ event: { type, seq, time: time + seq, data, ...(surfaceOp ? { surfaceOp } : {}) } })
  const values = projectionValues(scenario)
  return {
    events: [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { role: 'user', content: [{ type: 'text', text: scenario.user }], source: { kind: 'user' } }, 'append'),
      event('assistant/message', 2, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: scenario.assistant }], source: { kind: 'model', provider: 'simulation', model: 'deterministic-readonly' } } }, 'append'),
      event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ],
    hasMore: false, projections: { asOfSeq: 3, values },
  }
}

const forbiddenPattern = /^(respond|session\.(prompt|cancel|create|rename|selectModel)|subagent\.(prompt|interrupt)|agentPreset\.(select|remove)|goal\.(create|edit|resume|complete)|settings\.(update|replace|mutate))$/
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const reports = []
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
    const errors = []
    const forbiddenRequests = []
    const writes = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request()
      const method = new URL(request.url()).pathname.slice('/api/'.length)
      if (forbiddenPattern.test(method)) {
        forbiddenRequests.push(method)
        writes.push(method)
        return route.abort('blockedbyclient')
      }
      if (method === 'session.list') {
        const response = await route.fetch()
        const envelope = await response.json()
        // The real shell has historical children. They are omitted only from
        // this browser replay so absent scenarios cannot inherit their rows.
        envelope.result.value.items = envelope.result.value.items.filter(entry => entry.parentSessionId !== rootSessionId)
        const item = envelope.result.value.items.find(entry => entry.sessionId === rootSessionId)
        item.updatedAt = 1_788_760_000_000
        item.running = false
        item.blank = false
        item.agentPreset = 'workflow-agent-signal-lab'
        item.projections = { asOfSeq: 3, values: projectionValues(scenario) }
        return route.fulfill({ json: envelope })
      }
      if (method === 'session.history') {
        const requestBody = request.postDataJSON()
        if (requestBody.payload.sessionId === rootSessionId) return route.fulfill({ json: {
          type: 'server-response', rpcId: requestBody.rpcId,
          result: { ok: true, value: historyValue(scenario) },
        } })
      }
      return route.continue()
    })
    await page.route('**/workflow-runtime/snapshot', async route => {
      const requestBody = route.request().postDataJSON()
      assert.equal(requestBody.payload.rootSessionId, rootSessionId)
      await route.fulfill({ json: { type: 'server-response', rpcId: requestBody.rpcId, result: { ok: true, value: scenario.snapshot } } })
    })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.getByText(scenario.title, { exact: true }).click()
    await page.getByText(scenario.user, { exact: true }).waitFor()
    await page.getByText(scenario.assistant, { exact: true }).waitFor()
    const fileSidebarToggle = page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: '折叠侧边栏', exact: true })
    if (await fileSidebarToggle.isVisible()) {
      await fileSidebarToggle.click()
      await fileSidebarToggle.waitFor({ state: 'hidden' })
    }
    const workflowTab = page.getByRole('tab', { name: '工作流', exact: true })
    await workflowTab.waitFor({ state: 'visible' })
    const chatTab = page.getByRole('tab', { name: '对话', exact: true })
    await chatTab.click()
    await page.screenshot({ path: join(directory, `${scenario.id}-chat-only.png`), clip: { x: 280, y: 0, width: 1160, height: 1050 }, animations: 'disabled' })
    await workflowTab.click()
    await page.locator('.wfr-view').waitFor()
    const workflowText = await page.locator('.wfr-view').innerText()
    await page.screenshot({ path: join(directory, `${scenario.id}-workflow.png`), clip: { x: 280, y: 0, width: 1160, height: 1050 }, animations: 'disabled' })
    assert.deepEqual(errors, [])
    assert.deepEqual(writes, [])
    assert.match(await page.locator('body').innerText(), /SIMULATION · 非真实运行/)
    assert.equal(await page.locator('.wfr-view input, .wfr-view textarea, .wfr-view [contenteditable="true"]').count(), 0)
    assert.match(workflowText, /现在[\s\S]*接下来[\s\S]*需要你/)
    if (scenario.id === 'S1') {
      assert.match(workflowText, /需求仍在澄清/)
      assert.match(workflowText, /等待你补充/)
      assert.match(workflowText, /尚未建立受控运行/)
      assert.doesNotMatch(workflowText, /还没有工作流记录|正在实现/)
      assert.equal(await page.locator('.wfr-agent').count(), 0)
    }
    if (scenario.id === 'S2') {
      assert.match(workflowText, /返工中/)
      assert.match(workflowText, /第 1 次返工[\s\S]*验证退回 → 实现/)
      assert.match(workflowText, /紧急联系人/)
      assert.match(workflowText, /完成后 → 验证重新验收/)
      assert.match(workflowText, /现在不需要你操作/)
    }
    if (scenario.id === 'S3') {
      assert.match(workflowText, /未启动执行/)
      assert.match(workflowText, /讨论已经结束/)
      assert.match(workflowText, /没有自动下一步/)
      assert.match(workflowText, /现在不需要操作/)
      assert.doesNotMatch(workflowText, /正在(?:等待授权|后台继续)/)
    }
    reports.push({ id: scenario.id, order: scenario.order, title: scenario.title, expected: scenario.expected, workflowText, errors, forbiddenRequests })
    await page.close()
  }
} finally { await browser.close() }

const sessionsAfter = await rpc('/api/session.list', 'session.list', {})
const journalAfter = journalLogicalHash()
const artifactAfter = createHash('sha256').update(await readFile('.dsh/workflow-runtime/text-artifacts/5f9dcdec26e2c511b5b590a5b6ca6360430cfa50289f626d087ee9884bc46727.txt')).digest('hex')
assert.equal(sessionsAfter.items.length, sessionsBefore.items.length)
assert.equal(sessionsAfter.items.some(item => item.running), false)
assert.equal(journalAfter, journalBefore)
assert.equal(artifactAfter, artifactBefore)
await writeFile(join(directory, 'replay-report.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), simulation: true, readonly: true,
  briefVersion: 'v3',
  scope: 'Product Signal v3 presentation replay; not a formal Run or Operational Product Gate sample.',
  nativeSessions: sessionsAfter.items.length, journalUnchanged: true, artifactUnchanged: true,
  modelCalls: 0, approvals: 0, businessWrites: 0, reports,
}, null, 2) + '\n')
console.log(JSON.stringify({ scenarios: reports.map(({ id, order, errors, forbiddenRequests }) => ({ id, order, errors, forbiddenRequests })), nativeSessions: sessionsAfter.items.length, journalUnchanged: true, artifactUnchanged: true }, null, 2))
