import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { completedCommandHandle } from './helpers/workflow-command-fixture.mjs'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as NativeControl from '@deepseek-ai/dsh-tool-subagent-control'
import Questions from '@deepseek-ai/dsh-user-questions'
import Commands from '@deepseek-ai/dsh-commands'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as Control from '../lib/workflow-control.js'
import * as Engine from '../lib/workflow-engine.js'
import { proposal } from './helpers/workflow-controller-fixture.mjs'

const labRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const signal = new AbortController().signal
const timeout = { timeout: 15000 }
const PROJECT_NATIVE_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh']

class TestSessionQuery extends SessionQueryEngine {
  searchSessions() { return Promise.reject(new Error('session search is not configured in this test')) }
  searchEvents() { return Promise.reject(new Error('event search is not configured in this test')) }
}

function textChunks(text) {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

function rawToolChunks(name, args) {
  const id = ToolCallId(randomUUID())
  const json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function toolChunks(name, input) { return rawToolChunks(name, { input }) }

function texts(value) {
  if (!value || typeof value !== 'object') return []
  return [...(typeof value.text === 'string' ? [value.text] : []), ...Object.values(value).flatMap(item => Array.isArray(item) ? item.flatMap(texts) : texts(item))]
}

async function waitFor(check, label, milliseconds = 8000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > milliseconds) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Scripted provider, real native AgentLoop/ToolRuntime/preset/persistence. No network. */
class ScriptedAdapter extends LlmAdapter {
  requests = []
  steps = new Map()
  toolViews = new Map()
  errors = []
  host
  drive = false
  projectDrive = false
  projectCommand = 'node --test'
  holdChild
  rootScript
  additionalRoots = new Set()
  async *stream(options) {
    this.requests.push(options)
    if (this.requests.length > 45) throw new Error('scripted run exceeded bounded call budget')
    const isRoot = options.sessionId === this.host?.root?.id || this.additionalRoots.has(options.sessionId)
    let chunks
    if (isRoot) {
      const root = this.host.ctx.agents.get(options.sessionId)
      assert.deepEqual((options.tools ?? []).map(tool => tool.name).sort(), [...this.host.ctx.workflowController.rootModelTools(root)].sort())
      // Native dynamic contexts are delivered in request messages, not in
      // the stable system section. Check both actual model-input locations.
      const rootInput = [options.system, ...texts(options.messages)].join('\n')
      assert.doesNotMatch(rootInput, /CREW_PM_SENTINEL|CREW_JOBS_SENTINEL/)
      assert.match(rootInput, /SANDBOX_POLICY_SENTINEL/)
      assert.match(rootInput, /APPROVAL_POLICY_SENTINEL/)
      const snapshot = this.host.storage.journal.readSnapshot(options.sessionId)
      const run = snapshot.run
      if (this.rootScript) chunks = await this.rootScript(options)
      else if (!this.drive || run?.outcome) chunks = textChunks('脚本化协调者：本轮信息已处理。')
      else if (!run) chunks = toolChunks('workflow_propose', proposal(snapshot.revision))
      else if (!run.gates.some(gate => gate.status === 'approved')) chunks = toolChunks('workflow_confirm', { expectedRevision: snapshot.revision })
      else if (run.tasks.find(task => task.taskId === 'acceptance')?.status === 'failed' && run.agents.every(agent => agent.status === 'idle')) chunks = toolChunks('workflow_return', { expectedRevision: snapshot.revision })
      else chunks = toolChunks('workflow_advance', { expectedRevision: snapshot.revision })
    } else {
      try {
        const child = this.host.ctx.agents.get(options.sessionId)
        const policy = child && this.host.ctx.workflowController.ownsChild(child.id)
          ? this.host.ctx.workflowController.childPolicy(child)
          : undefined
        const expectedTools = policy?.tools ?? Control.CHILD_TOOLS
        const visibleTools = (options.tools ?? []).map(tool => tool.name).sort()
        this.toolViews.set(options.sessionId, visibleTools)
        assert.deepEqual(visibleTools, [...expectedTools].sort())
        const childInput = [options.system, ...texts(options.messages)].filter(Boolean).join('\n')
        assert.doesNotMatch(childInput, /HOST_PRIVATE_CONTEXT|HOST_PRIVATE_SECTION/)
        assert.doesNotMatch(JSON.stringify(options.messages), /PM_PRIVATE_TRANSCRIPT|HOST_PRIVATE_CONTEXT|HOST_PRIVATE_SECTION/)
        if (this.holdChild) await this.holdChild(options)
        const index = this.steps.get(options.sessionId) ?? 0
        this.steps.set(options.sessionId, index + 1)
        if (this.projectDrive && policy?.profile === Control.PROJECT_PILOT) {
          const packet = texts(options.messages).reverse().map(text => { try { return JSON.parse(text) } catch { return null } })
            .find(value => value?.contractVersion === Control.PROJECT_PILOT)
          if (index === 0) chunks = toolChunks('workflow_packet', {})
          else {
            assert.ok(packet, 'project role must receive its actual packet before acting')
            if (policy.role === 'engineer' && index === 1) {
              chunks = rawToolChunks('write', { file_path: 'src/native.js', content: 'export const nativeReady = true\n' })
            } else if (policy.role === 'engineer') {
              chunks = toolChunks('workflow_report', { role: 'engineer', summary: '原生写工具已完成实现', changedFiles: ['src/native.js'], notes: [] })
            } else if (policy.role === 'test_engineer' && index === 1) {
              chunks = rawToolChunks('pwsh', { command: this.projectCommand, description: 'Run frozen engineering tests' })
            } else if (policy.role === 'test_engineer') {
              chunks = toolChunks('workflow_report', { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'PASS', observation: '原生检查退出成功' }] })
            } else if (policy.role === 'code_reviewer') {
              chunks = toolChunks('workflow_report', { role: 'code_reviewer', status: 'PASS', summary: '未发现阻塞问题', findings: [] })
            } else if (policy.role === 'acceptance_qa' && index === 1) {
              chunks = rawToolChunks('pwsh', { command: this.projectCommand, description: 'Run frozen black box check' })
            } else {
              chunks = toolChunks('workflow_report', { role: 'acceptance_qa', results: [{ criterionId: 'AC-1', status: 'PASS', checkIds: ['ACC-1'], observation: '黑盒检查退出成功' }] })
            }
          }
        } else if (index % 2 === 0) chunks = toolChunks('workflow_packet', {})
        else {
          const packet = texts(options.messages).reverse().map(text => { try { return JSON.parse(text) } catch { return null } })
            .find(value => value?.contractVersion === Control.TEXT_PILOT)
          assert.ok(packet, 'native model must receive its actual packet tool result')
          if (packet.role === 'engineer') chunks = toolChunks('workflow_report', { role: 'engineer', text: index < 2 ? '功能已就绪' : '测试功能已就绪' })
          else {
            assert.equal('rework' in packet, false)
            const content = packet.deliverable.text
            chunks = toolChunks('workflow_report', { role: 'acceptance_qa', results: [
              { criterionId: 'AC-1', status: content.includes('测试') ? 'PASS' : 'FAIL', observation: content.includes('测试') ? '当前交付文本包含“测试”' : '当前交付文本缺少“测试”' },
              { criterionId: 'AC-2', status: content.length <= 30 ? 'PASS' : 'FAIL', observation: `当前交付文本长度为 ${content.length} 个字符` },
            ] })
          }
        }
      } catch (error) { this.errors.push(error); throw error }
    }
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
  }
}

function projectProposal(expectedRevision) {
  return {
    expectedRevision, kind: 'project-change', title: '原生工程闭环测试', goal: '通过原生工具创建并验证一个工作区文件',
    changeClass: 'localized', inScope: ['创建 src/native.js'], outOfScope: ['发布', '安装依赖'],
    constraints: ['只运行冻结命令'], assumptions: [], unresolvedQuestions: [], writeScopes: ['src'],
    engineeringChecks: [{ id: 'ENG-1', command: 'node --test', workdir: '.', purpose: '执行工程测试' }],
    acceptanceChecks: [{ id: 'ACC-1', command: 'node --test', workdir: '.', purpose: '执行黑盒验收' }],
    criteria: [{ statement: '冻结黑盒检查成功退出', checkIds: ['ACC-1'] }],
  }
}

