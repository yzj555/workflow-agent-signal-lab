/** Native test Host in a disposable directory. The parent may kill ONLY this child handle. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { registerFixturePresets } from './declarative-preset-fixture.mjs'
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
import * as Control from '../../lib/workflow-control.js'
import * as Engine from '../../lib/workflow-engine.js'
import { openWorkflowStorage } from '../../lib/workflow-runtime.js'
import { proposal } from './workflow-controller-fixture.mjs'
import { collectActiveLearningRules } from '../../lib/index.js'

const [inputDirectory, mode, token] = process.argv.slice(2)
const directory = await realpath(inputDirectory)
const temporaryRoot = await realpath(tmpdir())
assert.match(relative(temporaryRoot, directory), /^workflow-crash-matrix-[^\\/]+$/u)
const fixture = JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8'))
assert.equal(fixture.token, token)
const rollbackModes = ['rollback-before', 'rollback-backed', 'rollback-installed', 'rollback-applied', 'rollback-cleanup']
const criticalModes = ['file-write', 'implemented', 'rework', 'reworked', 'delivery', 'learning', ...rollbackModes]
const gateModes = ['requirements-gate', 'execution-gate', 'text-gate', 'local-execution-gate']
assert.ok(['child-model', 'root-time-cap', 'command', 'pending-gate', 'cold', 'lock-probe', ...criticalModes, ...gateModes].includes(mode))
const scenario = fixture.scenario ?? mode
const labRoot = resolve(import.meta.dirname, '../..')
const rootId = SessionId(fixture.rootId)
const signal = new AbortController().signal
const send = data => new Promise((resolve, reject) => process.send(data, error => error ? reject(error) : resolve()))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// Independent fuse; an interrupted harness must not leave a long-lived Host.
const fuse = setTimeout(() => process.exit(98), 60000)
process.on('disconnect', () => process.exit(97))
async function waitFor(check, label, timeout = 12000) {
  const until = Date.now() + timeout
  while (!(await check())) { if (Date.now() > until) throw new Error('Timed out: ' + label); await delay(10) }
}
function hold(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
function textChunks(text) {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function toolChunks(name, input, wrapped = true) {
  const id = ToolCallId(randomUUID()), args = JSON.stringify(wrapped ? { input } : input)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class TestQuery extends SessionQueryEngine {
  searchSessions() { throw new Error('No session search in isolated crash fixture') }
  searchEvents() { throw new Error('No event search in isolated crash fixture') }
}
let ctx, root, engine, adapter, pendingQuestion, pendingWork
let fileWriteCut = false, learningRound = 0, holdLearning = false, questionReply = 'accept'
let explicitDispatch = false
let rollbackCut = false
const criticalCommand = 'node --test recovery-check.test.cjs'
const originalSource = 'export const nativeReady = "original"\n'
const questions = []
const activity = [], issues = []
class CrashAdapter extends LlmAdapter {
  requests = []
  steps = new Map()
  holdRoot = false
  async *stream(options) {
    const entry = { sessionId: options.sessionId, at: Date.now(), held: false }
    this.requests.push(entry)
    if (this.requests.length > 50) throw new Error('Fixture request fuse exceeded')
    let chunks
    if (options.sessionId === rootId) {
      if (this.holdRoot) { entry.held = true; await hold(options.signal) }
      chunks = textChunks('隔离验证：不自动推进。')
    } else {
      const child = ctx.agents.get(options.sessionId)
      const policy = ctx.workflowController.childPolicy(child)
      entry.role = policy.role
      if (mode === 'child-model') { entry.held = true; await hold(options.signal) }
      assert.ok(mode === 'command' || criticalModes.includes(mode) || gateModes.includes(mode) || (mode === 'cold' && explicitDispatch), 'Cold Host must not dispatch an old child automatically')
      assert.deepEqual((options.tools ?? []).map(tool => tool.name).sort(), [...policy.tools].sort())
      const packet = ctx.workflowController.packet(child)
      const key = `${options.sessionId}:${packet.taskVersion}`
      const step = this.steps.get(key) ?? 0
      this.steps.set(key, step + 1)
      const firstRework = ['rework', 'reworked'].includes(scenario) && !ctx.workflowJournal.readRunState(rootId, snapshot().run.runId).returns.length
      if (step === 0) chunks = toolChunks('workflow_packet', {})
      else if (policy.role === 'engineer' && scenario === 'text-gate') chunks = toolChunks('workflow_report', {
        role: 'engineer', text: '这是测试功能公告。',
      })
      else if (policy.role === 'architect' && gateModes.includes(scenario)) chunks = toolChunks('workflow_report', {
        role: 'architect', summary: '保留公开入口，只调整受控模块的实现。',
        decisions: [{ id: 'ADR-1', decision: '沿用 nativeReady 导出', rationale: '保持调用接口稳定' }],
        affectedAreas: ['src/native.js'], interfaces: ['nativeReady 导出'], rollback: ['恢复原始模块内容'],
      })
      else if (policy.role === 'engineer' && step === 1) chunks = toolChunks('write', {
        file_path: 'src/native.js', content: `export const nativeReady = ${firstRework ? 'false' : 'true'}\n`,
      }, false)
      else if (policy.role === 'engineer' && rollbackModes.includes(scenario) && step === 2) chunks = toolChunks('write', {
        file_path: 'src/added.txt', content: 'new implementation file\n',
      }, false)
      else if (policy.role === 'engineer' && rollbackModes.includes(scenario) && step === 3) chunks = toolChunks('write', {
        file_path: 'src/other.txt', content: 'changed binary predecessor\n',
      }, false)
      else if (policy.role === 'engineer') chunks = toolChunks('workflow_report', {
        role: 'engineer', summary: '受控临时文件已写入', changedFiles: rollbackModes.includes(scenario) ? ['src/added.txt', 'src/native.js', 'src/other.txt'] : ['src/native.js'], notes: [],
      })
      else if (policy.role === 'test_engineer' && step === 1) chunks = toolChunks('pwsh', {
        command: criticalModes.includes(scenario) || gateModes.includes(scenario) ? criticalCommand : 'node --test budget-probe.test.cjs', description: 'Isolated bounded crash fixture',
      }, false)
      else if (policy.role === 'test_engineer') chunks = toolChunks('workflow_report', {
        role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: firstRework ? 'FAIL' : 'PASS', observation: firstRework ? '真实冻结测试发现公开行为尚未就绪' : '冻结命令已退出' }],
      })
      else if (policy.role === 'code_reviewer') chunks = toolChunks('workflow_report', {
        role: 'code_reviewer', status: 'PASS', summary: '隔离夹具固定审查结果', findings: [],
      })
      else if (policy.role === 'acceptance_qa' && step === 1) chunks = toolChunks('pwsh', {
        command: criticalCommand, description: 'Run the frozen public-behavior check',
      }, false)
      else if (policy.role === 'acceptance_qa') chunks = toolChunks('workflow_report', {
        role: 'acceptance_qa', results: [{ criterionId: 'AC-1', status: 'PASS', checkIds: ['ACC-1'], observation: '当前公开行为的真实黑盒命令已通过' }],
      })
      else throw new Error('Unexpected child role in crash fixture: ' + policy.role)
    }
    for (const chunk of chunks) { options.signal.throwIfAborted(); yield chunk }
  }
}
async function mountTools() {
  const overrideOf = session => [...session.snapshotEvents()].reverse().find(event => event.type === 'sandbox/mode')?.data.mode
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', overrideOf,
    resolve: ({ session } = {}) => ({ mode: (session && overrideOf(session)) ?? 'danger-full-access', workspaceRoot: directory }) })
  ctx.provide('shellEnv', { collect: () => ({}) })
  ctx.provide('sandbox', { confine() { throw new Error('No confinement or elevation requested by this fixture') } })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxPwshExecutor, { cwd: directory, timeoutMs: 45000, maxTimeoutMs: 45000, graceMs: 200 })
  ctx.provide('fs', {
    sandboxMode: 'workspace-write',
    async resolve(candidate, options = {}) {
      const target = resolve(options.cwd ?? directory, candidate)
      assert.ok(target === directory || target.startsWith(directory + '\\'), 'Fixture cannot write outside its temporary workspace')
      return { targetKey: target, displayPath: target }
    },
    processPath: target => target.targetKey,
    fileUrl: target => pathToFileURL(target.targetKey).href,
    contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '\\'),
    async writeText(target, content) {
      await mkdir(dirname(target.targetKey), { recursive: true })
      let before = null
      try { before = await readFile(target.targetKey, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (mode === 'file-write') {
        // Real partial bytes, after the Host captured the before-image, before
        // the native tool resolves or any file-observed/artifact is committed.
        await writeFile(target.targetKey, content.slice(0, Math.floor(content.length / 2)), 'utf8')
        fileWriteCut = true
        await hold(new AbortController().signal) // Parent kills ONLY this test Host.
      }
      await writeFile(target.targetKey, content, 'utf8')
      return { operation: before === null ? 'create' : 'update', version: `v-${Date.now()}`, before, after: content }
    },
  })
}
const snapshot = () => ctx.workflowJournal.readSnapshot(rootId)
function receipt() {
  const view = snapshot()
  return { pid: process.pid, mode, snapshot: view,
    state: view.run ? ctx.workflowJournal.readRunState(rootId, view.run.runId) : null,
    requests: adapter.requests, activity, issues,
    questions, activeRules: collectActiveLearningRules(ctx.workflowJournal.readAllRunStates()),
    nativeQuestion: pendingQuestion && { question: pendingQuestion.questions[0], agentId: pendingQuestion.agent.id },
    liveAgents: ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status })) }
}
async function invoke(name, input = { expectedRevision: snapshot().revision }) {
  const result = await ctx.tools.execute({ agent: root, name, callId: ToolCallId(randomUUID()), arguments: { input }, signal })
  assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`)
  return result
}
async function prompt(text) {
  root.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await root.whenIdle()
}
async function initialize() {
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(labRoot).href + '/'
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: join(directory, 'sessions') })
  await ctx.plugin(TestQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountTools()
  await registerFixturePresets(ctx, labRoot, Control.WORKFLOW_PRESET_ID)
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(NativeControl)
  await ctx.plugin(Questions)
  await ctx.plugin(Commands)
  ctx.on('agent/created', ({ agent }) => { activity.push({ event: 'agent/created', id: agent.id }); return undefined }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (['command/started', 'tool/start', 'turn/start'].includes(event.type)) activity.push({ event: event.type, id: session.id })
    if (event.type === 'turn/end' && event.data.reason?.kind === 'error') issues.push({ id: session.id, reason: event.data.reason })
  }, { global: true })
  ctx.on('user-questions/request', request => {
    questions.push({ ids: request.questions.map(q => q.id), headers: request.questions.map(q => q.header), details: request.questions.map(q => q.detail) })
    if (gateModes.includes(scenario) && request.questions[0].intent?.kind === 'plan-review') {
      const question = request.questions[0]
      const pendingHeader = { 'requirements-gate': '需求理解', 'execution-gate': '执行授权',
        'text-gate': '需求确认', 'local-execution-gate': '执行授权' }[mode]
      if (pendingHeader === question.header) {
        pendingQuestion = request
        return hold(request.signal)
      }
      return { answers: [{ id: questionReply === 'old' ? fixture.oldQuestionId : question.id,
        selected: questionReply === 'reject' ? [] : [question.intent.approve],
        ...(questionReply === 'reject' ? { custom: '暂不授权，请继续澄清。' } : {}),
      }] }
    }
    if (request.questions[0].header === '撤销确认') return { answers: [{
      id: questionReply === 'old' ? fixture.oldQuestionId : request.questions[0].id,
      selected: [questionReply === 'reject' ? request.questions[0].options[1].label : request.questions[0].intent.approve],
    }] }
    if (request.questions[0].question === '这条规则的内容和生效范围是否正确？') {
      learningRound++
      if (holdLearning) { pendingQuestion = request; return hold(request.signal) }
      return { answers: request.questions.map((question, index) => ({
        id: questionReply === 'old' ? fixture.oldQuestionId : question.id,
        selected: [mode !== 'cold' && learningRound === 1 && index === 1 ? '内容有误，退回修改'
          : question.options.find(option => option.label.includes('同类工作流')).label],
      })) }
    }
    if (mode === 'pending-gate' && request.questions[0].header === '本轮预算') {
      pendingQuestion = request
      return hold(request.signal)
    }
    return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].intent?.approve ?? Control.CONFIRM_LABEL] }] }
  })
  ctx.provide('webServer', { register() { throw new Error('No HTTP listener in this child Host') } })
  ctx.provide('connection', { rpc: { handle: () => async () => {} } })
  engine = await ctx.plugin(Engine, { dataDirectory: join(directory, 'journal'),
    runBudgetEnabled: mode !== 'cold', runBudgetScope: mode === 'cold' ? [] : [rootId],
    runModelRequests: mode === 'pending-gate' ? 1 : mode === 'cold' ? 999 : 200,
    runCommands: mode === 'cold' ? 999 : 20, runTimeBudgetEnabled: mode !== 'cold' && mode !== 'pending-gate',
    runActiveMs: mode === 'cold' ? 900000 : mode === 'root-time-cap' ? 5000 : 60000,
    commandTimeoutMs: 45000, commandExitGraceMs: 2000, childCancelGraceMs: 2000 })
  adapter = new CrashAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  const options = { agentOptions: { provider: 'scripted', model: 'local-fixture' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, Control.WORKFLOW_PRESET_ID) } }
  const handle = mode === 'cold'
    ? await ctx.agents.resume({ resumeSessionId: rootId, ...options })
    : await ctx.agents.create({ sessionId: rootId, meta: { cwd: directory, agentPreset: Control.WORKFLOW_PRESET_ID }, ...options })
  root = handle.agent
}
async function prepareCut() {
  await prompt('仅初始化独立故障夹具，不推进任务。')
  // Deliberately no fixture flush. The production workflow_propose path must
  // establish native Session durability before committing the first Run.
  if (gateModes.includes(mode)) {
    await prepareGateCut()
  } else if (criticalModes.includes(mode)) {
    await prepareCriticalCut()
  } else if (mode === 'command') {
    await cp(join(labRoot, 'tests/fixtures/budget-processes'), directory, { recursive: true })
    await writeFile(join(directory, 'budget-fixture.json'), JSON.stringify({ hold: true }))
    const check = { command: 'node --test budget-probe.test.cjs', workdir: '.', purpose: '受控进程检查' }
    await invoke('workflow_propose', { expectedRevision: snapshot().revision, kind: 'project-change', title: '隔离进程中断验证',
      goal: '创建一个临时工作区文件，在工程测试运行中中断测试 Host', changeClass: 'localized',
      inScope: ['src/native.js', '冻结测试写入进程探针记录'], outOfScope: ['发布', '网络操作'],
      constraints: ['仅临时工作区', '测试进程及后代有20秒自退出保险'], assumptions: [], unresolvedQuestions: [], writeScopes: ['src'],
      engineeringChecks: [{ id: 'ENG-1', ...check }], acceptanceChecks: [{ id: 'ACC-1', ...check }],
      criteria: [{ statement: '冻结检查成功退出', checkIds: ['ACC-1'] }] })
    await invoke('workflow_confirm'); await invoke('workflow_advance')
    await waitFor(() => snapshot().run.agents.some(agent => agent.taskId === 'implementation' && agent.status === 'idle'), 'implementation')
    await root.whenIdle()
    await invoke('workflow_advance')
    await waitFor(async () => {
      const run = snapshot().run, state = ctx.workflowJournal.readRunState(rootId, run.runId)
      if (!run.agents.some(agent => agent.taskId === 'code-review' && agent.status === 'idle')
        || !Object.values(state.commands).some(command => command.status === 'running')) return false
      try { await readFile(join(directory, 'budget-owned-pids.json')); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }, 'live command plus completed review sibling')
    await root.whenIdle()
  } else {
    await invoke('workflow_propose', proposal(snapshot().revision))
    await invoke('workflow_confirm')
    if (mode === 'child-model') {
      await invoke('workflow_advance')
      await waitFor(() => adapter.requests.some(item => item.held && item.role === 'engineer'), 'active child provider')
    } else if (mode === 'root-time-cap') {
      adapter.holdRoot = true
      root.followup(createUserMessage({ content: [{ type: 'text', text: '进入未结算计时切点。' }], source: { kind: 'user' } }))
      await waitFor(() => adapter.requests.some(item => item.held && item.sessionId === rootId), 'active root provider')
    } else if (mode === 'pending-gate') {
      await prompt('消耗唯一模型名额。')
      await prompt('下一次请求应在供应商前拒绝。')
      assert.equal(snapshot().run.budget.blocked?.resource, 'root-model')
      pendingWork = ctx.workflowController.budgetRecovery(root, { expectedRevision: snapshot().revision,
        action: 'topup', reason: '仅独立恢复夹具', add: { modelRequests: 1, commands: 0 } }, signal)
      pendingWork.catch(error => issues.push({ expectedPendingGateCancellation: String(error) }))
      await waitFor(() => pendingQuestion !== undefined, 'native pending budget question')
    }
  }
  await ctx.workflowController.runTime.flush(rootId)
}
async function roleIdle(id) {
  await waitFor(() => snapshot().run.agents.some(agent => agent.taskId === id && agent.status === 'idle'), id)
  await root.whenIdle()
}
function gateProposal(expectedRevision, changed = false) {
  if (scenario === 'text-gate') {
    const input = proposal(expectedRevision)
    return changed ? { ...input, goal: input.goal + '；按新确认的表述约束编写。' } : input
  }
  const check = { command: criticalCommand, workdir: '.', purpose: '仅在执行授权后检查公开导出' }
  return { expectedRevision, kind: 'project-change', title: '原生确认门禁恢复验证',
    goal: changed ? '在更新后的需求边界内确认公开模块行为' : '确认模块改动与独立检查的需求和执行边界',
    changeClass: scenario === 'local-execution-gate' ? 'localized' : 'architecture', inScope: ['src/native.js'], outOfScope: ['发布', '网络和外部写入'],
    constraints: ['仅临时目录', ...(changed ? ['需求变更必须重新确认'] : [])], assumptions: [], unresolvedQuestions: [], writeScopes: ['src'],
    engineeringChecks: [{ id: 'ENG-1', ...check }], acceptanceChecks: [{ id: 'ACC-1', ...check }],
    criteria: [{ statement: '公开模块 nativeReady 为 true', checkIds: ['ACC-1'] }] }
}
async function prepareGateCut() {
  await cp(join(labRoot, 'tests/fixtures/recovery-project'), directory, { recursive: true })
  await mkdir(join(directory, 'src'))
  await writeFile(join(directory, 'src/native.js'), originalSource)
  await invoke('workflow_propose', gateProposal(snapshot().revision))
  if (mode === 'execution-gate') {
    await invoke('workflow_confirm') // This approves read-only planning only.
    await invoke('workflow_advance'); await roleIdle('architecture')
    assert.ok(ctx.workflowJournal.readRunState(rootId, snapshot().run.runId).records['design:design'])
  }
  pendingWork = ctx.workflowController.confirm(root, { expectedRevision: snapshot().revision }, signal)
  pendingWork.catch(error => issues.push({ expectedPendingConfirmationCancellation: String(error) }))
  await waitFor(() => pendingQuestion !== undefined, 'native pending requirement/execution question')
  assert.equal(await readFile(join(directory, 'src/native.js'), 'utf8'), originalSource)
}
async function prepareCriticalCut() {
  await cp(join(labRoot, 'tests/fixtures/recovery-project'), directory, { recursive: true })
  await mkdir(join(directory, 'src'))
  await writeFile(join(directory, 'src/native.js'), originalSource)
  if (rollbackModes.includes(mode)) await writeFile(join(directory, 'src/other.txt'), Buffer.from([255, 254, 0, 1, 128, 10]))
  const check = { command: criticalCommand, workdir: '.', purpose: '验证公开导出，记录临时检查标记' }
  await invoke('workflow_propose', { expectedRevision: snapshot().revision, kind: 'project-change', title: '关键恢复隔离验证',
    goal: '让模块公开行为就绪并独立检查', changeClass: 'localized',
    inScope: ['src/native.js', '冻结检查生成 recovery-checks.jsonl'], outOfScope: ['发布', '网络和外部写入'],
    constraints: ['仅临时目录'], assumptions: [], unresolvedQuestions: [], writeScopes: ['src'],
    engineeringChecks: [{ id: 'ENG-1', ...check }], acceptanceChecks: [{ id: 'ACC-1', ...check }],
    criteria: [{ statement: '公开模块 nativeReady 为 true', checkIds: ['ACC-1'] }] })
  await invoke('workflow_confirm'); await invoke('workflow_advance')
  if (mode === 'file-write') { await waitFor(() => fileWriteCut, 'partial physical write'); return }
  await roleIdle('implementation')
  if (mode === 'implemented') return // Complete artifact recorded; no engineering check has started.
  await invoke('workflow_advance')
  await roleIdle('engineering-test'); await roleIdle('code-review')
  if (mode === 'rework' || mode === 'reworked') {
    assert.equal(ctx.workflowJournal.readRunState(rootId, snapshot().run.runId).tasks['engineering-test'].status, 'failed')
    await invoke('workflow_return')
    if (mode === 'reworked') { await invoke('workflow_advance'); await roleIdle('implementation') }
    return // Either after durable return routing, or after the new implementation but before its rechecks.
  }
  await invoke('workflow_advance'); await roleIdle('acceptance')
  if (mode === 'delivery') return // Current evidence complete; PASS not yet declared.
  await invoke('workflow_advance')
  assert.equal(snapshot().run.outcome, 'PASS')
  if (rollbackModes.includes(mode)) {
    installRollbackCut()
    pendingWork = ctx.workflowController.rollback(root, { expectedRevision: snapshot().revision }, signal)
    pendingWork.catch(error => issues.push({ rollbackCutError: String(error) }))
    await waitFor(() => rollbackCut, mode)
    return
  }
  const status = await ctx.workflowController.status(root)
  const source = status.learning.sources.find(item => item.taskId === 'engineering-test' && item.verdict === 'pass')
  assert.ok(source)
  const base = { actionKind: 'quality-requirement', risk: 'execution-affecting', suggestedScope: 'preset', sourceEvidenceIds: [source.evidenceId] }
  await invoke('workflow_learn', { expectedRevision: snapshot().revision, items: [
    { ...base, ruleKey: 'engineering-check', statement: '工程变更由独立测试角色执行已冻结的检查。', trigger: { mode: 'exact', terms: ['工程变更'] } },
    { ...base, ruleKey: 'release-time', statement: '对外发布时间不得未经确认写成承诺。', trigger: { mode: 'exact', terms: ['发布时间'] } },
  ] })
  const revised = snapshot().run.learning.candidates.find(item => item.status === 'revision-required')
  assert.ok(revised)
  holdLearning = true
  pendingWork = ctx.workflowController.reviseLearning(root, { expectedRevision: snapshot().revision,
    candidateId: revised.candidateId ?? revised.id, statement: '对外发布说明中的时间承诺必须先取得明确确认。', reason: '隔离夹具澄清条件。' }, signal)
  pendingWork.catch(error => issues.push({ expectedPendingRevisionCancellation: String(error) }))
  await waitFor(() => pendingQuestion !== undefined, 'one revised candidate awaiting a fresh decision')
}
// Fault injection belongs only to this disposable test Host, not the plugin.
function installRollbackCut() {
  const pause = async () => { rollbackCut = true; await hold(signal) }
  const commit = ctx.workflowJournal.commit.bind(ctx.workflowJournal)
  ctx.workflowJournal.commit = async input => {
    const result = await commit(input)
    if ((mode === 'rollback-before' && input.events.some(e => e.name === 'rollback/prepared'))
      || (mode === 'rollback-applied' && input.events.some(e => e.name === 'rollback/applied'))) await pause()
    return result
  }
  const rename = fs.rename, link = fs.link, unlink = fs.unlink
  fs.rename = async (...args) => {
    const result = await rename(...args)
    if (mode === 'rollback-backed' && String(args[0]).endsWith('native.js') && String(args[1]).endsWith('.backup')) await pause()
    return result
  }
  fs.link = async (...args) => {
    const result = await link(...args)
    if (mode === 'rollback-installed' && String(args[0]).includes('.workflow-rollback-') && String(args[1]).endsWith('native.js')) await pause()
    return result
  }
  fs.unlink = async (...args) => {
    const result = await unlink(...args)
    if (mode === 'rollback-cleanup' && String(args[0]).includes('.workflow-rollback-')) await pause()
    return result
  }
  syncBuiltinESMExports()
}
async function command(message) {
  try {
    let detail
    if (message.action === 'close') {
      await engine.dispose(); await ctx.fiber.dispose(); clearTimeout(fuse)
      await send({ kind: 'reply', id: message.id, detail: { closed: true } })
      process.removeAllListeners('disconnect'); process.disconnect(); return
    } else if (message.action === 'probe-advance') {
      try { detail = { accepted: true, result: await ctx.workflowController.advance(root, { expectedRevision: snapshot().revision }, signal) } }
      catch (error) { detail = { accepted: false, error: String(error) } }
    } else if (message.action === 'late-approval') {
      try { await ctx.workflowJournal.settleBudgetRecovery(rootId, snapshot().run.runId, message.requestId, 'approved'); detail = { accepted: true } }
      catch (error) { detail = { accepted: false, error: String(error) } }
    } else if (message.action === 'explicit-advance') {
      explicitDispatch = true
      detail = { result: await invoke('workflow_advance') }
      await waitFor(() => snapshot().run.agents.every(agent => agent.status === 'idle' || agent.runtimeIssue), 'explicit wave settled')
      await root.whenIdle(); await ctx.workflowController.runTime.flush(rootId)
    } else if (message.action === 'explicit-confirm') {
      assert.ok(gateModes.includes(scenario))
      questionReply = message.oldQuestionId ? 'old' : message.reject ? 'reject' : 'accept'
      fixture.oldQuestionId = message.oldQuestionId
      try { detail = { accepted: true, result: await ctx.workflowController.confirm(root, { expectedRevision: snapshot().revision }, signal) } }
      catch (error) { detail = { accepted: false, error: String(error) } }
    } else if (message.action === 'change-gate-proposal') {
      assert.ok(gateModes.includes(scenario))
      try { detail = { accepted: true, result: await ctx.workflowController.propose(root, gateProposal(snapshot().revision, true), signal) } }
      catch (error) { detail = { accepted: false, error: String(error) } }
    } else if (message.action === 'explicit-stop') {
      detail = { result: await ctx.workflowController.stop(root) }
    } else if (message.action === 'read-run') {
      detail = ctx.workflowJournal.readRunState(rootId, message.runId)
    } else if (message.action === 'explicit-rollback') {
      questionReply = message.oldQuestionId ? 'old' : message.reject ? 'reject' : 'accept'
      fixture.oldQuestionId = message.oldQuestionId
      try { detail = { accepted: true, result: await ctx.workflowController.rollback(root, { expectedRevision: snapshot().revision }, signal) } }
      catch (error) { detail = { accepted: false, error: String(error) } }
    } else if (message.action === 'probe-new-run') {
      try { detail = { accepted: true, result: await ctx.workflowController.propose(root, proposal(snapshot().revision), signal) } }
      catch (error) { detail = { accepted: false, error: String(error) } }
    } else if (message.action === 'read-status') {
      detail = await ctx.workflowController.status(root)
    } else if (message.action === 'finish-learning') {
      questionReply = message.oldQuestionId ? 'old' : 'accept'
      fixture.oldQuestionId = message.oldQuestionId
      const candidate = snapshot().run.learning.candidates.find(item => item.status === 'pending' || item.status === 'revision-required')
      assert.ok(candidate)
      try { detail = { accepted: true, result: await ctx.workflowController.reviseLearning(root, {
        expectedRevision: snapshot().revision, candidateId: candidate.candidateId ?? candidate.id,
        statement: candidate.statement, reason: '重开当前已修订候选，不生成新的修订。',
      }, signal) } } catch (error) { detail = { accepted: false, error: String(error) } }
    } else assert.equal(message.action, 'inspect')
    await send({ kind: 'reply', id: message.id, detail, ...receipt() })
  } catch (error) { await send({ kind: 'error', id: message.id, message: String(error), stack: error.stack }) }
}
try {
  if (mode === 'lock-probe') {
    try {
      const storage = await openWorkflowStorage(join(directory, 'journal'))
      await storage.close(); await send({ kind: 'lock-probe', opened: true })
    } catch (error) { await send({ kind: 'lock-probe', opened: false, message: String(error) }) }
    clearTimeout(fuse); process.removeAllListeners('disconnect'); process.disconnect()
  } else {
    await initialize()
    if (mode !== 'cold') await prepareCut()
    else await delay(100)
    process.on('message', message => { void command(message) })
    await send({ kind: 'ready', ...receipt() })
  }
} catch (error) {
  await send({ kind: 'error', message: String(error), stack: error.stack }).catch(() => {})
  process.exit(2)
}
