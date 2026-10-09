import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { displayWorkflowState } from '../lib/workflow-display.js'
import {
  CONFIRM_LABEL,
  PROJECT_PILOT,
  REQUIREMENTS_CONFIRM_LABEL,
  ROLLBACK_CONFIRM_LABEL,
  WorkflowTextArtifacts,
  WorkflowTextController,
} from '../lib/workflow-control.js'
import { memoryTable } from './helpers/workflow-fixture.mjs'
import { childClock, childConfig, flushChild } from './helpers/workflow-child-clock.mjs'
import { executeCheck } from './helpers/workflow-command-fixture.mjs'
import { padHistory, recoveryPair } from './helpers/workflow-capacity-fixture.mjs'

const signal = new AbortController().signal
const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const display = snapshot => displayWorkflowState({ status: 'ready', snapshot }, [], stages)
const fileByteLimit = 16 * 1024 * 1024

test('capacity reached by the checkpoint commit denies native file dispatch and leaves the original file intact', async t => {
  const h = await fixture(t)
  await h.setup(); await h.advance()
  const child = h.child('implementation')
  await writeFile(join(h.workspace, 'src/app.js'), 'original file', 'utf8')
  // Single capture is the final normal commit. Fill by complete prior ingress
  // pairs and, when necessary, one settled recovery pair up to revision 8999.
  let revision = padHistory(h.table, h.root.id, 8997)
  if (revision === 8997) {
    await h.journal.commit({ rootSessionId: h.root.id, expectedRevision: revision, events: recoveryPair(h.snapshot()) })
    revision = h.snapshot().revision
  }
  if (revision === 8998) {
    const pair = recoveryPair(h.snapshot())
    await h.journal.commit({ rootSessionId: h.root.id, expectedRevision: revision, events: [pair[0]] })
  }
  assert.equal(h.snapshot().revision, 8999)
  let dispatched = false
  await assert.rejects(h.controller.executeNativeTool(child, 'write', { file_path: 'src/app.js', content: 'replacement' }, async () => {
    dispatched = true
    await writeFile(join(h.workspace, 'src/app.js'), 'replacement', 'utf8')
    return { isError: false, content: [] }
  }), /容量|派发/)
  assert.equal(dispatched, false)
  assert.equal(await readFile(join(h.workspace, 'src/app.js'), 'utf8'), 'original file')
  assert.ok(h.snapshot().capacity)
  assert.equal(h.snapshot().run.outcome, null)
})

function proposal(expectedRevision, changeClass = 'localized') {
  return {
    expectedRevision,
    kind: 'project-change',
    title: '测试：实现一个项目内功能',
    goal: '在当前工作区创建一个可验证的功能文件',
    changeClass,
    inScope: ['创建 src/app.js'],
    outOfScope: ['安装依赖', '启动服务', '发布'],
    constraints: ['只使用已确认的工作区范围和冻结命令'],
    assumptions: [],
    unresolvedQuestions: [],
    writeScopes: ['src'],
    engineeringChecks: [{ id: 'ENG-1', command: 'node --test', workdir: '.', purpose: '执行工程测试' }],
    acceptanceChecks: [{ id: 'ACC-1', command: 'node --test', workdir: '.', purpose: '执行黑盒验收' }],
    criteria: [{ statement: '冻结黑盒检查成功退出', checkIds: ['ACC-1'] }],
  }
}

function pwshResult(exitCode = 0) {
  const text = exitCode === 0 ? 'tests passed' : 'tests failed'
  return {
    isError: false,
    value: {
      kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 30_000,
      stdout: { text, truncated: false }, stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false },
    },
    content: [{ type: 'text', text }],
  }
}

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'workflow-project-controller-'))
  const workspace = join(base, 'workspace')
  await mkdir(join(workspace, 'src'), { recursive: true })
  const artifacts = await WorkflowTextArtifacts.open(base)
  const table = memoryTable()
  const journal = new WorkflowJournal(table)
  const root = { id: 'project-root', session: { header: { cwd: workspace } } }
  const live = new Map([[root.id, root]])
  const calls = []
  const questions = []
  let controller
  const childAgent = id => ({ id, session: { header: { cwd: workspace } } })
  const driver = {
    // Pure controller fixture; native Session durability has separate integration coverage.
    ensureRootDurable: async () => {},
    isRoot: agent => agent === root && live.get(root.id) === root,
    isLive: agent => live.get(agent.id) === agent,
    async ask(_agent, requested) {
      const batch = [...requested]
      questions.push(...batch)
      return { answers: batch.map(question => ({
        id: question.id,
        selected: [question.options[0].label],
      })) }
    },
    async start(_parent, id, role, prompt, callSignal) {
      calls.push({ operation: 'start', id, role, prompt })
      if (options.start) await options.start(role)
      callSignal.throwIfAborted()
      const child = childAgent(id)
      controller.bindChild(child)
      live.set(id, child)
      options.onStarted?.(role)
    },
    async resume(_parent, id, prompt, callSignal) {
      calls.push({ operation: 'resume', id, prompt })
      callSignal.throwIfAborted()
      const child = childAgent(id)
      controller.bindChild(child)
      live.set(id, child)
    },
    async drain(_parent, ids) {
      calls.push({ operation: 'drain', ids })
      for (const id of ids) live.delete(id)
    },
    notify() {},
  }
  controller = new WorkflowTextController(journal, artifacts, driver, undefined, options.childConfig, options.childClock, options.commandConfig, {}, options.hostAdmissionConfig)
  controller.bindRoot(root)
  t.after(async () => {
    if (options.expectUnknownExit) await assert.rejects(controller.close(), /卸载回收未在期限内确认/)
    else await controller.close()
    await journal.close()
  })
  const snapshot = () => journal.readSnapshot(root.id)
  const revision = () => ({ expectedRevision: snapshot().revision })
  const setup = async (changeClass = 'localized') => {
    await controller.propose(root, proposal(snapshot().revision, changeClass), signal)
    await controller.confirm(root, revision(), signal)
  }
  const advance = () => controller.advance(root, revision(), signal)
  const child = taskId => {
    const id = snapshot().run.agents.find(item => item.taskId === taskId)?.agentSessionId
    return live.get(id)
  }
  const settle = async agent => {
    live.delete(agent.id)
    await controller.settled(agent.id, true)
  }
  const implement = async (content = 'export const ready = true\n', operation = 'write', relativePath = 'src/app.js') => {
    await advance()
    const engineer = child('implementation')
    assert.ok(engineer)
    assert.deepEqual(new Set(controller.childTools(engineer)), new Set(['workflow_packet', 'workflow_report', 'read', 'write', 'edit', 'glob', 'grep']))
    assert.match(controller.guard(engineer, 'pwsh', { command: 'node --test' }), /无权/)
    assert.deepEqual(controller.packet(engineer).checks, [])
    const target = join(workspace, ...relativePath.split('/'))
    const before = operation === 'write' ? null : 'export const ready = false\n'
    if (before !== null) await writeFile(target, before, 'utf8')
    const args = operation === 'write'
      ? { file_path: relativePath, content }
      : { file_path: relativePath, old_string: before, new_string: content }
    const result = {
      isError: false,
      value: operation === 'write'
        ? { path: relativePath, operation: before === null ? 'create' : 'update', before, after: content }
        : { path: relativePath, before, after: content },
      content: [{ type: 'text', text: 'updated' }],
    }
    await controller.executeNativeTool(engineer, operation, args, async () => {
      await writeFile(target, content, 'utf8')
      return result
    })
    await controller.observeNativeTool(engineer, operation, args, result)
    await controller.report(engineer, { role: 'engineer', summary: '功能文件已实现', changedFiles: [relativePath], notes: [] }, signal)
    await settle(engineer)
    return engineer.id
  }
  return { base, workspace, controller, root, journal, table, artifacts, driver, live, calls, questions, snapshot, revision, setup, advance, child, settle, implement }
}

