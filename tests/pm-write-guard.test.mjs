import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  classifyPmWriteTarget,
  isDelegatedAgentExecution,
} from '../lib/index.js'

const cwd = 'F:\\dsh\\workflow-agent-signal-lab'

function execution(header, extra = {}) {
  return {
    agent: { session: { header: { cwd, ...header } } },
    arguments: { file_path: 'CREW_WRITE_PROBE.txt' },
    callId: 'call-1',
    name: 'write',
    signal: new AbortController().signal,
    ...extra,
  }
}

function harness(approvalOutcome = 'unavailable') {
  let listener
  const ctx = {
    get: name => name === 'approval'
      ? { request: async () => approvalOutcome }
      : undefined,
    on: (name, value) => {
      assert.equal(name, 'tools/execute')
      listener = value
    },
  }
  apply(ctx, { jobsDir: 'F:\\dsh\\jobs' })
  return exec => {
    let dispatches = 0
    return listener(exec, async () => {
      dispatches += 1
      return { content: [{ type: 'text', text: 'ran' }], isError: false }
    }).then(result => ({ dispatches, result }))
  }
}

test('recognizes only a durable delegated child header', () => {
  assert.equal(isDelegatedAgentExecution(execution({
    origin: 'subagent',
    parentSession: 'root-session',
    delegationDepth: 1,
  })), true)
  assert.equal(isDelegatedAgentExecution(execution({ origin: 'subagent' })), false)
  assert.equal(isDelegatedAgentExecution(execution({ delegationDepth: 1 })), false)
  assert.equal(isDelegatedAgentExecution(execution({})), false)
})

test('delegated engineer write passes without approval', async () => {
  const run = harness('rejected')
  const outcome = await run(execution({
    origin: 'subagent',
    parentSession: 'root-session',
    delegationDepth: 1,
  }))
  assert.equal(outcome.dispatches, 1)
  assert.equal(outcome.result.isError, false)
})

test('root nested write stays guarded', async () => {
  const run = harness('rejected')
  const outcome = await run(execution({}, { parent: Symbol('code-mode-parent') }))
  assert.equal(outcome.dispatches, 0)
  assert.equal(outcome.result.isError, true)
  assert.match(outcome.result.error.message, /root Agent may not write/)
})

test('one approved root write passes once', async () => {
  const run = harness('allowed-once')
  const outcome = await run(execution({}))
  assert.equal(outcome.dispatches, 1)
  assert.equal(outcome.result.isError, false)
})

test('keeps the upstream PM whitelist shape', () => {
  assert.equal(classifyPmWriteTarget('F:\\repo\\docs\\design\\prd-probe.md', 'F:\\jobs'), 'pm')
  assert.equal(classifyPmWriteTarget('F:\\repo\\docs\\tasks\\T-01.md', 'F:\\jobs'), 'pm')
  assert.equal(classifyPmWriteTarget('F:\\repo\\src\\index.ts', 'F:\\jobs'), 'protected')
})