async function registerProjectNativeFixtures(ctx, workspaceRoot, commandHandle, realProcesses) {
  const observedShellModes = []
  const overrideOf = session => [...session.snapshotEvents()].reverse().find(event => event.type === 'sandbox/mode')?.data.mode
  const mode = session => overrideOf(session) ?? 'danger-full-access'
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', overrideOf,
    resolve: ({ session } = {}) => ({ mode: session ? mode(session) : 'danger-full-access', workspaceRoot: session?.header.cwd ?? workspaceRoot }) })
  ctx.provide('shellEnv', { collect: () => ({}) })
  // Service tracing is essential: a captured root-context stub would bypass
  // the preset-local subprocess decorator and correctly fail the exit gate.
  class FixtureShell extends Service {
    constructor(ctx) { super(ctx, 'shell') }
    sandboxMode = 'workspace-write'
    resolve(request) { return {
      ...request,
      workdir: request.workdir ?? workspaceRoot,
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64 * 1024,
      sandboxPolicy: request.sandboxPolicy,
    } }
    async run(spec) {
      observedShellModes.push(spec.sandboxPolicy?.mode)
      await this.ctx.subprocess.spawn({ signal: spec.signal }).done
      return {
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: 'tests passed', truncated: false }, stderr: { text: '', truncated: false },
        sandbox: { mode: spec.sandboxPolicy?.mode ?? 'workspace-write', denied: false },
      }
    }
    start() { throw new Error('background execution is disabled in the workflow preset fixture') }
  }
  if (realProcesses) {
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.provide('sandbox', { confine() { throw new Error('isolated process fixture never requests confinement or escalation') } })
    await ctx.plugin(SandboxPwshExecutor, { cwd: workspaceRoot, timeoutMs: 15000, maxTimeoutMs: 15000, graceMs: 200 })
  } else {
    ctx.provide('subprocess', { spawn: spec => commandHandle?.(spec) ?? completedCommandHandle(), resolveExecutable: async command => command })
    new FixtureShell(ctx)
  }
  ctx.provide('fs', {
    sandboxMode: 'workspace-write',
    async resolve(candidate, options = {}) {
      const target = resolve(options.cwd ?? workspaceRoot, candidate)
      return { targetKey: target, displayPath: target }
    },
    processPath: target => target.targetKey,
    fileUrl: target => pathToFileURL(target.targetKey).href,
    contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}\\`),
    async writeText(target, content) {
      await mkdir(dirname(target.targetKey), { recursive: true })
      let before = null
      try { before = await readFile(target.targetKey, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      await writeFile(target.targetKey, content, 'utf8')
      return { operation: before === null ? 'create' : 'update', version: `v-${Date.now()}`, before, after: content }
    },
  })
  return observedShellModes
}

async function harness(t, { reportAfterController = false, childConfig = {}, rootConfig = {}, runBudgetConfig = {},
  rootSessionId = `native-workflow-${randomUUID()}`, commandHandle, ask, realProcesses = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-native-test-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(labRoot).href + '/'
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: join(directory, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  const observedShellModes = await registerProjectNativeFixtures(ctx, directory, commandHandle, realProcesses)
  await ctx.plugin(AgentPresets, { default: Control.WORKFLOW_PRESET_ID, roots: [
    { path: join(labRoot, 'preset'), trust: 'user' },
    { path: join(labRoot, 'tests/fixtures/presets'), trust: 'user' },
  ], includeUserRoot: false })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  if (!reportAfterController) await ctx.plugin(NativeControl)
  await ctx.plugin(Questions)
  await ctx.plugin(Commands)
  const nativeQuestions = []
  const runtimeErrors = []
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason?.kind === 'error') runtimeErrors.push({ id: session.id, reason: event.data.reason })
  }, { global: true })
  ctx.on('user-questions/request', async request => {
    nativeQuestions.push(request)
    if (ask) return ask(request)
    return { answers: [{ id: request.questions[0].id, selected: [Control.CONFIRM_LABEL] }] }
  })
  const routes = new Map()
  // The production workflow engine declares the Web carrier capability even
  // though this in-process fixture substitutes Connection's route registry.
  ctx.provide('webServer', { register() {
    throw new Error('the native fixture Connection owns its synthetic routes')
  } })
  ctx.provide('connection', { rpc: { handle(channel, handler) {
    assert.equal(routes.has(channel), false)
    routes.set(channel, handler)
    return async () => { routes.delete(channel) }
  } } })
  const engineFiber = await ctx.plugin(Engine, { dataDirectory: join(directory, 'journal'),
    runBudgetEnabled: true, runBudgetScope: 'all', ...childConfig, ...rootConfig, ...runBudgetConfig })
  if (reportAfterController) await ctx.plugin(NativeControl)
  const storage = { journal: ctx.workflowJournal, directory: join(directory, 'journal') }
  t.after(async () => { await engineFiber.dispose(); assert.equal(routes.size, 0); await ctx.fiber.dispose() })
  if (realProcesses) {
    // Keep the nested node --test runner real. This environment belongs to this
    // isolated test-file process, not the live DSH Host or other test files.
    const testContext = process.env.NODE_TEST_CONTEXT
    delete process.env.NODE_TEST_CONTEXT
    t.after(() => {
      if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT
      else process.env.NODE_TEST_CONTEXT = testContext
    })
  }
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  let forbiddenCalls = 0
  ctx.tools.register(defineTool({ name: 'dangerous_test_tool', description: 'inert test-only sentinel', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: () => { forbiddenCalls++; return 'should not execute' },
  }))
  ctx.systemPrompt.section({ name: 'test:private', order: 50, text: 'HOST_PRIVATE_SECTION must not reach isolated roles' })
  ctx.systemPrompt.context({ name: 'test:private-context', order: 50, text: 'HOST_PRIVATE_CONTEXT must not reach isolated roles' })
  // Match the two named global contributions of installed dsh-crew 0.10.0.
  // Keep them global: the Workflow preset must not disable other modes.
  ctx.systemPrompt.section({ name: 'crew:pm', order: 5, text: 'CREW_PM_SENTINEL: use the separate Crew workflow' })
  ctx.systemPrompt.context({ name: 'crew:jobs', order: 130, text: 'CREW_JOBS_SENTINEL: unrelated unfinished job' })
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: 110, text: 'SANDBOX_POLICY_SENTINEL must remain on the root' })
  ctx.systemPrompt.context({ name: 'approval:policy', order: 115, text: 'APPROVAL_POLICY_SENTINEL must remain on the root' })
  const handle = await ctx.agents.create({
    sessionId: SessionId(rootSessionId), meta: { cwd: directory, agentPreset: Control.WORKFLOW_PRESET_ID },
    agentOptions: { provider: 'scripted', model: 'test-only' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, Control.WORKFLOW_PRESET_ID) },
  })
  const root = handle.agent
  const host = { ctx, storage, directory, root, adapter, nativeQuestions, runtimeErrors, observedShellModes, forbiddenCalls: () => forbiddenCalls }
  adapter.host = host
  return host
}

async function tool(host, name, input, agent = host.root) {
  return host.ctx.tools.execute({ agent, name, callId: ToolCallId(randomUUID()), arguments: { input }, signal })
}

async function additionalRoot(host, id, meta = {}, preset = Control.WORKFLOW_PRESET_ID) {
  const { agent } = await host.ctx.agents.create({ sessionId: SessionId(id),
    meta: { cwd: host.directory, agentPreset: preset, ...meta },
    agentOptions: { provider: 'scripted', model: 'test-only' },
    setup: async agentCtx => { await host.ctx.agentPresets.mount(agentCtx, preset) },
  })
  host.adapter.additionalRoots.add(agent.id)
  return agent
}

test('native scope meters only the exact selected root while another root and its fork keep old behavior', timeout, async t => {
  const selectedId = `selected-budget-${randomUUID()}`
  const host = await harness(t, { rootSessionId: selectedId, runBudgetConfig: {
    runBudgetScope: [selectedId], runModelRequests: 1, runCommands: 1, runTimeBudgetEnabled: true, runActiveMs: 10_000,
  } })
  const other = await additionalRoot(host, `${selectedId}-unselected`)
  const fork = await additionalRoot(host, `${selectedId}-fork`, { parentSession: host.root.id })
  for (const root of [host.root, other, fork]) assert.equal((await tool(host, 'workflow_propose', proposal(0), root)).isError, false)
  const snapshot = root => host.storage.journal.readSnapshot(root.id)
  assert.ok(snapshot(host.root).run.budget.time)
  assert.equal(snapshot(other).run.budget, undefined)
  assert.equal(snapshot(fork).run.budget, undefined, 'user fork lineage does not inherit enrollment')
  const otherBefore = snapshot(other), forkBefore = snapshot(fork)
  host.adapter.rootScript = () => textChunks('原生会话作用域隔离验证，不推进任务。')
  const send = async root => {
    root.followup(createUserMessage({ content: [{ type: 'text', text: '核对现状' }], source: { kind: 'user' } }))
    await root.whenIdle()
  }
  await send(host.root); await send(host.root)
  assert.equal(snapshot(host.root).run.budget.blocked.resource, 'root-model')
  for (let i = 0; i < 3; i++) await send(other)
  await send(fork)
  assert.deepEqual(snapshot(other), otherBefore)
  assert.deepEqual(snapshot(fork), forkBefore)
  assert.equal(host.adapter.requests.filter(r => r.sessionId === selectedId).length, 1)
  assert.equal(host.adapter.requests.filter(r => r.sessionId === other.id).length, 3)
  assert.equal(host.adapter.requests.filter(r => r.sessionId === fork.id).length, 1)
  assert.equal(snapshot(host.root).run.outcome, null)
})

test('native scoped duration cancels the selected root without interrupting a concurrent unselected provider', timeout, async t => {
  const selectedId = `selected-time-${randomUUID()}`
  const host = await harness(t, { rootSessionId: selectedId, runBudgetConfig: {
    runBudgetScope: [selectedId], runTimeBudgetEnabled: true, runActiveMs: 350,
  } })
  const other = await additionalRoot(host, `${selectedId}-other`)
  await tool(host, 'workflow_propose', proposal(0)); await tool(host, 'workflow_propose', proposal(0), other)
  const snapshot = root => host.storage.journal.readSnapshot(root.id)
  const before = snapshot(other), otherEntered = Promise.withResolvers(), releaseOther = Promise.withResolvers()
  host.adapter.rootScript = async options => {
    if (options.sessionId === selectedId) return new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(options.signal.reason)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    otherEntered.resolve(options)
    await releaseOther.promise
    return textChunks('未选会话正常完成，不被试验预算取消。')
  }
  other.followup(createUserMessage({ content: [{ type: 'text', text: '保持无关原生响应' }], source: { kind: 'user' } }))
  try {
    const otherRequest = await otherEntered.promise
    host.root.followup(createUserMessage({ content: [{ type: 'text', text: '触发选定会话时长上限' }], source: { kind: 'user' } }))
    await host.root.whenIdle(); await host.ctx.workflowController.runTime.flush(selectedId)
    assert.equal(snapshot(host.root).run.budget.blocked.resource, 'active-time')
    assert.equal(other.status, 'running')
    assert.equal(otherRequest.signal.aborted, false)
    assert.deepEqual(snapshot(other), before)
  } finally {
    releaseOther.resolve(); await other.whenIdle()
  }
  assert.deepEqual(snapshot(other), before)
  assert.equal(host.adapter.requests.length, 2)
})

test('native allowlisting cannot grant Workflow coordinator authority to another preset or delegated Agent', timeout, async t => {
  const selectedId = `selected-authority-${randomUUID()}`, plainId = `${selectedId}-plain`, delegatedId = `${selectedId}-child`
  const host = await harness(t, { rootSessionId: selectedId,
    runBudgetConfig: { runBudgetScope: [selectedId, plainId, delegatedId] } })
  const plain = await additionalRoot(host, plainId, {}, 'plain-test')
  const delegated = await additionalRoot(host, delegatedId,
    { origin: 'subagent', parentSession: host.root.id, delegationDepth: 1 })
  for (const agent of [plain, delegated]) {
    assert.equal((await tool(host, 'workflow_propose', proposal(0), agent)).isError, true)
    assert.equal(host.storage.journal.readSnapshot(agent.id).revision, 0)
    assert.equal(host.storage.journal.readSnapshot(agent.id).run, null)
  }
  assert.equal(host.adapter.requests.length, 0)
})

test('native cumulative duration cancels a stalled root provider without a business FAIL', timeout, async t => {
  const host = await harness(t, { runBudgetConfig: { runTimeBudgetEnabled: true, runActiveMs: 300 } })
  assert.equal((await tool(host, 'workflow_propose', proposal(0))).isError, false)
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  const revision = snapshot().revision
  host.adapter.rootScript = options => new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(options.signal.reason)
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '整轮累计时长隔离验证' }], source: { kind: 'user' } }))
  await host.root.whenIdle()
  await host.ctx.workflowController.runTime.flush(host.root.id)
  assert.equal(host.adapter.requests.length, 1)
  assert.equal(host.adapter.requests[0].signal.aborted, true)
  assert.equal(snapshot().run.budget.blocked.resource, 'active-time')
  assert.equal(snapshot().run.budget.time.observedMs, 300)
  assert.equal(snapshot().run.budget.time.reservedMs, 0)
  assert.equal(snapshot().revision, revision)
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.ledger.fail, 0)
})

test('native question waits pause cumulative time and answer resumes through fresh durable admission', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, { runBudgetConfig: { runTimeBudgetEnabled: true, runActiveMs: 500 },
    ask: () => answer.promise })
  await tool(host, 'workflow_propose', proposal(0))
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  let calls = 0
  host.adapter.rootScript = () => calls++ === 0
    ? rawToolChunks('ask_user_question', { questions: [{ id: 'time-wait', question: '确认范围？', options: [{ label: '只做测试' }] }] })
    : textChunks('答复已收到，测试结束。')
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '累计时长等待豁免' }], source: { kind: 'user' } }))
  try {
    await waitFor(() => host.ctx.workflowController.isAwaitingUser(host.root), 'native timed question wait')
    await host.ctx.workflowController.runTime.flush(host.root.id)
    const before = snapshot().run.budget.time
    assert.equal(before.reservedMs, 0)
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.deepEqual(snapshot().run.budget.time, before)
    assert.equal(snapshot().run.budget.blocked, null)
    assert.equal(host.nativeQuestions[0].signal.aborted, false)
  } finally {
    answer.resolve({ answers: [{ id: 'time-wait', selected: ['只做测试'] }] })
    await host.root.whenIdle()
  }
  await host.ctx.workflowController.runTime.flush(host.root.id)
  assert.equal(calls, 2)
  assert.equal(snapshot().run.budget.blocked, null)
  assert.equal(snapshot().run.budget.time.reservedMs, 0)
  assert.ok(snapshot().run.budget.time.observedMs < 500)
})

test('native waiting coordinator does not pause a funded child, and exhaustion cancels the exact scopes', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, { runBudgetConfig: { runTimeBudgetEnabled: true, runActiveMs: 500 },
    ask: request => {
      if (request.questions[0].id !== 'time-child-wait') return { answers: [{ id: request.questions[0].id, selected: [Control.CONFIRM_LABEL] }] }
      return new Promise((resolve, reject) => {
        const abort = () => reject(request.signal.reason)
        if (request.signal.aborted) return abort()
        request.signal.addEventListener('abort', abort, { once: true })
        void answer.promise.then(resolve).finally(() => request.signal.removeEventListener('abort', abort))
      })
    } })
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  await tool(host, 'workflow_propose', proposal(0))
  await tool(host, 'workflow_confirm', { expectedRevision: snapshot().revision })
  host.adapter.rootScript = () => rawToolChunks('ask_user_question', {
    questions: [{ id: 'time-child-wait', question: '后台执行时等待用户？', options: [{ label: '继续' }] }],
  })
  host.adapter.holdChild = options => new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(options.signal.reason)
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '等待时后台计时验证' }], source: { kind: 'user' } }))
  try {
    await waitFor(() => host.ctx.workflowController.isAwaitingUser(host.root), 'root waits before child')
    await host.ctx.workflowController.runTime.flush(host.root.id)
    // Real tool runtime with a working child; the parent's existing native wait
    // must not exempt that child from the shared duration ceiling.
    assert.equal((await tool(host, 'workflow_advance', { expectedRevision: snapshot().revision })).isError, false)
    await waitFor(() => snapshot().run.budget.blocked?.resource === 'active-time'
      && snapshot().run.agents[0]?.runtimeIssue?.status === 'stopped', 'timed native child drain')
    await host.root.whenIdle()
    assert.equal(host.nativeQuestions.at(-1).signal.aborted, true)
    assert.equal(snapshot().run.agents[0].runtimeIssue.cause, 'run-budget')
    assert.equal(snapshot().run.budget.time.observedMs, 500)
    assert.equal(snapshot().run.ledger.fail, 0)
    assert.equal(snapshot().run.outcome, null)
  } finally {
    answer.resolve({ answers: [{ id: 'time-child-wait', selected: ['继续'] }] })
    await host.root.whenIdle()
  }
})

test('native root exhaustion allows only three control calls on a fresh user turn, never execution or a plugin retry', timeout, async t => {
  const host = await harness(t, { runBudgetConfig: { runModelRequests: 1 } })
  await tool(host, 'workflow_propose', proposal(0))
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  const revision = snapshot().revision
  host.adapter.rootScript = () => toolChunks('workflow_status', {})
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '隔离预算测试' }], source: { kind: 'user' } }))
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 1, 'denied request never reaches the provider')
  assert.equal(snapshot().run.budget.used.rootModel, 1)
  assert.equal(snapshot().run.budget.blocked.resource, 'root-model')
  assert.equal(snapshot().revision, revision)
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.needsUser, true)
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '自动重试不算用户授权' }],
    source: { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'inert retry fixture' } }))
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 1)
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '这不是补额授权' }], source: { kind: 'user' } }))
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 4)
  assert.equal(snapshot().run.budget.recovery.controlUsed, 3)
  assert.equal(snapshot().run.budget.used.rootModel, 1)
  for (const request of host.adapter.requests.slice(1)) {
    assert.deepEqual(request.tools.map(tool => tool.name).sort(), ['workflow_budget', 'workflow_reconcile', 'workflow_status'])
    assert.match([request.system, ...texts(request.messages)].join('\n'), /预算核对模式/)
  }
  assert.equal(snapshot().run.agents.length, 0)
  const blocked = await tool(host, 'workflow_confirm', { expectedRevision: revision })
  assert.equal(blocked.isError, true)
  assert.equal(host.nativeQuestions.length, 0)
})

test('native child model admission stops the exact continuable child without provider retry or business FAIL', timeout, async t => {
  const host = await harness(t, { runBudgetConfig: { runModelRequests: 1 } })
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  await tool(host, 'workflow_propose', proposal(0))
  await tool(host, 'workflow_confirm', { expectedRevision: snapshot().revision })
  await tool(host, 'workflow_advance', { expectedRevision: snapshot().revision })
  await waitFor(() => snapshot().run.agents[0]?.runtimeIssue?.status === 'stopped', 'budget child drain')
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 1)
  assert.deepEqual(snapshot().run.budget.used, { rootModel: 0, childModel: 1, commands: 0 })
  assert.equal(snapshot().run.agents[0].runtimeIssue.cause, 'run-budget')
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.ledger.fail, 0)
  assert.equal(host.ctx.agents.get(SessionId(snapshot().run.agents[0].agentSessionId)), undefined)
})

async function exhaustNativeBudget(host) {
  await tool(host, 'workflow_propose', proposal(0))
  host.adapter.rootScript = () => toolChunks('workflow_status', {})
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '隔离测试执行额度上限' }], source: { kind: 'user' } }))
  await host.root.whenIdle()
  assert.ok(host.storage.journal.readSnapshot(host.root.id).run.budget.blocked)
}

test('official native budget tool waits for the exact question answer and ends the turn without auto execution', timeout, async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers()
  const host = await harness(t, { runBudgetConfig: { runModelRequests: 1 }, ask: request => {
    entered.resolve(request.questions[0]); return answer.promise
  } })
  await exhaustNativeBudget(host)
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  host.adapter.rootScript = () => toolChunks('workflow_budget', { expectedRevision: snapshot().revision,
    action: 'topup', reason: '用户请求增加完成剩余工作的额度', add: { modelRequests: 2, commands: 0 } })
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '请申请补额让我确认' }], source: { kind: 'user' } }))
  const question = await entered.promise
  assert.equal(snapshot().run.budget.limits.modelRequests, 1)
  assert.equal(snapshot().run.budget.recovery.requests.at(-1).status, 'pending')
  assert.equal(question.intent.kind, 'plan-review')
  assert.equal(question.intent.approve, Control.BUDGET_TOPUP_LABEL)
  answer.resolve({ answers: [{ id: question.id, selected: [Control.BUDGET_TOPUP_LABEL] }] })
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 2)
  assert.equal(snapshot().run.budget.recovery.controlUsed, 1)
  assert.equal(snapshot().run.budget.recovery.awaitingResume, true)
  assert.equal(snapshot().run.budget.used.rootModel, 1)
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '自动提醒不是用户继续' }],
    source: { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'inert fixture' } }))
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 2)
  assert.equal(snapshot().run.budget.recovery.awaitingResume, true)
  host.adapter.rootScript = () => textChunks('等待继续核对；本测试不派发角色。')
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '继续核对需求' }], source: { kind: 'user' } }))
  await host.root.whenIdle()
  assert.equal(host.adapter.requests.length, 3)
  assert.equal(snapshot().run.budget.recovery.awaitingResume, false)
  assert.equal(snapshot().run.budget.used.rootModel, 2)
  assert.equal(snapshot().run.agents.length, 0)
  assert.equal(snapshot().run.gates.some(gate => gate.status === 'approved'), false)
  assert.deepEqual(host.adapter.requests.at(-1).tools.map(item => item.name).sort(), [...Control.ROOT_TOOLS].sort())
})

test('official slash command stays usable after both model pools close and writes only an explicitly confirmed end', timeout, async t => {
  const host = await harness(t, { runBudgetConfig: { runModelRequests: 1 }, ask: request => ({
    answers: [{ id: request.questions[0].id, selected: [request.questions[0].intent.approve] }],
  }) })
  await exhaustNativeBudget(host)
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  for (let i = 0; i < 5; i++) {
    host.root.followup(createUserMessage({ content: [{ type: 'text', text: '再次核对，不授权补额' }], source: { kind: 'user' } }))
    await host.root.whenIdle()
  }
  assert.equal(snapshot().run.budget.recovery.controlUsed, 12)
  assert.equal(host.adapter.requests.length, 13)
  const status = await host.ctx.commands.execute(host.root, '/workflow-budget', [], signal)
  assert.equal(status.result.kind, 'success')
  assert.match(status.result.text, /预算耗尽/)
  const invalid = await host.ctx.commands.execute(host.root, '/workflow-budget topup 999', [], signal)
  assert.equal(invalid.result.kind, 'error')
  assert.equal(host.nativeQuestions.length, 0)
  const end = await host.ctx.commands.execute(host.root, '/workflow-budget end', [], signal)
  assert.equal(end.result.kind, 'success')
  assert.equal(snapshot().run.outcome, 'CANCELLED')
  assert.equal(snapshot().run.budget.recovery.closed, true)
  assert.equal(snapshot().run.budget.used.rootModel, 1)
  assert.equal(host.adapter.requests.length, 13, 'slash commands do not invoke a provider')
  const record = snapshot().run.budget.recovery.requests.at(-1)
  assert.equal(record.decisionAudit.requestId, host.nativeQuestions[0].questions[0].id)
  const events = [...host.root.session.snapshotEvents()]
  assert.equal(events.filter(item => item.type === 'command/run').length, 3)
  assert.equal(events.filter(item => item.type === 'command/done').length, 3)
  assert.ok(events.filter(item => item.type === 'command/run').every(item => item.data.source.kind === 'user'))
  // A finite post-end handoff is still available even if all 12 control calls
  // were consumed. It can create a DRAFT, never inherit the old approval.
  let handoff = 0
  host.adapter.rootScript = () => ++handoff === 1 ? toolChunks('workflow_status', {})
    : toolChunks('workflow_propose', proposal(snapshot().revision))
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '请建立下一项待确认草案' }], source: { kind: 'user' } }))
  await host.root.whenIdle()
  assert.equal(snapshot().history.length, 2)
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.agents.length, 0)
  assert.equal(snapshot().run.gates.some(gate => gate.status === 'approved'), false)
})

test('official slash topup is model-free, preserves the original requirement boundary and cannot reset recorded usage', timeout, async t => {
  const host = await harness(t, { runBudgetConfig: { runModelRequests: 1 }, ask: request => ({
    answers: [{ id: request.questions[0].id, selected: [request.questions[0].intent.approve] }],
  }) })
  await exhaustNativeBudget(host)
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id), before = snapshot()
  const result = await host.ctx.commands.execute(host.root, '/workflow-budget topup', [], signal)
  assert.equal(result.result.kind, 'success')
  assert.equal(host.adapter.requests.length, 1)
  assert.deepEqual(snapshot().run.budget.used, before.run.budget.used)
  assert.deepEqual(snapshot().run.gates, before.run.gates)
  assert.equal(snapshot().revision, before.revision)
  assert.equal(snapshot().run.budget.recovery.awaitingResume, true)
  assert.equal((await tool(host, 'workflow_advance', { expectedRevision: snapshot().revision })).isError, true)
})

test('native command admission refuses the next frozen check before starting its process', timeout, async t => {
  const host = await harness(t, { runBudgetConfig: { runCommands: 1 } })
  await mkdir(join(host.directory, 'src'), { recursive: true })
  host.adapter.projectDrive = true
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  const invoke = async name => {
    const result = await tool(host, name, { expectedRevision: snapshot().revision })
    assert.equal(result.isError, false, JSON.stringify(result))
  }
  const completed = taskId => snapshot().run.agents.some(agent => agent.taskId === taskId && agent.status === 'idle')
  await tool(host, 'workflow_propose', projectProposal(0))
  await invoke('workflow_confirm'); await invoke('workflow_advance')
  await waitFor(() => completed('implementation'), 'budget fixture implementation'); await host.root.whenIdle()
  await invoke('workflow_advance')
  await waitFor(() => completed('engineering-test') && completed('code-review'), 'budget fixture parallel checks'); await host.root.whenIdle()
  assert.equal(host.observedShellModes.length, 1)
  await invoke('workflow_advance')
  await waitFor(() => snapshot().run.budget.blocked?.resource === 'command'
    && snapshot().run.agents.some(agent => agent.taskId === 'acceptance' && agent.runtimeIssue?.status === 'stopped'), 'budget frozen check denial')
  assert.equal(host.observedShellModes.length, 1, 'no second subprocess dispatched')
  const state = host.storage.journal.readRunState(host.root.id, snapshot().run.runId)
  assert.equal(Object.values(state.commands).length, 1, 'no false command-start record')
  assert.equal(snapshot().run.budget.used.commands, 1)
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.ledger.fail, 0)
  assert.equal(await readFile(join(host.directory, 'src/native.js'), 'utf8'), 'export const nativeReady = true\n')
})

const processBudgetOptions = { timeout: 35000, skip: process.platform !== 'win32' ? 'Windows real-process integration' : false }

function processEvidence(t, name) {
  const evidence = { name, startedAt: new Date().toISOString(),
    scope: 'scripted model; real official AgentLoop, ToolRuntime, PowerShell and local subprocess; temporary stores; no live 3080 writes', phases: [] }
  let host
  t.after(async () => {
    // Registered before the harness teardown: retain the actual final snapshot,
    // even when an assertion failed. The test runner, not this receipt, decides PASS.
    if (host) {
      evidence.workspace = host.directory
      evidence.snapshot = host.storage.journal.readSnapshot(host.root.id)
      evidence.commands = Object.values(host.storage.journal.readRunState(host.root.id, evidence.snapshot.run.runId).commands)
      evidence.adapterErrors = host.adapter.errors.map(String)
      evidence.finishedAt = new Date().toISOString()
    }
    if (process.env.WORKFLOW_PROCESS_EVIDENCE_DIR) await writeFile(
      join(process.env.WORKFLOW_PROCESS_EVIDENCE_DIR, name + '.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  })
  return { attach(value) { host = value }, record(phase, detail = {}) { evidence.phases.push({ phase, at: new Date().toISOString(), ...detail }) } }
}

async function prepareRealProcessRun(t, evidence, { hold = false, ...options } = {}) {
  const host = await harness(t, { realProcesses: true,
    childConfig: { commandTimeoutMs: 15000, commandExitGraceMs: 5000, childCancelGraceMs: 5000 }, ...options })
  evidence.attach(host)
  await cp(join(labRoot, 'tests/fixtures/budget-processes'), host.directory, { recursive: true })
  await writeFile(join(host.directory, 'budget-fixture.json'), JSON.stringify({ hold }))
  host.adapter.projectDrive = true
  host.adapter.projectCommand = 'node --test budget-probe.test.cjs'
  const snapshot = () => host.storage.journal.readSnapshot(host.root.id)
  const invoke = async name => {
    const result = await tool(host, name, { expectedRevision: snapshot().revision })
    assert.equal(result.isError, false, JSON.stringify(result))
  }
  const contract = projectProposal(0)
  for (const check of [...contract.engineeringChecks, ...contract.acceptanceChecks]) check.command = host.adapter.projectCommand
  assert.equal((await tool(host, 'workflow_propose', contract)).isError, false)
  await invoke('workflow_confirm'); await invoke('workflow_advance')
  await waitFor(() => snapshot().run.agents.some(agent => agent.taskId === 'implementation' && agent.status === 'idle'), 'real process implementation')
  await host.root.whenIdle()
  evidence.record('implementation-complete', { budget: snapshot().run.budget })
  return { host, snapshot, invoke: async name => {
    const result = await tool(host, name, { expectedRevision: snapshot().revision })
    const detail = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
    evidence.record(name, { isError: result.isError, agents: detail?.agents, failures: detail?.failures })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.ok(!detail?.failures?.length, JSON.stringify(detail?.failures))
  } }
}

test('real PowerShell budget blocks the second frozen command before process launch', processBudgetOptions, async t => {
  const evidence = processEvidence(t, 'command-exhaustion')
  const { host, snapshot, invoke } = await prepareRealProcessRun(t, evidence, { runBudgetConfig: { runCommands: 1 } })
  await invoke('workflow_advance')
  await waitFor(() => ['engineering-test', 'code-review'].every(taskId => snapshot().run.agents.some(agent => agent.taskId === taskId && agent.status === 'idle')), 'real engineering command completes')
  await host.root.whenIdle()
  const commands = () => Object.values(host.storage.journal.readRunState(host.root.id, snapshot().run.runId).commands)
  assert.equal(commands().length, 1)
  assert.equal(commands()[0].status, 'completed', JSON.stringify(commands()))
  assert.equal(commands()[0].observation.exitConfirmed, true)
  assert.equal(commands()[0].observation.processCount, 1)
  const before = await readFile(join(host.directory, 'budget-processes.jsonl'), 'utf8')
  const processEvents = before.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(processEvents.map(event => event.event), ['started', 'completed'], 'the nested test really ran')
  evidence.record('first-command-complete', { command: commands()[0], processEvents })
  await invoke('workflow_advance')
  await waitFor(() => snapshot().run.budget.blocked?.resource === 'command'
    && snapshot().run.agents.some(agent => agent.taskId === 'acceptance' && agent.runtimeIssue?.status === 'stopped'), 'second command denied before launch')
  await host.root.whenIdle()
  assert.equal(await readFile(join(host.directory, 'budget-processes.jsonl'), 'utf8'), before, 'no second process marker')
  assert.equal(commands().length, 1, 'no false second command/started event')
  assert.equal(snapshot().run.budget.used.commands, 1)
  assert.equal(snapshot().run.budget.limits.commands, 1)
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.ledger.fail, 0)
  assert.equal(await readFile(join(host.directory, 'src/native.js'), 'utf8'), 'export const nativeReady = true\n', 'no implicit file undo')
  assert.deepEqual(host.adapter.errors, [])
  evidence.record('second-command-denied', { commandCount: commands().length, budget: snapshot().run.budget, ledger: snapshot().run.ledger })
})

test('real PowerShell budget allows exactly funded checks and normal delivery', processBudgetOptions, async t => {
  const evidence = processEvidence(t, 'exactly-funded-delivery')
  const { host, snapshot, invoke } = await prepareRealProcessRun(t, evidence, {
    runBudgetConfig: { runCommands: 2, runTimeBudgetEnabled: true, runActiveMs: 15000 },
  })
  for (const wave of [['engineering-test', 'code-review'], ['acceptance']]) {
    await invoke('workflow_advance')
    await waitFor(() => wave.every(taskId => snapshot().run.tasks.some(task => task.taskId === taskId && task.status === 'completed')
      && snapshot().run.agents.some(agent => agent.taskId === taskId && agent.status === 'idle')), 'funded real checks complete')
    await host.root.whenIdle()
  }
  await invoke('workflow_advance')
  await host.ctx.workflowController.runTime.flush(host.root.id)
  const run = snapshot().run
  const commands = Object.values(host.storage.journal.readRunState(host.root.id, run.runId).commands)
  assert.equal(commands.length, 2)
  assert.ok(commands.every(command => command.status === 'completed' && command.observation.exitConfirmed
    && command.observation.toolSettled && command.observation.processCount === 1 && command.observation.exitCode === 0))
  const processEvents = (await readFile(join(host.directory, 'budget-processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(processEvents.map(event => event.event), ['started', 'completed', 'started', 'completed'])
  assert.equal(run.budget.used.commands, 2)
  assert.equal(run.budget.blocked, null, 'using the last slot is allowed; only a later admission would be blocked')
  assert.equal(run.budget.time.reservedMs, 0, 'terminal delivery leaves no active time reservation')
  assert.ok(run.budget.time.observedMs > 0 && run.budget.time.observedMs < 15000)
  assert.equal(run.outcome, 'PASS')
  assert.equal(run.ledger.fail, 0)
  assert.ok(run.agents.every(agent => agent.status === 'idle' && !agent.runtimeIssue))
  assert.deepEqual(host.adapter.errors, [])
  evidence.record('normal-delivery', { commands, processEvents, budget: run.budget, ledger: run.ledger })
})

test('real PowerShell budget stops a running command while its parent waits, without stopping unrelated work', processBudgetOptions, async t => {
  const evidence = processEvidence(t, 'active-time-exhaustion')
  const answer = Promise.withResolvers()
  const activeMs = 5000
  const { host, snapshot, invoke } = await prepareRealProcessRun(t, evidence, { hold: true,
    runBudgetConfig: { runTimeBudgetEnabled: true, runActiveMs: activeMs },
    ask: request => {
      if (request.questions[0].id !== 'real-process-wait') return { answers: [{ id: request.questions[0].id, selected: [Control.CONFIRM_LABEL] }] }
      return new Promise((resolve, reject) => {
        const abort = () => reject(request.signal.reason)
        if (request.signal.aborted) return abort()
        request.signal.addEventListener('abort', abort, { once: true })
        void answer.promise.then(resolve, reject).finally(() => request.signal.removeEventListener('abort', abort))
      })
    } })
  let rootRequests = 0
  host.adapter.rootScript = () => rootRequests++ === 0 ? rawToolChunks('ask_user_question', {
    questions: [{ id: 'real-process-wait', question: '独立夹具：等待时仍监管后台命令？', options: [{ label: '继续' }] }],
  }) : textChunks('独立夹具只等待一次，不自动重试。')
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '真实命令累计时长隔离验证' }], source: { kind: 'user' } }))
  let controlProcess, controlExited
  try {
    await waitFor(() => host.ctx.workflowController.isAwaitingUser(host.root), 'parent native question wait')
    await host.ctx.workflowController.runTime.flush(host.root.id)
    const before = structuredClone(snapshot().run.budget.time)
    assert.equal(before.reservedMs, 0)
    await new Promise(resolve => setTimeout(resolve, activeMs + 250))
    await host.ctx.workflowController.runTime.flush(host.root.id)
    assert.deepEqual(snapshot().run.budget.time, before, 'no children: native user wait must not consume time')
    assert.equal(snapshot().run.budget.blocked, null)
    evidence.record('idle-user-wait-not-charged', { waitedMs: activeMs + 250, time: before })

    // Independent, bounded control process, outside the workflow's managed
    // command range. Cleanup addresses only this exact ChildProcess handle.
    controlProcess = spawn(process.execPath, ['-e', "console.log('control-ready'); setTimeout(() => {}, 20000)"], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    controlExited = once(controlProcess, 'exit')
    await once(controlProcess.stdout, 'data')
    const commands = () => Object.values(host.storage.journal.readRunState(host.root.id, snapshot().run.runId).commands)
    await invoke('workflow_advance')
    await waitFor(() => commands().some(command => command.status === 'running'), 'real timed command started')
    let owned
    const deadline = Date.now() + 6000
    while (!owned && Date.now() < deadline) {
      try { owned = JSON.parse(await readFile(join(host.directory, 'budget-owned-pids.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    assert.ok(owned, 'the real command and its descendant must start before exhaustion')
    for (const pid of [owned.testPid, owned.descendantPid]) assert.doesNotThrow(() => process.kill(pid, 0))
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
    evidence.record('command-and-descendant-running-during-user-wait', { owned, unrelatedPid: controlProcess.pid })
    await waitFor(() => snapshot().run.budget.blocked?.resource === 'active-time'
      && snapshot().run.agents.some(agent => agent.taskId === 'engineering-test' && agent.runtimeIssue?.status === 'stopped')
      && commands().length === 1 && commands()[0].status !== 'running', 'run budget ends the real managed command range', 10000)
    await host.root.whenIdle()
    await host.ctx.workflowController.runTime.flush(host.root.id)
    assert.equal(commands()[0].status, 'interrupted', JSON.stringify(commands()))
    assert.equal(commands()[0].observation.exitConfirmed, true)
    assert.equal(commands()[0].observation.toolSettled, true)
    assert.equal(commands()[0].observation.processCount, 1)
    for (const pid of [owned.testPid, owned.descendantPid]) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    assert.equal(controlProcess.exitCode, null, 'unrelated control process was not terminated')
    assert.equal(controlProcess.signalCode, null)
    assert.doesNotThrow(() => process.kill(controlProcess.pid, 0))
    const run = snapshot().run
    assert.equal(run.agents.find(agent => agent.taskId === 'engineering-test').runtimeIssue.cause, 'run-budget', 'not the longer per-command timeout')
    assert.equal(run.budget.time.observedMs, activeMs)
    assert.equal(run.budget.time.reservedMs, 0)
    assert.equal(run.budget.time.uncertainMs, 0)
    assert.equal(run.budget.used.commands, 1)
    assert.equal(run.outcome, null)
    assert.equal(run.ledger.fail, 0)
    assert.equal(host.nativeQuestions.at(-1).signal.aborted, true)
    const processEvents = (await readFile(join(host.directory, 'budget-processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(processEvents.map(event => event.event), ['started'], 'neither the 20s fuse nor a successful check ended this command')
    assert.equal(await readFile(join(host.directory, 'src/native.js'), 'utf8'), 'export const nativeReady = true\n')
    assert.deepEqual(host.adapter.errors, [])
    evidence.record('duration-exhausted-and-managed-range-exited', { owned, unrelatedPid: controlProcess.pid,
      unrelatedStillAlive: true, command: commands()[0], processEvents, budget: run.budget, ledger: run.ledger })
  } finally {
    answer.resolve({ answers: [{ id: 'real-process-wait', selected: ['继续'] }] })
    if (controlProcess?.exitCode === null && controlProcess.signalCode === null) controlProcess.kill()
    if (controlExited) await controlExited
    await host.root.whenIdle()
  }
})

test('official ToolRuntime and userQuestions carry audited manual closure without starting an Agent or command', timeout, async t => {
  const entered = Promise.withResolvers(), answer = Promise.withResolvers()
  const host = await harness(t, { ask: request => {
    if (request.questions[0].header === '人工处置') { entered.resolve(request); return answer.promise }
    return { answers: [{ id: request.questions[0].id, selected: [Control.CONFIRM_LABEL] }] }
  } })
  assert.equal((await tool(host, 'workflow_propose', proposal(0))).isError, false)
  const journal = host.storage.journal, snapshot = () => journal.readSnapshot(host.root.id)
  assert.equal((await tool(host, 'workflow_confirm', { expectedRevision: snapshot().revision })).isError, false)
  const runId = snapshot().run.runId
  const task = journal.readRunState(host.root.id, runId).records['task:author']
  const assignmentId = randomUUID(), incidentId = randomUUID(), oldChildId = `fixture-old-child-${randomUUID()}`
  const event = (name, payload, actor = { kind: 'system', id: 'native-fixture' }) => ({ version: 1, runId, eventId: randomUUID(), name, actor, payload })
  // Explicit synthetic orphan history in a temporary SQLite store; not a live Host-loss test.
  await journal.commit({ rootSessionId: host.root.id, expectedRevision: snapshot().revision, events: [
    event('task/status-changed', { taskId: 'author', taskVersion: 1, expectedStatus: 'pending', status: 'ready', reason: 'fixture ready' }),
    event('task/status-changed', { taskId: 'author', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: 'fixture old run' }),
    event('agent/assigned', { assignmentId, taskId: 'author', taskVersion: 1, agentSessionId: oldChildId,
      role: task.data.role, lifecycle: task.data.lifecycle, contextDomains: task.data.contextDomains }),
    event('agent/runtime-interrupted', { assignmentId, incidentId, taskVersion: 1, cause: 'host-restart', status: 'unknown',
      budgetMs: 0, elapsedMs: 0, reason: 'synthetic orphan for official carrier integration' }),
  ] })
  const work = tool(host, 'workflow_reconcile', { expectedRevision: snapshot().revision, reason: '隔离集成夹具处置',
    checks: [{ assignmentId, incidentId, evidence: [{ source: '临时夹具', observation: '核对该夹具的旧范围；不作为真实系统退出证据' }] }] })
  const request = await entered.promise
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
  assert.equal(request.questions[0].intent.approve, Control.MANUAL_CLOSE_LABEL)
  assert.equal(snapshot().run.outcome, null)
  assert.equal(snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  assert.equal(snapshot().run.gates.at(-1).kind, 'runtime-recovery')
  answer.resolve({ answers: [{ id: request.questions[0].id, selected: [Control.MANUAL_CLOSE_LABEL] }] })
  const result = await work
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(snapshot().run.outcome, 'ABANDONED')
  assert.equal(snapshot().run.manualClose.decisionAudit.operator, 'unverified')
  assert.equal(snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  assert.equal(host.ctx.agents.get(oldChildId), undefined)
  assert.equal(host.adapter.requests.length, 0)
  assert.equal(host.observedShellModes.length, 0)
})

test('native clarification is recognized through the real tool and survives the root budget', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, {
    rootConfig: { rootTurnNoProgressMs: 1000, rootRecoveryNoProgressMs: 1000, userWaitProbeMs: 1000 },
    ask: request => new Promise((resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      void answer.promise.then(resolve, reject).finally(() => request.signal.removeEventListener('abort', abort))
    }),
  })
  let calls = 0
  host.adapter.rootScript = () => calls++ === 0
    ? rawToolChunks('ask_user_question', { questions: [{ id: 'scope', question: '确认范围？', options: [{ label: '只做测试' }] }] })
    : textChunks('已收到范围答复；不执行任务。')
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '原生澄清等待回归' }], source: { kind: 'user' } }))
  try {
    await waitFor(() => host.nativeQuestions.length === 1, 'real ask_user_question pending')
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.equal(host.nativeQuestions[0].signal.aborted, false, 'waiting for an answer is not execution inactivity')
    assert.equal(host.root.status, 'running')
    assert.equal(host.storage.journal.readSnapshot(host.root.id).revision, 0, 'no false recovery incident or automatic retry')
    assert.equal(calls, 1, 'no replacement model turn while waiting')
  } finally {
    answer.resolve({ answers: [{ id: 'scope', selected: ['只做测试'] }] })
    await host.root.whenIdle()
  }
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  assert.equal(host.storage.journal.readSnapshot(host.root.id).revision, 0)
  assert.equal(calls, 2)
})

test('native question cancellation releases its exemption before a late answerer settles', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, { ask: () => answer.promise })
  const cancel = new AbortController()
  const request = host.ctx.tools.execute({ agent: host.root, name: 'ask_user_question',
    callId: ToolCallId(randomUUID()), arguments: { questions: [{ id: 'cancel', question: '待取消？' }] }, signal: cancel.signal })
  try {
    await waitFor(() => host.nativeQuestions.length === 1, 'native cancellation question')
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
    cancel.abort(new Error('test caller cancelled'))
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  } finally {
    answer.resolve({ answers: [{ id: 'cancel', selected: [] }] })
    await request
  }
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  assert.equal(host.storage.journal.readSnapshot(host.root.id).revision, 0)
})

test('native answerer rejection clears waiting state and remains an actual tool error', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, { ask: () => answer.promise })
  const request = host.ctx.tools.execute({ agent: host.root, name: 'ask_user_question', callId: ToolCallId(randomUUID()),
    arguments: { questions: [{ id: 'reject', question: '错误样本？' }] }, signal })
  await waitFor(() => host.nativeQuestions.length === 1, 'native rejecting question')
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
  answer.reject(new Error('test answerer unavailable'))
  const result = await request
  assert.equal(result.isError, true)
  assert.match(texts(result).join('\n'), /test answerer unavailable/)
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  assert.equal(host.storage.journal.readSnapshot(host.root.id).revision, 0)
})

test('native question observation isolates roots and ignores another preset', timeout, async t => {
  const answers = new Map()
  const host = await harness(t, { ask: request => {
    const pending = Promise.withResolvers()
    answers.set(request.agent, pending)
    return pending.promise
  } })
  const createRoot = preset => host.ctx.agents.create({ sessionId: SessionId(`question-root-${randomUUID()}`),
    meta: { cwd: host.directory, agentPreset: preset }, agentOptions: { provider: 'scripted', model: 'test-only' },
    setup: async ctx => { await host.ctx.agentPresets.mount(ctx, preset) } })
  const second = (await createRoot(Control.WORKFLOW_PRESET_ID)).agent
  const plain = (await createRoot('plain-test')).agent
  const ask = agent => host.ctx.userQuestions.ask({ agent, questions: [{ id: 'scope', question: '独立问题？' }], signal })
  const pendingFirst = ask(host.root), pendingPlain = ask(plain)
  try {
    await waitFor(() => answers.size === 2, 'two unrelated native questions')
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
    assert.equal(host.ctx.workflowController.isAwaitingUser(second), false)
    assert.equal(host.ctx.workflowController.isAwaitingUser(plain), false)
    const pendingSecond = ask(second)
    await waitFor(() => answers.has(second), 'second workflow root question')
    answers.get(host.root).resolve({ answers: [{ id: 'scope', selected: [] }] })
    await pendingFirst
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
    assert.equal(host.ctx.workflowController.isAwaitingUser(second), true)
    answers.get(second).resolve({ answers: [{ id: 'scope', selected: [] }] })
    await pendingSecond
    assert.equal(host.ctx.workflowController.isAwaitingUser(second), false)
  } finally {
    for (const answer of answers.values()) answer.resolve({ answers: [{ id: 'scope', selected: [] }] })
    await Promise.all([pendingFirst, pendingPlain])
  }
})

test('plugin confirmation remains waiting across the budget and records only the supplied answer', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, {
    rootConfig: { rootTurnNoProgressMs: 1000, rootRecoveryNoProgressMs: 1000, userWaitProbeMs: 1000 },
    ask: () => answer.promise,
  })
  host.adapter.rootScript = () => {
    const snapshot = host.storage.journal.readSnapshot(host.root.id)
    if (!snapshot.run) return toolChunks('workflow_propose', proposal(snapshot.revision))
    if (!snapshot.run.gates.some(gate => gate.status === 'approved')) return toolChunks('workflow_confirm', { expectedRevision: snapshot.revision })
    return textChunks('已记录确认；本测试不派发实现。')
  }
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: '插件门禁等待回归' }], source: { kind: 'user' } }))
  try {
    await waitFor(() => host.nativeQuestions.length === 1, 'real plugin confirmation')
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
    const before = host.storage.journal.readSnapshot(host.root.id)
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.equal(host.nativeQuestions[0].signal.aborted, false)
    assert.equal(host.storage.journal.readSnapshot(host.root.id).revision, before.revision)
    assert.equal(before.run.gates[0].status, 'waiting')
  } finally {
    answer.resolve({ answers: [{ id: host.nativeQuestions[0]?.questions[0].id, selected: [Control.CONFIRM_LABEL] }] })
    await host.root.whenIdle()
  }
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  const snapshot = host.storage.journal.readSnapshot(host.root.id)
  assert.equal(snapshot.preRunRecovery, null)
  assert.equal(snapshot.run.gates[0].status, 'approved')
  assert.equal(snapshot.run.agents.length, 0)
})

test('aborted plugin confirmation cannot retain an exemption or accept a late answer', timeout, async t => {
  const answer = Promise.withResolvers()
  const host = await harness(t, { ask: () => answer.promise })
  const cancel = new AbortController()
  await host.ctx.workflowController.propose(host.root, proposal(0), signal)
  const confirm = host.ctx.workflowController.confirm(host.root,
    { expectedRevision: host.storage.journal.readSnapshot(host.root.id).revision }, cancel.signal)
  const outcome = confirm.then(value => ({ value }), error => ({ error }))
  try {
    await waitFor(() => host.nativeQuestions.length === 1, 'cancellable plugin confirmation')
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), true)
    cancel.abort(new Error('test gate caller cancelled'))
    assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false,
      'an internal gate entry must not override the native aborted lifetime')
  } finally {
    answer.resolve({ answers: [{ id: host.nativeQuestions[0]?.questions[0].id, selected: [Control.CONFIRM_LABEL] }] })
  }
  assert.ok((await outcome).error)
  assert.equal(host.ctx.workflowController.isAwaitingUser(host.root), false)
  assert.equal(host.storage.journal.readSnapshot(host.root.id).run.gates.some(gate => gate.status === 'approved'), false)
})

test('official preset hides coordinator capabilities while preserving a child-inheritable substrate and final guard', timeout, async t => {
  const host = await harness(t)
  const substrate = host.ctx.tools.schemas(host.root).map(tool => tool.name)
  for (const name of PROJECT_NATIVE_TOOL_NAMES) assert.ok(substrate.includes(name), `${name} remains inheritable by project roles`)
  assert.equal(host.ctx.tools.schemas().some(tool => tool.name.startsWith('workflow_')), false)
  const initialView = await host.ctx.systemPrompt.assemble({ scope: host.root })
  assert.deepEqual(initialView.tools.map(item => item.name).sort(), [...Control.ROOT_TOOLS].sort())
  host.ctx.on('tools/pre-execute', () => ({ kind: 'allow' }))
  const denied = await tool(host, 'dangerous_test_tool', {})
  assert.equal(denied.isError, true)
  // Even an exact-scope late registration cannot bypass the standing guard.
  let localCalled = false
  host.root.ctx.tools.register(defineTool({ name: 'late_mutator', description: 'test-only no-op', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: () => { localCalled = true; return 'bad' },
  }))
  assert.equal((await tool(host, 'late_mutator', {})).isError, true)
  const assembled = await host.ctx.systemPrompt.assemble({ scope: host.root })
  assert.deepEqual(assembled.tools.map(item => item.name).sort(), [...Control.ROOT_TOOLS].sort(), 'late local registrations cannot expand the model-facing tool list')
  assert.equal(localCalled, false)
  assert.equal(host.forbiddenCalls(), 0)
  const status = await tool(host, 'workflow_status', {})
  assert.equal(status.isError, false)
  assert.equal(JSON.parse(status.value.result).snapshot.run, null)
  const forged = await tool(host, 'workflow_status', {}, { id: host.root.id, ctx: host.root.ctx })
  assert.equal(forged.isError, true)
})

test('root prompt excludes the conflicting Crew contributions but preserves native policy and other modes', timeout, async t => {
  const host = await harness(t)
  const sibling = await host.ctx.agents.create({
    sessionId: SessionId(`plain-sibling-${randomUUID()}`), meta: { cwd: host.directory },
    agentOptions: { provider: 'scripted', model: 'test-only' },
  })
  const root = await host.ctx.systemPrompt.assemble({ scope: host.root })
  assert.equal(root.sections.some(item => item.name === 'crew:pm'), false)
  assert.equal(root.contexts.some(item => item.name === 'crew:jobs'), false)
  assert.ok(root.sections.some(item => item.name === 'harness:identity'))
  assert.ok(root.sections.some(item => item.name === 'deployment:persona-prefix' && item.text.includes('工作流')))
  assert.ok(root.sections.some(item => item.text.includes('HOST_PRIVATE_SECTION')), 'do not replace the whole root prompt')
  for (const name of ['sandbox:policy', 'approval:policy', 'test:private-context']) {
    assert.ok(root.contexts.some(item => item.name === name), `preserve ${name}`)
  }
  for (const scope of [undefined, sibling.agent]) {
    const other = await host.ctx.systemPrompt.assemble({ scope })
    assert.ok(other.sections.some(item => item.name === 'crew:pm'))
    assert.ok(other.contexts.some(item => item.name === 'crew:jobs'))
    assert.ok(other.tools.some(item => item.name === 'dangerous_test_tool'), 'unrelated modes keep their own tool surface')
  }
  // Cooperative assembly middleware added after the root exists still runs
  // before the scoped final projection. Filtering is by contribution name,
  // never by searching user text for the word Crew.
  host.ctx.on('system-prompt/assemble', async (_input, _context, next) => {
    const current = await next()
    return { ...current,
      sections: [...current.sections.filter(item => item.name !== 'crew:pm'), { name: 'crew:pm', text: 'CREW_LATE_SENTINEL' }],
      contexts: [...current.contexts.filter(item => item.name !== 'crew:jobs'), { name: 'crew:jobs', text: 'CREW_LATE_JOB_SENTINEL' }],
    }
  })
  host.root.ctx.systemPrompt.section({ name: 'user:instructions', order: 7, text: 'User instruction mentioning Crew must remain.' })
  const refreshed = await host.ctx.systemPrompt.assemble({ scope: host.root })
  assert.equal(refreshed.sections.some(item => item.name === 'crew:pm'), false)
  assert.equal(refreshed.contexts.some(item => item.name === 'crew:jobs'), false)
  assert.ok(refreshed.sections.some(item => item.name === 'user:instructions'))
})

test('durable delegation cannot acquire root authority merely by mounting the same preset', timeout, async t => {
  const host = await harness(t)
  for (const lineage of [
    { origin: 'subagent', parentSession: host.root.id, delegationDepth: 1 },
    { origin: 'subagent' },
    { delegationDepth: 1 },
  ]) {
    const { agent } = await host.ctx.agents.create({
      sessionId: SessionId(`delegated-${randomUUID()}`),
      meta: { cwd: host.directory, agentPreset: Control.WORKFLOW_PRESET_ID, ...lineage },
      agentOptions: { provider: 'scripted', model: 'test-only' },
      setup: async agentCtx => { await host.ctx.agentPresets.mount(agentCtx, Control.WORKFLOW_PRESET_ID) },
    })
    assert.ok(host.ctx.agents.roots().includes(agent), 'runtime ownership alone does not establish coordinator authority')
    assert.throws(() => host.ctx.workflowController.bindRoot(agent), /有效的原生根 Agent/)
    assert.equal((await tool(host, 'workflow_status', {}, agent)).isError, true)
    assert.equal(host.storage.journal.readSnapshot(agent.id).revision, 0)
  }
  const fork = await host.ctx.agents.create({
    sessionId: SessionId(`user-fork-${randomUUID()}`),
    meta: { cwd: host.directory, agentPreset: Control.WORKFLOW_PRESET_ID, parentSession: host.root.id },
    agentOptions: { provider: 'scripted', model: 'test-only' },
    setup: async agentCtx => { await host.ctx.agentPresets.mount(agentCtx, Control.WORKFLOW_PRESET_ID) },
  })
  assert.equal((await tool(host, 'workflow_status', {}, fork.agent)).isError, false, 'ordinary user forks are not delegated children')
})

test('native blank-session preset selection binds on entry and releases Workflow restrictions on exit', timeout, async t => {
  const host = await harness(t)
  const keeper = host.root
  const { agent } = await host.ctx.agents.create({
    sessionId: SessionId(`switchable-${randomUUID()}`), meta: { cwd: host.directory, agentPreset: 'plain-test' },
    agentOptions: { provider: 'scripted', model: 'test-only' },
    setup: async agentCtx => { await host.ctx.agentPresets.mount(agentCtx, 'plain-test') },
  })
  const read = () => host.ctx.systemPrompt.assemble({ scope: agent })
  const original = await read()
  assert.ok(original.tools.some(item => item.name === 'dangerous_test_tool'))
  const select = async id => {
    // Mirror official ApiProxy.agentPresets.select: the durable event follows
    // the successful re-link. No replacement Agent or model request is made.
    await host.ctx.agentPresets.recompose(agent.ctx, id)
    agent.session.append('agent-preset/selected', { agentPreset: id })
    assert.equal(host.ctx.agents.get(agent.id), agent)
  }
  for (let round = 0; round < 2; round++) {
    await select(Control.WORKFLOW_PRESET_ID)
    await waitFor(() => host.ctx.commands.list(agent).some(item => item.name === 'workflow-budget'), 'scoped native command appears')
    const workflow = await read()
    assert.deepEqual(workflow.tools.map(item => item.name).sort(), [...Control.ROOT_TOOLS].sort())
    assert.equal(workflow.sections.some(item => item.name === 'crew:pm'), false)
    assert.equal((await tool(host, 'workflow_status', {}, agent)).isError, false)
    assert.equal((await tool(host, 'dangerous_test_tool', {}, agent)).isError, true)
    await select('plain-test')
    await waitFor(() => !host.ctx.commands.list(agent).some(item => item.name === 'workflow-budget'), 'scoped native command released')
    assert.equal(await host.ctx.commands.execute(agent, '/workflow-budget', [], signal), undefined)
    const restored = await read()
    assert.deepEqual(restored.tools.map(item => item.name).sort(), original.tools.map(item => item.name).sort())
    assert.ok(restored.sections.some(item => item.name === 'crew:pm'))
    assert.ok(restored.contexts.some(item => item.name === 'crew:jobs'))
    assert.equal((await tool(host, 'dangerous_test_tool', {}, agent)).isError, false)
    const unchanged = await host.ctx.systemPrompt.assemble({ scope: keeper })
    assert.deepEqual(unchanged.tools.map(item => item.name).sort(), [...Control.ROOT_TOOLS].sort())
    assert.equal(unchanged.sections.some(item => item.name === 'crew:pm'), false)
  }
  assert.equal(host.adapter.requests.length, 0)
  assert.equal(host.storage.journal.readSnapshot(agent.id).revision, 0)
})

test('real native loops run proposal → human-provider gate → child → QA failure → same-ID cold rework → PASS', timeout, async t => {
  const host = await harness(t)
  const starts = [], ends = [], versions = []
  const delegatedActivations = []
  host.ctx.on('agent/created', ({ agent }) => {
    if (!host.ctx.workflowController.ownsChild(agent.id)) return
    delegatedActivations.push(agent.id)
    assert.equal(agent.session.header.origin, 'subagent')
    assert.equal(host.ctx.agents.roots().includes(agent), false, 'an official continuable child is not a runtime root')
    assert.equal(host.ctx.agents.isOwnedBy(agent.id, host.root), true, 'the durable parent owns the live activation')
    assert.throws(() => host.ctx.workflowController.bindRoot(agent), /有效的原生根 Agent/)
  })
  host.ctx.on('subagent/start', info => starts.push(info))
  host.ctx.on('subagent/end', info => ends.push(info))
  host.storage.journal.subscribe(snapshot => { versions.push(snapshot); })
  host.adapter.drive = true
  host.root.followup(createUserMessage({ content: [{ type: 'text', text: 'PM_PRIVATE_TRANSCRIPT：请生成简短测试公告。这段父会话不能交给子 Agent。' }], source: { kind: 'user' } }))
  try { await waitFor(() => host.storage.journal.readSnapshot(host.root.id).run?.outcome === 'PASS' || host.adapter.errors.length > 0, 'full native text workflow') }
  catch (error) {
    const events = host.root.session.snapshotEvents()
    throw new Error(`${error.message}\n${JSON.stringify({
      snapshot: host.storage.journal.readSnapshot(host.root.id),
      adapterErrors: host.adapter.errors.map(item => item instanceof Error ? { name: item.name, message: item.message } : String(item)),
      failedTools: events.filter(event => event.type === 'tool/result'
        && event.data.message.content.some(block => block.type === 'tool-result' && block.isError)),
      errors: events.filter(event => event.type === 'agent/error' || event.type === 'turn/end').slice(-8),
      calls: host.adapter.requests.length,
      runtimeErrors: host.runtimeErrors,
    })}`, { cause: error })
  }
  assert.deepEqual(host.adapter.errors, [])
  await host.root.whenIdle()
  const snapshot = host.storage.journal.readSnapshot(host.root.id)
  assert.equal(snapshot.run.outcome, 'PASS')
  assert.equal(snapshot.run.ledger.pass, 2)
  assert.equal(snapshot.run.agents.length, 2)
  assert.equal(host.nativeQuestions.length, 1)
  assert.equal(host.nativeQuestions[0].agent, host.root)
  assert.equal(starts.length, 4)
  assert.equal(ends.length, 4)
  assert.equal(new Set(starts.map(info => info.id)).size, 2)
  assert.equal(new Set(starts.map(info => info.runId)).size, 4)
  assert.equal(delegatedActivations.length, 4, 'both creation and cold rework retain child-only authority')
  assert.ok(ends.every(info => info.stopReason === 'completed'))
  assert.ok(snapshot.run.agents.every(agent => host.ctx.agents.get(SessionId(agent.agentSessionId)) === undefined), 'children are genuinely cold after each completed activation')
  assert.ok(versions.some(value => value.run?.ledger.fail === 1))
  const failedIndex = versions.findIndex(value => value.run?.ledger.fail === 1)
  assert.ok(versions.slice(failedIndex + 1).some(value => value.run?.ledger.pending === 2 && value.run?.ledger.pass === 0))
  const delivered = await host.ctx.workflowController.status(host.root)
  assert.equal(delivered.deliverable.text, '测试功能已就绪')
  assert.equal(delivered.deliverable.version, 2)
  assert.equal(host.forbiddenCalls(), 0)
  assert.equal(snapshot.run.budget.used.rootModel + snapshot.run.budget.used.childModel,
    host.adapter.requests.length - 1, 'all loop calls including same-ID rework count once, excluding pre-run creation')
})

test('native project roles receive exact tools and Host-observed results across the real AgentLoop', timeout, async t => {
  const host = await harness(t)
  await mkdir(join(host.directory, 'src'), { recursive: true })
  host.adapter.projectDrive = true
  const activations = new Map()
  host.ctx.on('agent/created', ({ agent }) => {
    if (!host.ctx.workflowController.ownsChild(agent.id)) return
    const policy = host.ctx.workflowController.childPolicy(agent)
    const sandboxMode = [...agent.session.snapshotEvents()].reverse().find(event => event.type === 'sandbox/mode')?.data.mode
    activations.set(policy.role, { id: agent.id, sandboxMode })
  })
  const invoke = async (name, input) => {
    const result = await tool(host, name, input)
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`)
    return result
  }
  const revision = () => host.storage.journal.readSnapshot(host.root.id).revision
  await invoke('workflow_propose', projectProposal(revision()))
  await invoke('workflow_confirm', { expectedRevision: revision() })
  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => {
    const run = host.storage.journal.readSnapshot(host.root.id).run
    return host.adapter.errors.length > 0 || (run?.tasks.find(item => item.taskId === 'implementation')?.status === 'completed'
      && run.agents.find(item => item.taskId === 'implementation')?.status === 'idle')
  }, 'native project implementation')
  assert.deepEqual(host.adapter.errors, [])
  await host.root.whenIdle()

  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => {
    const run = host.storage.journal.readSnapshot(host.root.id).run
    return host.adapter.errors.length > 0 || ['engineering-test', 'code-review'].every(taskId =>
      run?.tasks.find(item => item.taskId === taskId)?.status === 'completed'
      && run.agents.find(item => item.taskId === taskId)?.status === 'idle')
  }, 'parallel native project checks').catch(error => {
    const snapshot = host.storage.journal.readSnapshot(host.root.id)
    const state = host.storage.journal.readRunState(host.root.id, snapshot.run.runId)
    throw new Error(`${error.message}: ${JSON.stringify({ agents: snapshot.run.agents, commands: state.commands, shellModes: host.observedShellModes })}`)
  })
  assert.deepEqual(host.adapter.errors, [])
  await host.root.whenIdle()

  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => {
    const run = host.storage.journal.readSnapshot(host.root.id).run
    return host.adapter.errors.length > 0 || (run?.tasks.find(item => item.taskId === 'acceptance')?.status === 'completed'
      && run.agents.find(item => item.taskId === 'acceptance')?.status === 'idle')
  }, 'source-isolated native acceptance')
  assert.deepEqual(host.adapter.errors, [])
  await host.root.whenIdle()
  await invoke('workflow_advance', { expectedRevision: revision() })

  const snapshot = host.storage.journal.readSnapshot(host.root.id)
  assert.equal(snapshot.run.outcome, 'PASS')
  assert.equal((await readFile(join(host.directory, 'src', 'native.js'), 'utf8')), 'export const nativeReady = true\n')
  const byRole = role => host.adapter.toolViews.get(activations.get(role).id)
  assert.deepEqual(byRole('engineer'), ['edit', 'glob', 'grep', 'read', 'workflow_packet', 'workflow_report', 'write'].sort())
  assert.deepEqual(byRole('test_engineer'), ['glob', 'grep', 'pwsh', 'read', 'workflow_packet', 'workflow_report'].sort())
  assert.deepEqual(byRole('code_reviewer'), ['glob', 'grep', 'read', 'workflow_packet', 'workflow_report'].sort())
  assert.deepEqual(byRole('acceptance_qa'), ['pwsh', 'workflow_packet', 'workflow_report'].sort())
  assert.equal(activations.get('engineer').sandboxMode, 'workspace-write')
  assert.equal(activations.get('test_engineer').sandboxMode, process.platform === 'win32' ? undefined : 'workspace-write')
  assert.equal(activations.get('code_reviewer').sandboxMode, 'read-only')
  assert.equal(activations.get('acceptance_qa').sandboxMode, process.platform === 'win32' ? undefined : 'workspace-write')
  assert.deepEqual(host.observedShellModes, process.platform === 'win32'
    ? ['danger-full-access', 'danger-full-access']
    : ['workspace-write', 'workspace-write'])
  const state = host.storage.journal.readRunState(host.root.id, snapshot.run.runId)
  const checkpoint = state.checkpoints['implementation@1']
  assert.ok(checkpoint, 'the official tools/execute seam captured the implementation checkpoint')
  assert.equal(checkpoint.files['src/native.js'].before.kind, 'absent')
  assert.equal(checkpoint.files['src/native.js'].after.kind, 'file')
  assert.ok(Object.values(state.evidence).some(item => item.taskId === 'engineering-test' && item.verdict === 'pass'))
  assert.ok(Object.values(state.evidence).some(item => item.taskId === 'acceptance' && item.verdict === 'pass'))
  assert.equal(snapshot.run.budget.used.rootModel + snapshot.run.budget.used.childModel, host.adapter.requests.length)
  assert.equal(snapshot.run.budget.used.commands, 2)
})