test('resource guard: oversized UTF-8 write is rejected before native dispatch or checkpoint publication', async t => {
  const f = await fixture(t)
  await f.setup(); await f.advance()
  const engineer = f.child('implementation'), target = join(f.workspace, 'src/app.js')
  await writeFile(target, 'original\n')
  const before = f.snapshot()
  const content = '界'.repeat(Math.floor(fileByteLimit / 3) + 1)
  assert.ok(content.length < fileByteLimit && Buffer.byteLength(content) > fileByteLimit)
  let dispatched = false
  await assert.rejects(f.controller.executeNativeTool(engineer, 'write', { file_path: 'src/app.js', content }, async () => {
    dispatched = true
    throw new Error('oversized request reached the native filesystem')
  }), /16 MiB/)
  assert.equal(dispatched, false)
  assert.equal(await readFile(target, 'utf8'), 'original\n')
  assert.deepEqual(f.snapshot(), before)
  assert.deepEqual(await readdir(f.artifacts.checkpointDirectory), [])
})

test('Host admission rejects an entire parallel verification wave before either role is assigned', async t => {
  const f = await fixture(t, { hostAdmissionConfig: { hostAdmissionEnabled: true, hostMaxActiveRoots: 2, hostMaxRoleExecutions: 2 } })
  await f.setup(); await f.implement()
  const release = f.controller.hostAdmission.reserveRoles('another-root', ['another-owned-execution'])
  try {
    const before = f.calls.filter(call => call.operation === 'start').length
    await assert.rejects(f.advance(), /并发名额不足/)
    assert.equal(f.calls.filter(call => call.operation === 'start').length, before)
    assert.equal(f.snapshot().run.agents.filter(agent => ['engineering-test', 'code-review'].includes(agent.taskId)).length, 0)
    assert.equal(f.controller.hostAdmission.view().roleExecutions, 1)
    release()
    assert.equal(f.calls.filter(call => call.operation === 'start').length, before)
    await assert.rejects(f.advance(), /并发不足暂停/)
    f.controller.observeBudgetTurn(f.root, { type: 'turn/start' })
    f.controller.observeBudgetTurn(f.root, { type: 'user/message', data: { source: { kind: 'user' } } })
    await f.advance()
    assert.equal(f.calls.filter(call => call.operation === 'start').length, before + 2)
    assert.equal(f.controller.hostAdmission.view().roleExecutions, 2)
  } finally { release() }
})

test('resource guard: replace-all expansion is rejected before native dispatch or checkpoint publication', async t => {
  const f = await fixture(t)
  await f.setup(); await f.advance()
  const engineer = f.child('implementation'), target = join(f.workspace, 'src/app.js')
  const original = 'a'.repeat(1024 * 1024)
  await writeFile(target, original)
  const before = f.snapshot()
  let dispatched = false
  await assert.rejects(f.controller.executeNativeTool(engineer, 'edit', {
    file_path: 'src/app.js', old_string: 'a', new_string: 'b'.repeat(17), replace_all: true,
  }, async () => {
    dispatched = true
    throw new Error('oversized edit reached the native filesystem')
  }), /16 MiB/)
  assert.equal(dispatched, false)
  assert.equal(await readFile(target, 'utf8'), original)
  assert.deepEqual(f.snapshot(), before)
  assert.deepEqual(await readdir(f.artifacts.checkpointDirectory), [])
})

test('resource guard: checkpoint file-count refusal does not leave an unreferenced backup', async t => {
  const f = await fixture(t)
  await f.setup(); await f.advance()
  const engineer = f.child('implementation')
  for (let index = 0; index < 100; index++) {
    const path = `src/file-${index}.txt`
    await f.controller.executeNativeTool(engineer, 'write', { file_path: path, content: '' }, async () => {
      await writeFile(join(f.workspace, path), '')
      return { isError: false, value: {}, content: [] }
    })
  }
  const extra = join(f.workspace, 'src/extra.txt')
  await writeFile(extra, 'must not be backed up or changed')
  const before = f.snapshot()
  let dispatched = false
  await assert.rejects(f.controller.executeNativeTool(engineer, 'write', { file_path: 'src/extra.txt', content: '' }, async () => {
    dispatched = true
    throw new Error('file-count overflow reached native filesystem')
  }), /100/)
  assert.equal(dispatched, false)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(await readFile(extra, 'utf8'), 'must not be backed up or changed')
  assert.deepEqual(await readdir(f.artifacts.checkpointDirectory), [])
})

test('resource guard: original checkpoint bytes permit exactly 64 MiB and reject the next byte before backup', async t => {
  const f = await fixture(t)
  await f.setup(); await f.advance()
  const engineer = f.child('implementation')
  for (let index = 0; index < 4; index++) {
    const path = `src/bounded-${index}.txt`
    await writeFile(join(f.workspace, path), Buffer.alloc(fileByteLimit, 65 + index))
    await f.controller.executeNativeTool(engineer, 'write', { file_path: path, content: 'small' }, async () => {
      await writeFile(join(f.workspace, path), 'small')
      return { isError: false, value: {}, content: [] }
    })
  }
  const backups = (await readdir(f.artifacts.checkpointDirectory)).sort()
  assert.equal(backups.length, 4)
  const before = f.snapshot(), extra = join(f.workspace, 'src/one-more-byte.txt')
  await writeFile(extra, 'z')
  let dispatched = false
  await assert.rejects(f.controller.executeNativeTool(engineer, 'write', { file_path: 'src/one-more-byte.txt', content: '' }, async () => {
    dispatched = true
    throw new Error('checkpoint byte overflow reached native filesystem')
  }), /64 MiB/)
  assert.equal(dispatched, false)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(await readFile(extra, 'utf8'), 'z')
  assert.deepEqual((await readdir(f.artifacts.checkpointDirectory)).sort(), backups)
})

