/**
 * Run one local, exact-Session root timeout injection through the real DSH Host.
 *
 * The Host config must already contain the same workflow-timeout-fixture-* id.
 * This helper creates only that Session, submits one native prompt, observes the
 * authoritative runtime snapshot, then performs a read-only UI inspection.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, baseUrl, launchLog, cwd, sessionId, title, promptFile, outputDirectory] = process.argv.slice(2)
const reuseTerminal = process.argv.includes('--reuse-terminal')
if (![sourceRoot, baseUrl, launchLog, cwd, sessionId, title, promptFile, outputDirectory].every(Boolean)) {
  throw new Error('usage: node scripts/run-root-timeout-injection.mjs <DSH source> <URL> <launch log> <cwd> <session id> <title> <prompt file> <evidence directory>')
}

const target = new URL(baseUrl)
assert.equal(target.hostname, '127.0.0.1', 'fault injection helper is limited to local DSH')
assert.match(sessionId, /^workflow-timeout-fixture-[a-z0-9-]{1,180}$/u,
  'fault injection requires one exact workflow-timeout-fixture-* Session id')
const fixtureRoot = resolve(cwd)
assert.match(fixtureRoot.replaceAll('\\', '/'), /^F:\/dsh\/workflow-timeout-fixture-[^/]+(?:\/|$)/iu,
  'fault injection workspace must be a dedicated F:/dsh/workflow-timeout-fixture-* directory')

const launchMatches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(launchMatches.length > 0, 'launch log does not contain a DSH web URL')
const navigationUrl = launchMatches.at(-1)[1]
assert.equal(new URL(navigationUrl).origin, target.origin, 'launch log and requested DSH origin differ')
const prompt = await readFile(promptFile, 'utf8')
assert.ok(prompt.trim().length > 0, 'prompt file is empty')

const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const evidenceDirectory = resolve(outputDirectory)
await mkdir(evidenceDirectory, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  const pageErrors = []
  const consoleErrors = []
  const failedRequests = []
  const benignAbortedRequests = []
  const forbiddenInspectionWrites = []
  let inspectionOnly = false

  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('requestfailed', request => {
    const failure = {
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? 'unknown request failure',
    }
    if (failure.error === 'net::ERR_ABORTED' && /^(\/api\/(session\/search|subagents\/list)|\/jira-workbench\/config-options|\/plugins\/events)$/u.test(failure.path)) {
      benignAbortedRequests.push(failure)
      return
    }
    failedRequests.push(failure)
  })
  await page.route('**/*', route => {
    if (!inspectionOnly || route.request().method() !== 'POST') return route.continue()
    const path = new URL(route.request().url()).pathname
    const method = path.startsWith('/api/') ? path.slice('/api/'.length).replaceAll('.', '/') : path
    if (/^(respond|session\/(prompt|cancel|create|rename|selectModel|fork)|subagents?\/(prompt|interrupt)|goals?\/(create|edit|resume|complete)|settings\/(update|replace|mutate)|commands?\/(run|execute))$/u.test(method)) {
      forbiddenInspectionWrites.push(method)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })

  const navigation = await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(navigation?.status(), 200, 'authenticated DSH navigation failed')
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })

  const created = await page.evaluate(async ({ cwd, sessionId, title, reuseTerminal }) => {
    const rpc = async (path, method, payload) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      })
      if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`${method} returned an invalid RPC envelope`)
      if (envelope.result?.ok !== true) throw new Error(envelope.result?.error?.message ?? `${method} failed`)
      return envelope.result.value
    }
    const listed = await rpc('/api/session/list', 'session/list', { args: { _request: {} } })
    const existing = listed.items.find(item => item.sessionId === sessionId)
    if (existing) {
      if (!reuseTerminal) throw new Error('target Session already exists')
      return {
        createdPreset: existing.projections?.values?.agentPreset ?? null,
        reusedTerminal: true,
      }
    }
    if (reuseTerminal) throw new Error('terminal fixture Session does not exist')
    const created = await rpc('/api/session/create', 'session/create', {
      args: { request: { cwd, sessionId, agentPreset: 'workflow-agent-signal-lab' } },
    })
    if (created.sessionId !== sessionId) throw new Error('Host returned a different Session id')
    await rpc('/api/session/rename', 'session/rename', { args: { request: { sessionId, title } } })
    return { createdPreset: created.agentPreset ?? null, reusedTerminal: false }
  }, { cwd: fixtureRoot, sessionId, title, reuseTerminal })

  // Start the prompt request without awaiting its RPC response. Some DSH Host
  // builds resolve session/prompt only after the short injected turn settles;
  // polling must therefore already be active to prove the intermediate state.
  const requestId = reuseTerminal ? null : randomUUID()
  const promptRpcId = reuseTerminal ? null : randomUUID()
  const promptResponsePromise = reuseTerminal ? null : page.request.post(new URL('/api/session/prompt', target.origin).href, {
    data: {
      type: 'client-request',
      rpcId: promptRpcId,
      method: 'session/prompt',
      payload: { args: { request: {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'Asia/Shanghai',
      } } },
    },
  })

  const observations = []
  let lastSignature = ''
  let finalState
  const startedAt = Date.now()
  const deadline = startedAt + 30_000
  while (Date.now() < deadline) {
    const state = await page.evaluate(async sessionId => {
      const rpc = async (path, method, payload) => {
        const rpcId = crypto.randomUUID()
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        })
        const envelope = await response.json()
        if (!response.ok || envelope.result?.ok !== true) throw new Error(envelope.result?.error?.message ?? `${method} failed`)
        return envelope.result.value
      }
      const [sessions, workflow, children] = await Promise.all([
        rpc('/api/session/list', 'session/list', { args: { _request: {} } }),
        rpc('/workflow-runtime/snapshot', 'snapshot', { schemaVersion: 1, rootSessionId: sessionId }),
        rpc('/api/subagents/list', 'subagents/list', { args: { parentSessionId: sessionId } }),
      ])
      return {
        root: sessions.items.find(item => item.sessionId === sessionId) ?? null,
        workflow,
        children,
      }
    }, sessionId)
    const recovery = state.workflow.preRunRecovery ?? state.workflow.run?.recovery ?? null
    const observation = {
      elapsedMs: Date.now() - startedAt,
      rootRunning: state.root?.running ?? null,
      revision: state.workflow.revision,
      availability: state.workflow.availability,
      stage: state.workflow.run?.stage ?? 'requirements',
      recovery: recovery === null ? null : {
        status: recovery.status,
        attempt: recovery.attempt,
        turn: recovery.turn,
        noProgressMs: recovery.noProgressMs,
        reason: recovery.reason,
        resumeFrom: recovery.resumeFrom,
      },
      childCount: state.children.entries.length,
      agentCount: state.workflow.run?.agents.length ?? 0,
      approvedGateCount: state.workflow.run?.gates.filter(gate => gate.status === 'approved').length ?? 0,
    }
    const signature = JSON.stringify({ ...observation, elapsedMs: 0 })
    if (signature !== lastSignature) {
      observations.push(observation)
      lastSignature = signature
    }
    if (recovery?.status === 'needs-attention' && recovery.attempt === 2 && state.root?.running === false) {
      finalState = state
      break
    }
    await page.waitForTimeout(40)
  }

  if (promptResponsePromise) {
    const promptResponse = await promptResponsePromise
    assert.equal(promptResponse.status(), 200, 'native prompt RPC returned a non-200 response')
    const promptEnvelope = await promptResponse.json()
    assert.equal(promptEnvelope?.type, 'server-response', 'native prompt returned an invalid RPC envelope')
    assert.equal(promptEnvelope?.rpcId, promptRpcId, 'native prompt returned a mismatched RPC id')
    assert.equal(promptEnvelope?.result?.ok, true, promptEnvelope?.result?.error?.message ?? 'native prompt failed')
  }
  const submission = {
    requestId,
    createdPreset: created.createdPreset,
    accepted: true,
    reusedTerminal: created.reusedTerminal,
  }

  assert.ok(finalState, 'fixture did not settle at second-stall needs-attention within 30 seconds')
  const firstRecovery = observations.find(item => item.recovery?.status === 'recovering' && item.recovery.attempt === 1)
  const finalRecovery = finalState.workflow.preRunRecovery ?? finalState.workflow.run?.recovery
  const turnNumbers = (finalState.root?.projections?.values?.turnOutline ?? [])
    .map(item => item.turn).filter(Number.isSafeInteger)
  assert.equal(finalRecovery.status, 'needs-attention')
  assert.equal(finalRecovery.attempt, 2)
  assert.equal(finalRecovery.turn, 2, 'second durable stall must belong to the one automatic recovery turn')
  assert.equal(Math.max(...turnNumbers), 2, 'native Session must contain exactly one automatic continuation turn')
  assert.equal(finalState.workflow.revision, 2, 'requirements fixture must persist exactly two stall events')
  assert.equal(finalState.workflow.availability, 'absent', 'requirements fault must not invent a workflow run')
  assert.match(finalRecovery.reason, /受控故障注入/u)
  assert.equal(finalState.children.entries.length, 0, 'requirements-timeout fixture must not dispatch child Agents')
  assert.equal(finalState.workflow.run?.agents.length ?? 0, 0, 'requirements-timeout fixture must not create Agent assignments')
  assert.equal(finalState.workflow.run?.gates.some(gate => gate.status === 'approved') ?? false, false,
    'fault injection must not create user authority')

  inspectionOnly = true
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('button').length > 5, { timeout: 20_000 })
  const session = page.getByText(title, { exact: true })
  if (!await session.isVisible().catch(() => false)) {
    const sidebar = page.getByTitle('侧边对话(beta)', { exact: true })
    if (await sidebar.isVisible().catch(() => false)) await sidebar.click()
  }
  if (!await session.isVisible().catch(() => false)) {
    const search = page.getByRole('button', { name: '搜索会话', exact: true })
    await search.click()
    await page.getByPlaceholder('搜索会话…', { exact: true }).fill(title)
  }
  await session.waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await session.count(), 1, 'fixture title must identify exactly one Session')
  await session.click()
  const workflowTab = page.getByRole('tab', { name: '工作流', exact: true })
  await workflowTab.waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('载入历史...', { exact: true }).waitFor({ state: 'hidden', timeout: 15_000 })
  await workflowTab.click()
  const workflowView = page.locator('.wfr-view')
  await workflowView.waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('.wfr-view')?.textContent?.includes('第 2 次停滞'), { timeout: 10_000 })
  const workflowText = await workflowView.innerText()
  assert.match(workflowText, /需要处理/u)
  assert.match(workflowText, /第 2 次停滞/u)
  assert.match(workflowText, /受控故障注入/u)
  assert.match(workflowText, /Signal Gate 仍关闭/u)
  const ui = await page.evaluate(() => {
    const view = document.querySelector('.wfr-view')
    const style = view ? getComputedStyle(view) : null
    return {
      workflowInputCount: document.querySelectorAll('.wfr-view textarea, .wfr-view input, .wfr-view [contenteditable="true"]').length,
      nativeInputCount: document.querySelectorAll('textarea, [contenteditable="true"]').length,
      pendingQuestionCount: document.querySelectorAll('[data-question-key]').length,
      legacySurfaceCount: document.querySelectorAll('.wfr-dock, .wfr-layer, .wfr-panel').length,
      workflowPosition: style?.position ?? null,
      horizontalOverflow: view ? view.scrollWidth > view.clientWidth : null,
    }
  })
  assert.equal(ui.workflowInputCount, 0, 'workflow view must remain read-only')
  assert.equal(ui.nativeInputCount, 1, 'only the native composer may accept follow-up input')
  assert.equal(ui.pendingQuestionCount, 0, 'injected stall must not masquerade as a user gate')
  assert.equal(ui.legacySurfaceCount, 0, 'no standalone workflow overlay may return')
  assert.equal(ui.workflowPosition, 'static', 'workflow view must remain inside the native surface')
  assert.equal(ui.horizontalOverflow, false)

  const screenshot = join(evidenceDirectory, 'requirements-timeout-needs-attention.png')
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
  const report = {
    checkedAt: new Date().toISOString(),
    fixture: { sessionId, title, cwd: fixtureRoot, promptFile: resolve(promptFile) },
    submission,
    observations,
    durableProof: {
      transientRecoveryObserved: firstRecovery !== undefined,
      finalAttempt: finalRecovery.attempt,
      finalTurn: finalRecovery.turn,
      maxNativeTurn: Math.max(...turnNumbers),
      journalRevision: finalState.workflow.revision,
      interpretation: firstRecovery === undefined
        ? 'DSH serialized same-Session snapshot reads behind session/prompt; attempt 2 + native turn 2 durably prove the one automatic continuation.'
        : 'The transient recovering state and its terminal successor were both observed.',
    },
    final: {
      rootRunning: finalState.root.running,
      revision: finalState.workflow.revision,
      availability: finalState.workflow.availability,
      recovery: finalRecovery,
      runId: finalState.workflow.run?.runId ?? null,
      stage: finalState.workflow.run?.stage ?? 'requirements',
      childCount: finalState.children.entries.length,
      agentCount: finalState.workflow.run?.agents.length ?? 0,
      approvedGateCount: finalState.workflow.run?.gates.filter(gate => gate.status === 'approved').length ?? 0,
    },
    ui,
    pageErrors,
    consoleErrors,
    failedRequests,
    benignAbortedRequests,
    forbiddenInspectionWrites,
    screenshot,
  }
  await writeFile(join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  assert.deepEqual(pageErrors, [], 'real page must not throw')
  assert.deepEqual(consoleErrors, [], 'real page must not log client errors')
  assert.deepEqual(failedRequests, [], 'real page must not have failed requests')
  assert.deepEqual(forbiddenInspectionWrites, [], 'read-only UI inspection attempted a mutation')
  console.log(JSON.stringify({
    checkedAt: report.checkedAt,
    sessionId,
    observations: observations.map(item => ({
      elapsedMs: item.elapsedMs,
      rootRunning: item.rootRunning,
      revision: item.revision,
      recoveryStatus: item.recovery?.status ?? null,
      recoveryAttempt: item.recovery?.attempt ?? null,
      noProgressMs: item.recovery?.noProgressMs ?? null,
    })),
    durableProof: report.durableProof,
    final: report.final,
    ui,
    pageErrors,
    consoleErrors,
    failedRequests,
    benignAbortedRequests,
    forbiddenInspectionWrites,
    screenshot,
  }, null, 2))
} finally {
  await browser.close()
}