test('native ToolRuntime cancellation and continuable drain converge after an independent frozen-command timeout', timeout, async t => {
  let spawns = 0
  const host = await harness(t, {
    childConfig: { commandTimeoutMs: 1000, commandExitGraceMs: 2000 },
    commandHandle: spec => {
      spawns++
      const done = Promise.withResolvers()
      const stop = () => done.resolve({ exitCode: 1, signal: null })
      spec.signal.addEventListener('abort', stop, { once: true })
      return { collected: {}, done: done.promise, terminate: stop, waitForExit: async () => { await done.promise; return true } }
    },
  })
  await mkdir(join(host.directory, 'src'), { recursive: true })
  host.adapter.projectDrive = true
  const revision = () => host.storage.journal.readSnapshot(host.root.id).revision
  const invoke = async (name, input) => {
    const result = await tool(host, name, input)
    assert.equal(result.isError, false, JSON.stringify(result))
  }
  await invoke('workflow_propose', projectProposal(0))
  await invoke('workflow_confirm', { expectedRevision: revision() })
  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => host.storage.journal.readSnapshot(host.root.id).run.agents[0]?.status === 'idle', 'implementation before command timeout')
  await host.root.whenIdle()
  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => {
    const agents = host.storage.journal.readSnapshot(host.root.id).run.agents
    return agents.find(item => item.role === 'test_engineer')?.runtimeIssue?.status === 'stopped'
      && agents.find(item => item.role === 'code_reviewer')?.status === 'idle'
  }, 'command timeout fully converged while reviewer completes')
  const snapshot = host.storage.journal.readSnapshot(host.root.id)
  const state = host.storage.journal.readRunState(host.root.id, snapshot.run.runId)
  assert.equal(snapshot.run.agents.find(item => item.role === 'test_engineer').runtimeIssue.cause, 'command-timeout')
  assert.equal(Object.values(state.commands)[0].status, 'interrupted')
  assert.equal(Object.values(state.commands)[0].observation.exitConfirmed, true)
  assert.equal(Object.values(state.evidence).filter(item => item.verdict === 'fail').length, 0)
  assert.equal(state.returns.length, 0); assert.equal(spawns, 1)
  await host.root.whenIdle()
})