test('resource guard: exactly 16 MiB UTF-8 output is accepted by the real native filesystem and remains verifiable', async t => {
  const f = await fixture(t)
  await f.setup(); await f.advance()
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: f.workspace })
  t.after(() => ctx.fiber.dispose())
  const engineer = f.child('implementation'), target = await ctx.fs.resolve('src/app.js')
  const content = 'a'.repeat(fileByteLimit - 3) + '界'
  assert.equal(Buffer.byteLength(content), fileByteLimit)
  await f.controller.executeNativeTool(engineer, 'write', { file_path: 'src/app.js', content }, async () => ({
    isError: false, value: await ctx.fs.writeText(target, content), content: [],
  }))
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(state.checkpoints['implementation@1'].files['src/app.js'].after.bytes, fileByteLimit)
  assert.equal((await readFile(join(f.workspace, 'src/app.js'))).byteLength, fileByteLimit)
  assert.equal(f.snapshot().run.ledger.hardOutcome, 'PENDING', 'A bounded write is not acceptance')
})

for (const row of [
  { label: 'CRLF, BOM and literal dollar replacement', before: '\ufeffa\r\nb\r\n', old: 'a\r\nb', replacement: '界\r\n$&', expected: '界\r\n$&\r\n' },
  { label: 'Unicode replace-all', before: '甲 甲\n', old: '甲', replacement: '🙂', replaceAll: true, expected: '🙂 🙂\n' },
  { label: 'non-overlapping matches and deletion', before: 'aaaa\n', old: 'aa', replacement: '', replaceAll: true, expected: '\n' },
  { label: 'lone CR at replacement boundary', before: 'x\ny\n', old: 'x', replacement: '\r', expected: '\r\ny\n' },
]) {
  test(`resource guard: bounded edit agrees with native ${row.label}`, async t => {
    const f = await fixture(t)
    await f.setup(); await f.advance()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: f.workspace })
    t.after(() => ctx.fiber.dispose())
    const target = await ctx.fs.resolve('src/app.js'), engineer = f.child('implementation')
    await writeFile(join(f.workspace, 'src/app.js'), row.before)
    await f.controller.executeNativeTool(engineer, 'edit', {
      file_path: 'src/app.js', old_string: row.old, new_string: row.replacement, replace_all: row.replaceAll ?? false,
    }, async () => ({ isError: false, value: await ctx.fs.editText(target, {
      oldString: row.old, newString: row.replacement, replaceAll: row.replaceAll ?? false,
    }), content: [] }))
    assert.equal(await readFile(join(f.workspace, 'src/app.js'), 'utf8'), row.expected)
    const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
    assert.equal(state.checkpoints['implementation@1'].files['src/app.js'].after.bytes, Buffer.byteLength(row.expected))
  })
}

test('resource guard: CRLF restoration cannot expand an apparently bounded edit past 16 MiB', async t => {
  const f = await fixture(t)
  await f.setup(); await f.advance()
  const target = join(f.workspace, 'src/app.js')
  await writeFile(target, 'x\r\n')
  const before = f.snapshot()
  await assert.rejects(f.controller.executeNativeTool(f.child('implementation'), 'edit', {
    file_path: 'src/app.js', old_string: 'x', new_string: '\n'.repeat(fileByteLimit / 2),
  }, async () => { throw new Error('CRLF overflow was dispatched') }), /16 MiB/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(await readFile(target, 'utf8'), 'x\r\n')
  assert.deepEqual(await readdir(f.artifacts.checkpointDirectory), [])
})

test('only an exact supervised native command result can become check evidence', async t => {
  const f = await fixture(t)
  await f.setup(); await f.implement(); await f.advance()
  const tester = f.child('engineering-test'), args = { command: 'node --test', description: 'frozen check' }
  await assert.rejects(f.controller.observeNativeTool(tester, 'pwsh', args, pwshResult()), /退出凭据/)
  await executeCheck(f.controller, tester, args, pwshResult())
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  const command = Object.values(state.commands)[0]
  assert.equal(command.status, 'completed'); assert.equal(command.observation.exitConfirmed, true)
  assert.equal(command.observation.toolSettled, true)
  const evidence = Object.values(state.evidence).find(item => item.taskId === 'engineering-test')
  assert.ok(evidence.summary.includes(command.commandId))
  const cold = new WorkflowJournal(f.table)
  assert.deepEqual(cold.readRunState(f.root.id, state.runId).commands, state.commands)
  await cold.close()
})

test('command journal rejects forged actors, stale starts, false stop and duplicate exit evidence', async t => {
  const f = await fixture(t)
  await f.setup(); await f.implement(); await f.advance()
  const snapshot = f.snapshot(), assignment = snapshot.run.agents.find(item => item.role === 'test_engineer')
  let seq = 0
  const commit = (name, payload, actor = { kind: 'system', id: 'workflow-host' }) => f.journal.commit({
    rootSessionId: f.root.id, expectedRevision: f.snapshot().revision,
    events: [{ version: 1, runId: snapshot.run.runId, eventId: `command-audit-${++seq}`, name, actor, payload }],
  })
  const start = { commandId: 'audited-command', assignmentId: assignment.assignmentId, taskVersion: assignment.taskVersion, checkId: 'ENG-1', timeoutMs: 1000 }
  const finish = { commandId: start.commandId, status: 'completed', elapsedMs: 100, processCount: 1, exitConfirmed: true, toolSettled: true, exitCode: 0 }
  await assert.rejects(commit('command/started', start, { kind: 'agent', id: assignment.agentSessionId, role: 'test_engineer' }), /only the Host/)
  await assert.rejects(commit('command/started', { ...start, taskVersion: assignment.taskVersion + 1 }), /current running assignment/)
  await commit('command/started', start)
  await assert.rejects(commit('command/started', start), /duplicate|unresolved/)
  await assert.rejects(commit('command/finished', { ...finish, exitConfirmed: false }), /contradicts/)
  await assert.rejects(commit('command/finished', { ...finish, exitCode: null }), /direct exit code/)
  await assert.rejects(commit('command/finished', finish, { kind: 'agent', id: assignment.agentSessionId, role: 'test_engineer' }), /only the Host/)
  await assert.rejects(commit('agent/settled', { assignmentId: assignment.assignmentId, outcome: 'completed', summary: 'not process evidence' }), /not command exit evidence/)
  await commit('command/finished', finish)
  await assert.rejects(commit('command/finished', finish), /once/)
})

test('command timeout records interruption, revokes only its role and consumes no rework or business FAIL', async t => {
  const clock = childClock(), done = Promise.withResolvers(), exit = Promise.withResolvers()
  const f = await fixture(t, { childClock: clock, commandConfig: { commandTimeoutMs: 1000, commandExitGraceMs: 1000 } })
  await f.setup(); await f.implement(); await f.advance()
  const tester = f.child('engineering-test'), reviewer = f.child('code-review')
  const handle = { done: done.promise, collected: {}, terminate() { done.resolve(); exit.resolve(true) }, waitForExit: () => exit.promise }
  const work = executeCheck(f.controller, tester, { command: 'node --test', description: 'frozen check' }, pwshResult(), {
    handle, dispatch: async () => { await done.promise; return pwshResult() },
  })
  const rejected = assert.rejects(work, /运行中断/)
  await flushChild(); clock.advance(1000); await rejected; await flushChild()
  await f.controller.report(reviewer, { role: 'code_reviewer', status: 'PASS', summary: '独立审查完成', findings: [] }, signal)
  await f.settle(reviewer)
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(Object.values(state.commands)[0].status, 'interrupted')
  const issue = f.snapshot().run.agents.find(item => item.role === 'test_engineer').runtimeIssue
  assert.equal(issue.cause, 'command-timeout'); assert.equal(issue.status, 'stopped')
  assert.equal(state.tasks['code-review'].status, 'completed'); assert.equal(state.tasks['engineering-test'].status, 'blocked')
  assert.equal(state.returns.length, 0)
  assert.equal(Object.values(state.evidence).filter(item => item.verdict === 'fail').length, 0)
  await assert.rejects(f.advance(), /运行异常|中断|恢复/)
  assert.equal(display(f.snapshot()).needsUser, true)
})

test('a successful Agent drain cannot conceal unknown command descendants or declare cancellation', async t => {
  const f = await fixture(t, { expectUnknownExit: true })
  await f.setup(); await f.implement(); await f.advance()
  const tester = f.child('engineering-test')
  await assert.rejects(executeCheck(f.controller, tester, { command: 'node --test', description: 'frozen check' }, pwshResult(), {
    handle: { done: Promise.resolve(), collected: {}, terminate() {}, waitForExit: async () => false },
  }), /未确认/)
  await flushChild()
  const stopped = await f.controller.stop(f.root, {}, signal)
  assert.equal(stopped.stopped, false)
  const snapshot = f.snapshot()
  assert.equal(snapshot.run.outcome, null)
  assert.equal(snapshot.run.agents.find(item => item.role === 'test_engineer').runtimeIssue.status, 'unknown')
  assert.equal(display(snapshot).needsUser, true)
})

test('a pending command prevents reporting an earlier success and a late native end is not exit proof', async t => {
  const clock = childClock(), done = Promise.withResolvers(), exit = Promise.withResolvers()
  const f = await fixture(t, { childClock: clock })
  await f.setup(); await f.implement(); await f.advance()
  const tester = f.child('engineering-test'), args = { command: 'node --test', description: 'frozen check' }
  await executeCheck(f.controller, tester, args, pwshResult())
  const work = executeCheck(f.controller, tester, args, pwshResult(), {
    handle: { done: done.promise, collected: {}, terminate() { done.resolve(); exit.resolve(true) }, waitForExit: () => exit.promise },
    dispatch: async () => { await done.promise; return pwshResult() },
  })
  const rejected = assert.rejects(work, /运行中断/)
  await flushChild()
  await assert.rejects(f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'PASS', observation: 'older result' }], summary: 'old success' }, signal), /尚未完成退出核对/)
  await f.controller.settled(tester.id, true)
  await rejected; await flushChild()
  assert.equal(f.snapshot().run.agents.find(item => item.role === 'test_engineer').runtimeIssue.cause, 'command-exit-unknown')
})

