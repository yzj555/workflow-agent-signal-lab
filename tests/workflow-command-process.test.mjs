import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { WorkflowCommandRuntime } from '../lib/workflow-control.js'
import * as WorkflowPwsh from '../lib/workflow-pwsh.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'command-processes')
const options = { timeout: 20000, skip: process.platform !== 'win32' ? 'Windows command integration fixture' : false }

async function setup(t) {
  // node --test propagates this sentinel to descendants, otherwise the nested
  // frozen test runner silently skips every file and returns a false green.
  // This test-file process is isolated by Node; no DSH Host environment changes.
  const testContext = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  t.after(() => {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = testContext
  })
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-command-process-'))
  await cp(fixtures, cwd, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  // This independent fixture explicitly selects full access; production policy
  // inheritance is separately exercised by the real AgentLoop integration test.
  ctx.provide('sandbox', { confine() { throw new Error('fixture never requests confined execution or escalation') } })
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) })
  ctx.provide('shellEnv', { collect: () => ({}) })
  await ctx.plugin(SandboxPwshExecutor, { cwd, timeoutMs: 10000, maxTimeoutMs: 10000, graceMs: 200 })
  const commands = new WorkflowCommandRuntime({ commandTimeoutMs: 2500, commandExitGraceMs: 5000 })
  ctx.provide('workflowController', { commands })
  let observation
  const interruptions = []
  ctx.on('tools/execute', async (exec, next) => {
    observation = await commands.run(exec, new AbortController().signal, 2500, next, cause => interruptions.push(cause))
    return observation.result ?? { isError: true, content: [{ type: 'text', text: 'controlled command interrupted' }] }
  })
  await ctx.plugin(WorkflowPwsh)
  t.after(async () => { await ctx.fiber.dispose() })
  const run = filename => ctx.tools.execute({ name: 'pwsh', callId: randomUUID(),
    arguments: { command: `node --test ${filename}`, description: 'Run isolated process containment fixture', workdir: cwd }, signal: new AbortController().signal })
  return { ctx, cwd, run, interruptions, get observation() { return observation } }
}

function assertPidGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'read-only PID probe: controlled descendant must no longer be alive')
}

test('official ToolRuntime + sandboxed PowerShell + local subprocess attest a normal command range', options, async t => {
  const f = await setup(t)
  const result = await f.run('pass.test.cjs')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(f.observation.exitConfirmed, true)
  assert.equal(f.observation.processCount, 1); assert.equal(f.observation.cause, undefined)
  assert.equal(result.value.exitCode, 0)
  assert.match(result.value.stdout.text, /controlled passing command/)
  // The decorator is local to the official tool's captured context, not the Host service.
  const unrelated = await f.ctx.shell.run(f.ctx.shell.resolve({ command: 'Write-Output scope-unchanged', workdir: f.cwd }))
  assert.equal(unrelated.exitCode, 0); assert.match(unrelated.stdout.text, /scope-unchanged/)
})

test('real zero-exit command is accepted only after its controlled descendant has exited the native managed range', options, async t => {
  const f = await setup(t)
  await f.run('survivor.test.cjs')
  assert.equal(f.observation.result.value.exitCode, 0, 'native direct-command result alone would have looked successful')
  assertPidGone(JSON.parse(await readFile(join(f.cwd, 'fixture-pid.json'), 'utf8')).pid)
  assert.equal(f.observation.exitConfirmed, true); assert.equal(f.observation.toolSettled, true)
  // This pinned Windows provider reaps surviving descendants when its leader
  // ends. Other providers may need our deadline; unit fixtures cover that wait.
  assert.equal(f.observation.cause, undefined, JSON.stringify(f.observation))
  assert.deepEqual(f.interruptions, [])
})

test('real hanging command timeout ends the command and its controlled descendant without retry', options, async t => {
  const f = await setup(t)
  await f.run('hang.test.cjs')
  assert.equal(f.observation.cause, 'command-timeout', JSON.stringify(f.observation))
  assert.equal(f.observation.exitConfirmed, true); assert.equal(f.observation.toolSettled, true)
  assert.equal(f.observation.processCount, 1)
  assertPidGone(JSON.parse(await readFile(join(f.cwd, 'fixture-pid.json'), 'utf8')).pid)
  assert.deepEqual(f.interruptions, ['command-timeout'])
})