test('real native child timeout drains only the stalled parallel role and preserves its completed sibling', timeout, async t => {
  const host = await harness(t, { childConfig: {
    childAdmissionMs: 2000, childNoProgressMs: 1000, childMaxRunMs: 5000,
    childReportGraceMs: 1000, childCancelGraceMs: 2000,
  } })
  await mkdir(join(host.directory, 'src'), { recursive: true })
  host.adapter.projectDrive = true
  const revision = () => host.storage.journal.readSnapshot(host.root.id).revision
  const invoke = async (name, input) => {
    const result = await tool(host, name, input)
    assert.equal(result.isError, false, JSON.stringify(result))
  }
  await invoke('workflow_propose', projectProposal(0))
  await invoke('workflow_confirm', { expectedRevision: revision() })
  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => host.storage.journal.readSnapshot(host.root.id).run.agents[0]?.status === 'idle', 'implementation settled before timeout test')
  await host.root.whenIdle()
  let stalledChild
  host.adapter.holdChild = async options => {
    const child = host.ctx.agents.get(options.sessionId)
    if (host.ctx.workflowController.childPolicy(child).role !== 'test_engineer') return
    stalledChild = child
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(options.signal.reason)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  await invoke('workflow_advance', { expectedRevision: revision() })
  await waitFor(() => host.storage.journal.readSnapshot(host.root.id).run.agents
    .find(agent => agent.role === 'test_engineer')?.runtimeIssue?.status === 'stopped', 'real timeout cancellation and drain', 6000)
  const snapshot = host.storage.journal.readSnapshot(host.root.id)
  const stalled = snapshot.run.agents.find(agent => agent.role === 'test_engineer')
  const sibling = snapshot.run.agents.find(agent => agent.role === 'code_reviewer')
  assert.equal(stalled.runtimeIssue.cause, 'no-progress')
  assert.equal(stalled.status, 'interrupted')
  assert.equal(sibling.status, 'idle')
  assert.equal(sibling.runtimeIssue, undefined)
  assert.equal(snapshot.run.tasks.find(task => task.taskId === 'code-review').status, 'completed')
  assert.equal(snapshot.run.tasks.find(task => task.taskId === 'engineering-test').status, 'blocked')
  assert.equal(snapshot.run.ledger.fail, 0)
  assert.equal(snapshot.run.latestReturn, null)
  assert.equal(snapshot.run.outcome, null)
  assert.equal(host.ctx.agents.get(stalledChild.id), undefined)
  assert.equal(host.ctx.agents.get(host.root.id), host.root)
  assert.ok(host.ctx.workflowController.guard(stalledChild, 'workflow_report'))
  assert.equal((await tool(host, 'workflow_advance', { expectedRevision: revision() })).isError, true)
  assert.equal(host.storage.journal.readSnapshot(host.root.id).run.agents.length, 3, 'no duplicate replacement or downstream acceptance')
})