test('cold recovery marks an open command unknown once without observing or starting any old process', async t => {
  const f = await fixture(t)
  await f.setup(); await f.implement(); await f.advance()
  const snapshot = f.snapshot(), assignment = snapshot.run.agents.find(item => item.role === 'test_engineer')
  const event = (name, payload, id) => ({ version: 1, runId: snapshot.run.runId, eventId: id, name, payload, actor: { kind: 'system', id: 'workflow-host' } })
  await f.journal.commit({ rootSessionId: f.root.id, expectedRevision: snapshot.revision, events: [event('command/started', {
    commandId: 'interrupted-by-host-crash', assignmentId: assignment.assignmentId, taskVersion: assignment.taskVersion, checkId: 'ENG-1', timeoutMs: 120000,
  }, 'start-before-crash')] })
  // A copied durable store simulates another epoch; don't mutate the live fixture's writer.
  const coldTable = memoryTable()
  for (const [key, value] of f.table.entries()) await coldTable.put(key, structuredClone(value))
  const coldJournal = new WorkflowJournal(coldTable)
  const cold = new WorkflowTextController(coldJournal, f.artifacts, { ...f.driver, start: () => { assert.fail('no new spawn') } })
  await cold.recoverOrphanedLeases()
  const recovered = coldJournal.readRunState(f.root.id, snapshot.run.runId)
  assert.equal(recovered.commands['interrupted-by-host-crash'].status, 'unknown')
  const revision = coldJournal.readSnapshot(f.root.id).revision
  await cold.recoverOrphanedLeases()
  assert.equal(coldJournal.readSnapshot(f.root.id).revision, revision)
  await cold.close(); await coldJournal.close()
})

test('a hanging admission does not prevent a same-wave sibling from being admitted', { timeout: 5000 }, async t => {
  const clock = childClock(), held = Promise.withResolvers(), reviewerStarted = Promise.withResolvers()
  t.after(() => held.resolve())
  const f = await fixture(t, { childConfig, childClock: clock,
    start: role => role === 'test_engineer' ? held.promise : Promise.resolve(),
    onStarted: role => { if (role === 'code_reviewer') reviewerStarted.resolve() } })
  await f.setup(); await f.implement()
  const advancing = f.advance()
  void advancing.catch(() => {})
  await reviewerStarted.promise
  await flushChild()
  assert.ok(f.child('code-review'), 'independent reviewer was admitted before testing admission completed')
  clock.advance(1000)
  const result = await advancing
  assert.equal(result.agents.length, 1)
  assert.equal(result.agents[0].role, 'code_reviewer')
  assert.equal(result.failures[0].taskId, 'engineering-test')
  const reviewer = f.child('code-review')
  await f.controller.report(reviewer, { role: 'code_reviewer', status: 'PASS', summary: '未发现阻塞问题', findings: [] }, signal)
  await f.settle(reviewer)
  held.resolve(); await flushChild()
  assert.equal(f.snapshot().run.agents.find(agent => agent.role === 'test_engineer').runtimeIssue.status, 'stopped')
  assert.equal(f.snapshot().run.agents.find(agent => agent.role === 'code_reviewer').status, 'idle')
  assert.equal(display(f.snapshot()).needsUser, true)
})

test('a late write after timeout is compensated before the lease can be marked stopped', { timeout: 5000 }, async t => {
  const clock = childClock(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const f = await fixture(t, { childConfig, childClock: clock })
  await f.setup(); await f.advance()
  const engineer = f.child('implementation'), target = join(f.workspace, 'src', 'app.js')
  const writing = f.controller.executeNativeTool(engineer, 'write', { file_path: 'src/app.js', content: 'late data' }, async () => {
    entered.resolve(); await release.promise
    await writeFile(target, 'late data')
    return { isError: false, value: {}, content: [] }
  })
  const rejected = assert.rejects(writing, /关闭/)
  await entered.promise
  clock.advance(2000); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'stopping')
  clock.advance(1000); await flushChild()
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'unknown')
  release.resolve(); await rejected; await flushChild()
  await assert.rejects(access(target), error => error.code === 'ENOENT')
  assert.equal(f.snapshot().run.agents[0].runtimeIssue.status, 'stopped')
  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(Object.values(state.records).some(record => record.kind === 'artifact'), false)
})

test('project plan review is a compact decision summary while the durable contract stays complete', async t => {
  const f = await fixture(t)
  const longConstraint = `完整合同中的详细约束：${'这段内容必须持久保存但不应铺满确认卡。'.repeat(28)}`
  await f.controller.propose(f.root, {
    ...proposal(f.snapshot().revision),
    title: 'scripts/build.ps1 增加中文启动提示（保持 UTF-8 BOM）',
    inScope: [`修改 scripts/build.ps1：输出“正在准备端口管理工具……”，其余行为保持不变。${'补充实现说明。'.repeat(24)}`],
    constraints: [longConstraint],
    assumptions: ['验收只使用合同中已经冻结的命令。'],
    acceptanceChecks: [{
      id: 'ACC-1', command: 'node --test', workdir: '.',
      purpose: '验收会短暂启动一个专用哑监听进程并显示一次 GUI 窗口，结束后立即清理。',
    }],
    criteria: [{ statement: `脚本首先逐字输出中文提示，随后维持原构建行为。${'补充验收细节。'.repeat(20)}`, checkIds: ['ACC-1'] }],
  }, signal)
  await f.controller.confirm(f.root, f.revision(), signal)

  const question = f.questions.at(-1)
  assert.equal(question.intent.kind, 'plan-review')
  assert.deepEqual(question.options.map(option => option.label), [CONFIRM_LABEL])
  assert.match(question.detail, /^## L1 · 准备执行 · scripts\/build\.ps1 增加中文启动提示/)
  assert.match(question.detail, /> `scripts\/build\.ps1`：输出「正在准备端口管理工具……」/)
  assert.match(question.detail, /\*\*范围\*\* 仅可写 `src`/)
  assert.match(question.detail, /\*\*检查 · 1 项硬标准\*\* 工程 `node --test`/)
  assert.match(question.detail, /\*\*受控副作用\*\* 短暂启动验收监听进程、短暂显示 GUI 窗口、结束后清理/)
  assert.match(question.detail, /去聊天里说/)
  assert.doesNotMatch(question.detail, /## 本次包含|## 允许的执行与返回范围|工作区根固定为/)
  assert.equal((question.detail.match(/^#/gmu) ?? []).length, 1)
  assert.ok((question.detail.match(/^- /gmu) ?? []).length <= 5)
  assert.ok(question.detail.length < 700, `plan decision card is too long: ${String(question.detail.length)}`)

  const state = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.ok(state.records['requirement:requirement'].data.constraints.includes(longConstraint))
  assert.equal(state.records['requirement:requirement'].data.permissionBoundaries.length, 9)
})

test('architecture changes are assessed by a read-only architect before implementation receives the design', async t => {
  const f = await fixture(t)
  await f.setup('architecture')
  const requirementQuestion = f.questions.at(-1)
  assert.equal(requirementQuestion.header, '需求理解')
  assert.deepEqual(requirementQuestion.options.map(option => option.label), [REQUIREMENTS_CONFIRM_LABEL])
  assert.match(requirementQuestion.detail, /确认后只启动只读方案 Agent，不会写文件或运行检查命令/)
  assert.equal(f.snapshot().run.gates.at(-1).kind, 'signal')
  assert.equal(f.snapshot().run.plan.confirmationMode, 'layered')
  await f.advance()
  const architect = f.child('architecture')
  assert.ok(architect)
  assert.deepEqual(new Set(f.controller.childTools(architect)), new Set(['workflow_packet', 'workflow_report', 'read', 'glob', 'grep']))
  assert.match(f.controller.guard(architect, 'write', { file_path: 'src/app.js', content: 'x' }), /无权/)
  assert.match(f.controller.guard(architect, 'pwsh', { command: 'node --test' }), /无权/)
  await f.controller.report(architect, {
    role: 'architect', summary: '保持模块边界并由现有入口接入',
    decisions: [{ id: 'ADR-1', decision: '沿用现有模块入口', rationale: '避免引入新的依赖方向' }],
    affectedAreas: ['src/app.js'], interfaces: ['现有模块导出'], rollback: ['移除本次新增导出'],
  }, signal)
  await f.settle(architect)

  const paused = await f.advance()
  assert.equal(paused.needsUser, true)
  assert.match(paused.next, /停在执行授权前/)
  assert.equal(f.child('implementation'), undefined)
  await f.controller.confirm(f.root, f.revision(), signal)
  const executionQuestion = f.questions.at(-1)
  assert.equal(executionQuestion.header, '执行授权')
  assert.deepEqual(executionQuestion.options.map(option => option.label), [CONFIRM_LABEL])
  assert.match(executionQuestion.detail, /保持模块边界并由现有入口接入/)
  assert.equal(f.snapshot().run.gates.at(-1).kind, 'execution')
  assert.equal(f.snapshot().run.plan.design.summary, '保持模块边界并由现有入口接入')

  await f.advance()
  const engineer = f.child('implementation')
  assert.ok(engineer)
  const packet = f.controller.packet(engineer)
  assert.equal(packet.design.summary, '保持模块边界并由现有入口接入')
  assert.equal(packet.design.decisions[0].id, 'ADR-1')
})

test('project controller runs real edit → parallel test/review → source-isolated acceptance → delivery', async t => {
  const f = await fixture(t)
  await f.setup()
  assert.equal(f.snapshot().run.executionProfile, PROJECT_PILOT)
  const engineerId = await f.implement()

  const wave = await f.advance()
  assert.equal(wave.agents.length, 2)
  const waveDisplay = display(f.snapshot())
  assert.match(waveDisplay.now, /2 个 Agent 并行：工程测试、代码审查/)
  assert.equal(waveDisplay.stageDetails[1].label, '本次无需')
  assert.match(waveDisplay.stageDetails[1].reason, /不需要独立只读方案阶段/)
  assert.equal(waveDisplay.stageDetails[6].label, '交付后整理')
  const tester = f.child('engineering-test')
  const reviewer = f.child('code-review')
  assert.ok(tester && reviewer)
  assert.deepEqual(new Set(f.controller.childTools(tester)), new Set(['workflow_packet', 'workflow_report', 'read', 'glob', 'grep', 'pwsh']))
  assert.deepEqual(new Set(f.controller.childTools(reviewer)), new Set(['workflow_packet', 'workflow_report', 'read', 'glob', 'grep']))
  assert.match(f.controller.guard(reviewer, 'pwsh', {}), /无权/)

  const checkArgs = { command: 'node --test', description: 'Run frozen engineering tests' }
  await executeCheck(f.controller, tester, checkArgs, pwshResult())
  await f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'PASS', observation: '测试成功退出' }] }, signal)
  await f.controller.report(reviewer, { role: 'code_reviewer', status: 'PASS', summary: '未发现阻塞问题', findings: [] }, signal)
  await f.settle(tester)
  await f.settle(reviewer)

  await f.advance()
  const qa = f.child('acceptance')
  assert.ok(qa)
  assert.deepEqual(new Set(f.controller.childTools(qa)), new Set(['workflow_packet', 'workflow_report', 'pwsh']))
  assert.match(f.controller.guard(qa, 'read', { file_path: 'src/app.js' }), /无权/)
  const qaArgs = { command: 'node --test', description: 'Run frozen black box check' }
  assert.equal(f.controller.guard(qa, 'pwsh', qaArgs), undefined)
  await executeCheck(f.controller, qa, qaArgs, pwshResult())
  await f.controller.report(qa, {
    role: 'acceptance_qa',
    results: [{ criterionId: 'AC-1', status: 'PASS', checkIds: ['ACC-1'], observation: '黑盒检查成功退出' }],
  }, signal)
  await f.settle(qa)

  const delivered = await f.advance()
  assert.equal(delivered.snapshot.run.outcome, 'PASS')
  assert.equal(delivered.deliverables.length, 1)
  assert.equal(delivered.deliverables[0].relativePath, 'src/app.js')
  assert.equal(delivered.deliverables[0].path, join(f.workspace, 'src', 'app.js'))
  assert.ok(delivered.learningSources.length >= 3)
  const learningSource = delivered.learningSources.find(item => item.taskId === 'engineering-test' && item.verdict === 'pass')
  assert.ok(learningSource)
  const learned = await f.controller.learn(f.root, {
    expectedRevision: f.snapshot().revision,
    items: [{
      ruleKey: 'independent-engineering-check',
      statement: '工程变更必须由独立工程测试角色运行冻结检查。',
      actionKind: 'quality-requirement',
      risk: 'execution-affecting',
      trigger: { mode: 'always', terms: [] },
      suggestedScope: 'project',
      sourceEvidenceIds: [learningSource.evidenceId],
    }],
  }, signal)
  assert.equal(learned.accepted.length, 1)
  assert.equal(f.snapshot().run.ledger.pass, 1)
  assert.equal(f.snapshot().run.agents.length, 4)
  assert.ok(f.calls.some(call => call.operation === 'start' && call.id === engineerId))
  const rolledBack = await f.controller.rollback(f.root, f.revision(), signal)
  assert.equal(rolledBack.applied, true, 'a delivered run still permits an explicit user-gated file rollback')
  const statusAfterRollback = await f.controller.status(f.root)
  assert.equal('deliverables' in statusAfterRollback, false, 'historical PASS artifacts are not presented as current after rollback')
})

test('a new run reports matching artifacts retained from a prior cancelled run without relabeling them as current delivery', async t => {
  const f = await fixture(t)
  await f.setup()
  const cancelledRunId = f.snapshot().run.runId
  await f.implement('export const inherited = true\n')
  await f.controller.stop(f.root)
  assert.equal(f.snapshot().run.outcome, 'CANCELLED')

  await f.setup()
  await f.implement('export const current = true\n', 'write', 'src/current.js')

  await f.advance()
  const tester = f.child('engineering-test')
  const reviewer = f.child('code-review')
  assert.ok(tester && reviewer)
  const reviewerPacket = f.controller.packet(reviewer)
  assert.deepEqual(reviewerPacket.artifacts.map(item => item.relativePath), ['src/current.js'])
  assert.deepEqual(reviewerPacket.retainedPriorRunArtifacts.map(item => ({
    relativePath: item.relativePath,
    sourceRunId: item.sourceRunId,
    sourceOutcome: item.sourceOutcome,
    provenance: item.provenance,
  })), [{
    relativePath: 'src/app.js',
    sourceRunId: cancelledRunId,
    sourceOutcome: 'CANCELLED',
    provenance: 'current-file-matches-prior-run-artifact',
  }])
  const checkArgs = { command: 'node --test', description: 'Run frozen engineering tests' }
  await executeCheck(f.controller, tester, checkArgs, pwshResult())
  await f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'PASS', observation: '测试成功退出' }] }, signal)
  await f.controller.report(reviewer, { role: 'code_reviewer', status: 'PASS', summary: '未发现阻塞问题', findings: [] }, signal)
  await f.settle(tester)
  await f.settle(reviewer)

  await f.advance()
  const qa = f.child('acceptance')
  assert.ok(qa)
  assert.deepEqual(f.controller.packet(qa).deliverable, {
    fileCount: 2,
    currentRunFileCount: 1,
    retainedPriorRunFileCount: 1,
    contractBound: true,
  })
  const qaArgs = { command: 'node --test', description: 'Run frozen black box check' }
  await executeCheck(f.controller, qa, qaArgs, pwshResult())
  await f.controller.report(qa, {
    role: 'acceptance_qa',
    results: [{ criterionId: 'AC-1', status: 'PASS', checkIds: ['ACC-1'], observation: '黑盒检查成功退出' }],
  }, signal)
  await f.settle(qa)

  const delivered = await f.advance()
  assert.deepEqual(delivered.deliverables.map(item => item.relativePath), ['src/current.js'])
  assert.deepEqual(delivered.retainedPriorRunArtifacts.map(item => ({
    relativePath: item.relativePath, sourceRunId: item.sourceRunId, sourceOutcome: item.sourceOutcome,
  })), [{ relativePath: 'src/app.js', sourceRunId: cancelledRunId, sourceOutcome: 'CANCELLED' }])
  const status = await f.controller.status(f.root)
  assert.deepEqual(status.deliverables.map(item => item.relativePath), ['src/current.js'])
  assert.deepEqual(status.retainedPriorRunArtifacts.map(item => item.relativePath), ['src/app.js'])
})