test('real running child loses every capability when stopped; unrelated roots are untouched', timeout, async t => {
  const host = await harness(t, { reportAfterController: true })
  const other = await host.ctx.agents.create({
    sessionId: SessionId(`unrelated-${randomUUID()}`), meta: { cwd: host.directory, agentPreset: Control.WORKFLOW_PRESET_ID },
    agentOptions: { provider: 'scripted', model: 'test-only' },
    setup: async agentCtx => { await host.ctx.agentPresets.mount(agentCtx, Control.WORKFLOW_PRESET_ID) },
  })
  const entered = Promise.withResolvers()
  host.adapter.holdChild = async options => {
    entered.resolve(options.sessionId)
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) { reject(options.signal.reason); return }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  const proposed = await tool(host, 'workflow_propose', proposal(0))
  assert.equal(proposed.isError, false, JSON.stringify(proposed))
  const confirmed = await tool(host, 'workflow_confirm', {
    expectedRevision: host.storage.journal.readSnapshot(host.root.id).revision,
  })
  assert.equal(confirmed.isError, false, JSON.stringify(confirmed))
  const revision = host.storage.journal.readSnapshot(host.root.id).revision
  const result = await tool(host, 'workflow_advance', { expectedRevision: revision })
  assert.equal(result.isError, false, JSON.stringify(result))
  await waitFor(() => host.adapter.errors.length > 0 || host.adapter.requests.some(options => options.sessionId !== host.root.id), 'child model activation')
  assert.deepEqual(host.adapter.errors, [])
  const childId = await entered.promise
  const child = host.ctx.agents.get(childId)
  assert.ok(child)
  assert.ok(host.ctx.tools.get('send_message'), 'the actual official control contribution remains globally registered')
  assert.equal(host.ctx.tools.get('send_message', child), undefined, 'the child restriction hides native control from its model scope')
  const assembled = await host.ctx.systemPrompt.assemble({ scope: child })
  assert.deepEqual(assembled.tools.map(item => item.name).sort(), [...Control.CHILD_TOOLS].sort())
  const deniedControl = await host.ctx.tools.execute({ agent: child, name: 'send_message', callId: ToolCallId(randomUUID()),
    arguments: { agent_id: host.root.id, message: 'This native control message must not reach the parent.' }, signal })
  assert.equal(deniedControl.isError, true)
  assert.match(texts(deniedControl).join('\n'), /子 Agent 只允许/, 'deny at the capability guard, not because of malformed arguments')
  assert.equal((await tool(host, 'workflow_confirm', { expectedRevision: revision }, child)).isError, true)
  assert.equal((await tool(host, 'dangerous_test_tool', {}, child)).isError, true)
  const stopped = await tool(host, 'workflow_stop', {})
  assert.equal(stopped.isError, false, JSON.stringify(stopped))
  assert.equal(host.storage.journal.readSnapshot(host.root.id).run.outcome, 'CANCELLED')
  assert.equal(host.ctx.agents.get(childId), undefined)
  assert.equal(host.ctx.agents.get(host.root.id), host.root)
  assert.equal(host.ctx.agents.get(other.agent.id), other.agent)
  assert.equal(host.storage.journal.readSnapshot(other.agent.id).revision, 0)
})