test('a prior-run artifact changed outside the recorded digest is not reported as retained provenance', async t => {
  const f = await fixture(t)
  await f.setup()
  await f.implement('export const inherited = true\n')
  await f.controller.stop(f.root)
  await writeFile(join(f.workspace, 'src', 'app.js'), 'external change\n', 'utf8')

  await f.setup()
  await f.advance()
  const engineer = f.child('implementation')
  assert.ok(engineer)
  assert.equal('retainedPriorRunArtifacts' in f.controller.packet(engineer), false)
})

test('an explicit native rollback removes a newly created file after the active run is stopped', async t => {
  const f = await fixture(t)
  await f.setup()
  await f.implement('export const temporary = true\n')
  await assert.rejects(
    f.controller.rollback(f.root, f.revision(), signal),
    /必须先停止/,
  )
  await f.controller.stop(f.root)
  const result = await f.controller.rollback(f.root, f.revision(), signal)
  assert.equal(result.applied, true)
  assert.deepEqual(result.files, [{ path: 'src/app.js', action: 'remove' }])
  await assert.rejects(access(join(f.workspace, 'src', 'app.js')), error => error.code === 'ENOENT')
  const rollbackQuestion = f.questions.at(-1)
  assert.equal(rollbackQuestion.header, '撤销确认')
  assert.match(rollbackQuestion.detail, /删除本轮新增文件：src\/app\.js/)
  assert.deepEqual(result.decisionAudit, {
    authority: 'user',
    channel: 'native-question',
    operator: 'unverified',
    requestId: rollbackQuestion.id,
  })
  assert.deepEqual(
    f.snapshot().run.gates.find(gate => gate.gateId === rollbackQuestion.id).decisionAudit,
    result.decisionAudit,
  )
  assert.equal(f.snapshot().run.rollback.latestApplied.fileCount, 1)
  assert.equal(f.snapshot().run.rollback.availableCheckpoints, 0)
  const projection = display(f.snapshot())
  assert.equal(projection.badge, '已撤销')
  assert.match(projection.summary, /原交付与验收结论仅保留为历史/)
  assert.equal(projection.stageDetails[5].label, '已撤销')
})

test('rollback restores exact prior bytes and refuses to overwrite an external edit', async t => {
  const restored = await fixture(t)
  await restored.setup()
  await restored.implement('export const ready = true\n', 'edit')
  await restored.controller.stop(restored.root)
  await restored.controller.rollback(restored.root, restored.revision(), signal)
  assert.equal(await readFile(join(restored.workspace, 'src', 'app.js'), 'utf8'), 'export const ready = false\n')

  const conflicted = await fixture(t)
  await conflicted.setup()
  await conflicted.implement('export const ready = true\n', 'edit')
  await conflicted.controller.stop(conflicted.root)
  await writeFile(join(conflicted.workspace, 'src', 'app.js'), 'external user edit\n', 'utf8')
  await assert.rejects(
    conflicted.controller.rollback(conflicted.root, conflicted.revision(), signal),
    /撤销冲突.*src\/app\.js/,
  )
  assert.equal(await readFile(join(conflicted.workspace, 'src', 'app.js'), 'utf8'), 'external user edit\n')
  assert.equal(conflicted.snapshot().run.rollback.latestApplied, null)
})

test('rollback authorization commit failure cannot move or replace any workspace file', async t => {
  const f = await fixture(t)
  await f.setup(); await f.implement('export const ready = true\n', 'edit'); await f.controller.stop(f.root)
  const commit = f.journal.commit.bind(f.journal)
  f.journal.commit = input => {
    if (input.events.some(event => event.name === 'rollback/prepared')) throw new Error('intent storage unavailable')
    return commit(input)
  }
  await assert.rejects(f.controller.rollback(f.root, f.revision(), signal), /intent storage unavailable/)
  assert.equal(await readFile(join(f.workspace, 'src/app.js'), 'utf8'), 'export const ready = true\n')
  assert.deepEqual(await readdir(join(f.workspace, 'src')), ['app.js'])
  assert.equal(f.journal.readRunState(f.root.id, f.snapshot().run.runId).rollbackTransaction, undefined)
})

test('completion commit failure preserves a recoverable intent instead of an unjournaled compensating rewrite', async t => {
  const f = await fixture(t)
  await f.setup(); await f.implement('export const ready = true\n', 'edit'); await f.controller.stop(f.root)
  const commit = f.journal.commit.bind(f.journal)
  f.journal.commit = input => {
    if (input.events.some(event => event.name === 'rollback/applied')) throw new Error('completion storage unavailable')
    return commit(input)
  }
  await assert.rejects(f.controller.rollback(f.root, f.revision(), signal), /completion storage unavailable/)
  assert.equal(await readFile(join(f.workspace, 'src/app.js'), 'utf8'), 'export const ready = false\n')
  const pending = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(pending.rollbackTransaction.phase, 'interrupted')
  assert.equal(pending.rollbacks.length, 0)
  assert.equal(display(f.snapshot()).badge, '撤销未完成')
  assert.equal('deliverables' in await f.controller.status(f.root), false)
  await assert.rejects(f.controller.propose(f.root, proposal(f.snapshot().revision), signal), /撤销/)
  f.journal.commit = commit
  const completed = await f.controller.rollback(f.root, f.revision(), signal)
  assert.equal(completed.applied, true)
  const after = f.journal.readRunState(f.root.id, f.snapshot().run.runId)
  assert.equal(after.rollbackTransaction.rollbackId, pending.rollbackTransaction.rollbackId)
  assert.notEqual(after.rollbackTransaction.gateId, pending.rollbackTransaction.gateId)
  assert.equal(after.rollbacks.length, 1)
  assert.deepEqual(await readdir(join(f.workspace, 'src')), ['app.js'])
})

test('an unfinished restore blocks another root in the same workspace but not an unrelated workspace', async t => {
  const f = await fixture(t)
  await f.setup(); await f.implement('export const ready = true\n', 'edit'); await f.controller.stop(f.root)
  const commit = f.journal.commit.bind(f.journal)
  f.journal.commit = input => {
    if (input.events.some(event => event.name === 'rollback/applied')) throw new Error('retain pending transaction')
    return commit(input)
  }
  await assert.rejects(f.controller.rollback(f.root, f.revision(), signal))
  const roots = [f.root]
  f.driver.isRoot = agent => roots.includes(agent)
  const other = { id: 'second-project-root', session: { header: { cwd: f.workspace } } }
  roots.push(other); f.controller.bindRoot(other)
  await assert.rejects(f.controller.propose(other, proposal(0), signal), /未完成的文件撤销/)
  const separate = { id: 'unrelated-project-root', session: { header: { cwd: await mkdtemp(join(tmpdir(), 'workflow-unrelated-')) } } }
  roots.push(separate); f.controller.bindRoot(separate)
  f.journal.commit = commit
  await f.controller.propose(separate, proposal(0), signal)
  assert.ok(f.journal.readSnapshot(separate.id).run)
  assert.equal(f.snapshot().run.rollback.pending.phase, 'interrupted')
})

test('project reports cannot forge checks or contradict Host-observed exit status', async t => {
  const f = await fixture(t)
  await f.setup()
  await f.implement()
  await f.advance()
  const tester = f.child('engineering-test')
  assert.ok(tester)
  await assert.rejects(
    f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'PASS', observation: '自称通过' }] }, signal),
    /没有本 Agent 的 Host 执行证据/,
  )
  await executeCheck(f.controller, tester, { command: 'node --test', description: 'Run frozen engineering tests' }, pwshResult(1))
  await assert.rejects(
    f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'PASS', observation: '仍自称通过' }] }, signal),
    /报告状态与真实退出结果不一致/,
  )
  await f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'FAIL', observation: '命令退出码为 1' }] }, signal)
})

test('all four confirmation kinds render the same required faces through one generator', async t => {
  const cards = await import('../lib/workflow-control.js')
  const f = await fixture(t)

  await f.controller.propose(f.root, proposal(f.snapshot().revision, 'architecture'), signal)
  await f.controller.confirm(f.root, f.revision(), signal)
  const requirementQuestion = f.questions.at(-1)
  assert.equal(requirementQuestion.header, '需求理解')

  await f.advance()
  const architect = f.child('architecture')
  assert.ok(architect)
  await f.controller.report(architect, {
    role: 'architect', summary: '沿用现有模块入口',
    decisions: [{ id: 'ADR-1', decision: '沿用现有入口', rationale: '避免引入新的依赖方向' }],
    affectedAreas: ['src/app.js'], interfaces: [], rollback: ['移除新增导出'],
  }, signal)
  await f.settle(architect)
  await f.advance()
  await f.controller.confirm(f.root, f.revision(), signal)
  const executionQuestion = f.questions.at(-1)
  assert.equal(executionQuestion.header, '执行授权')

  await f.implement()
  await f.controller.stop(f.root)
  const rollback = await f.controller.rollback(f.root, f.revision(), signal)
  assert.equal(rollback.applied, true)
  const rollbackQuestion = f.questions.at(-1)
  assert.equal(rollbackQuestion.header, '撤销确认')

  const rule = {
    ruleId: 'learning-12345678-1234-1234-1234-123456789012', version: 2, ruleKey: 'independent-engineering-check',
    statement: '工程变更必须由独立工程测试角色运行冻结检查。', basis: 'verified evidence',
    scope: 'project', actionKind: 'quality-requirement', risk: 'execution-affecting',
    trigger: { mode: 'always', terms: [] }, sourceEvidenceIds: ['evidence-1234567890'],
    sourceSummaryHash: 'a'.repeat(64), sourceRunId: 'run-1234567890',
    workflowProfile: 'workflow-project-pilot/1', projectKey: 'project-key-1234567890',
  }
  const revocation = cards.learningRevocationPresentation(rule, [rule])

  const details = {
    requirements: requirementQuestion.detail,
    execution: executionQuestion.detail,
    'rule-cleanup': revocation.detail,
    rollback: rollbackQuestion.detail,
  }
  const faces = cards.CONFIRMATION_REQUIRED_FIELDS.map(field => `**${cards.CONFIRMATION_FIELD_LABELS[field]}**`)
  const runId = f.snapshot().run.runId
  for (const [kind, detail] of Object.entries(details)) {
    const positions = faces.map(face => detail.indexOf(face))
    assert.ok(positions.every(index => index >= 0), `${kind} is missing a required face`)
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), `${kind} must present the faces in one order`)
    assert.equal(detail.split('\n').filter(line => line.startsWith('#')).length, 1, `${kind} shows exactly one heading`)
    assert.ok(detail.includes(cards.CONFIRMATION_AUDIT_POINTERS[kind]), `${kind} must use the fixed audit pointer`)
    assert.doesNotMatch(detail, /runId|ruleId|evidenceId|implementation@/i, `${kind} must keep identifiers out of the first screen`)
    assert.doesNotMatch(detail, new RegExp(runId))
    assert.doesNotMatch(detail, new RegExp(rule.ruleId))
  }
  for (const question of [requirementQuestion, executionQuestion, rollbackQuestion]) {
    assert.equal(question.intent.kind, 'plan-review')
    assert.equal(question.multiSelect, false)
    assert.equal(question.intent.approve, question.options[0].label)
  }
  assert.equal(new Set(cards.CONFIRMATION_CARD_KINDS).size, 4)
  assert.deepEqual([...cards.CONFIRMATION_REQUIRED_FIELDS], ['whyNow', 'changes', 'preserved', 'impactAndNext', 'auditPointer'])
})

test('the generic confirmation path hardcodes no task name, rule wording or rule id', async () => {
  const paths = [
    'src/workflow-confirmation-card.ts',
    'src/workflow-project-contract.ts',
    'src/workflow-pilot-contract.ts',
    'src/workflow-learning.ts',
    'src/workflow-ui-contract.ts',
    'src/host/workflow-controller.ts',
  ]
  const banned = [/PowerShell 5\.1/u, /\.ps1\b/u, /UTF-8 BOM/u, /端口管理/u, /chcp/u, /learning-[0-9a-f]{8}-/u]
  for (const path of paths) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    for (const pattern of banned) {
      assert.doesNotMatch(source, pattern, `${path} must not hardcode task or rule specific content`)
    }
  }
  for (const path of [
    'src/workflow-confirmation-card.ts', 'src/workflow-project-contract.ts',
    'src/workflow-pilot-contract.ts', 'src/workflow-learning.ts',
  ]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.match(source, /renderConfirmationCard\(/u, `${path} must render through the shared generator`)
  }
  const controller = await readFile(new URL('../src/host/workflow-controller.ts', import.meta.url), 'utf8')
  assert.match(controller, /rollbackConfirmationCard\(/u)
  assert.doesNotMatch(controller, /`# 撤销预览/u)
})

test('a verified project failure returns once to the same implementation role with explicit provenance', async t => {
  const f = await fixture(t)
  await f.setup()
  const originalEngineer = await f.implement('export const ready = false\n')
  await f.advance()
  const tester = f.child('engineering-test')
  const reviewer = f.child('code-review')
  await executeCheck(f.controller, tester, { command: 'node --test', description: 'Run frozen engineering tests' }, pwshResult(1))
  await f.controller.report(tester, { role: 'test_engineer', checks: [{ checkId: 'ENG-1', status: 'FAIL', observation: '测试失败' }] }, signal)
  await f.controller.report(reviewer, { role: 'code_reviewer', status: 'PASS', summary: '无额外阻塞项', findings: [] }, signal)
  await f.settle(tester)
  await f.settle(reviewer)

  const paused = await f.advance()
  assert.match(paused.next, /workflow_return/)
  const returned = await f.controller.returnForRework(f.root, f.revision(), signal)
  assert.equal(returned.snapshot.run.latestReturn.fromStage, 'verification')
  assert.equal(returned.snapshot.run.latestReturn.toStage, 'implementation')
  assert.equal(returned.snapshot.run.latestReturn.responsibleTaskId, 'implementation')
  assert.equal(returned.snapshot.run.latestReturn.attempt, 1)
  assert.match(returned.snapshot.run.latestReturn.reason, /ENG-1/)
  const returnDisplay = display(f.snapshot())
  assert.match(returnDisplay.summary, /验证.*当前证据没有通过.*返回实现/)
  assert.match(returnDisplay.next, /工程测试与代码审查并行复验.*独立黑盒验收/)
  assert.match(returnDisplay.nextDetail, /完整下游波次.*尚未支持只选择受影响检查/)

  const resumed = await f.advance()
  assert.equal(resumed.agents[0].id, originalEngineer)
  assert.equal(f.calls.at(-1).operation, 'resume')
})
