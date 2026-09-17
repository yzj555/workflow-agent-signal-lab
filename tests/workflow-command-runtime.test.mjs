import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowCommandRuntime, resolveCommandConfig } from '../lib/workflow-control.js'
import { childClock, flushChild } from './helpers/workflow-child-clock.mjs'

const config = { commandTimeoutMs: 1000, commandExitGraceMs: 1000 }
const result = (overrides = {}) => ({ isError: false, value: { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false, ...overrides }, content: [] })
function fixture(options = {}) {
  const clock = childClock(), runtime = new WorkflowCommandRuntime(config, clock)
  const parent = new AbortController(), lease = new AbortController()
  const exec = { signal: parent.signal }
  const done = Promise.withResolvers(), exit = Promise.withResolvers()
  const interruptions = []
  let terminates = 0, dispatches = 0, spawnedSpec
  const handle = { done: done.promise, collected: {}, terminate() { terminates++; options.terminate?.({ done, exit }) },
    waitForExit: signal => options.waitForExit?.(signal) ?? exit.promise }
  const spec = { argv: ['official-confining-runner', 'frozen-argv'], cwd: 'frozen-workdir', env: { EXPLICIT: 'retained' } }
  const run = () => runtime.run(exec, lease.signal, 1000, async () => {
    dispatches++
    runtime.spawn({ spawn: value => { spawnedSpec = value; return handle } }, spec)
    if (options.dispatch) return options.dispatch({ exec, done, exit, runtime, handle })
    await done.promise
    return result()
  }, (cause, elapsed) => interruptions.push({ cause, elapsed }))
  return { clock, runtime, parent, lease, exec, done, exit, run, spec, interruptions,
    get terminates() { return terminates }, get dispatches() { return dispatches }, get spawnedSpec() { return spawnedSpec } }
}

test('command configuration has independent safe integer ceilings', () => {
  assert.equal(resolveCommandConfig().commandTimeoutMs, 120000)
  for (const value of [0, 999, 120001, 1000.5, Infinity, '1000']) {
    assert.throws(() => resolveCommandConfig({ commandTimeoutMs: value }))
    assert.throws(() => resolveCommandConfig({ commandExitGraceMs: value }))
  }
})

test('exit zero waits for the exact managed range, preserves native spawn spec and restores signal', async () => {
  const f = fixture()
  let settled = false
  const work = f.run().then(value => { settled = true; return value })
  f.done.resolve({ exitCode: 0, signal: null }); await flushChild()
  assert.equal(settled, false)
  assert.equal(f.spawnedSpec, f.spec, 'argv/cwd/env are delegated without rewriting')
  f.exit.resolve(true)
  const observed = await work
  assert.equal(observed.exitConfirmed, true); assert.equal(observed.toolSettled, true)
  assert.equal(observed.cause, undefined); assert.equal(f.terminates, 0)
  assert.equal(f.exec.signal, f.parent.signal); assert.equal(f.clock.count(), 0)
})

test('command timeout terminates once and waits for real convergence, not just Agent drain', async () => {
  const f = fixture({ terminate: ({ done, exit }) => { done.resolve(); exit.resolve(true) } })
  const work = f.run()
  f.clock.advance(1000)
  const observed = await work
  assert.equal(observed.cause, 'command-timeout')
  assert.equal(observed.exitConfirmed, true); assert.equal(observed.toolSettled, true)
  assert.equal(f.terminates, 1); assert.equal(f.dispatches, 1)
  assert.deepEqual(f.interruptions, [{ cause: 'command-timeout', elapsed: 1000 }])
  assert.equal(f.clock.count(), 0)
})

test('unknown managed-range exit never becomes pass despite a zero exit code', async () => {
  const f = fixture()
  const work = f.run()
  f.done.resolve(); f.exit.resolve(false)
  const observed = await work
  assert.equal(observed.cause, 'command-exit-unknown'); assert.equal(observed.exitConfirmed, false)
  assert.equal(f.terminates, 1)
})

test('provider observation rejection is fail-closed and bounded', async () => {
  const f = fixture({ waitForExit: () => Promise.reject(new Error('owner channel lost')) })
  const work = f.run()
  await flushChild()
  assert.equal(f.interruptions[0].cause, 'command-exit-unknown')
  f.clock.advance(1000)
  const observed = await work
  assert.equal(observed.exitConfirmed, false); assert.equal(observed.toolSettled, false)
  f.done.resolve(); await flushChild()
  assert.equal(f.clock.count(), 0)
})

test('noncooperative tool and process return unknown at grace; a late spawn is rejected without replay', async () => {
  let lateError
  const f = fixture({ dispatch: async ({ runtime, done, handle }) => {
    await done.promise
    try { runtime.spawn({ spawn: () => { assert.fail('late provider must not be called'); return handle } }, {}) }
    catch (error) { lateError = error }
    return result()
  } })
  const work = f.run()
  f.clock.advance(1000); await flushChild(); f.clock.advance(1000)
  const observed = await work
  assert.equal(observed.exitConfirmed, false); assert.equal(observed.toolSettled, false)
  f.done.resolve(); f.exit.resolve(true); await flushChild()
  assert.match(lateError.message, /凭据失效/)
  assert.equal(f.dispatches, 1); assert.equal(f.clock.count(), 0)
})

test('upstream cancellation wins over later command deadline', async () => {
  const f = fixture({ terminate: ({ done, exit }) => { done.resolve(); exit.resolve(true) } })
  const work = f.run()
  f.clock.advance(100); f.parent.abort()
  const observed = await work
  f.clock.advance(2000)
  assert.equal(observed.cause, 'command-cancelled')
  assert.deepEqual(f.interruptions, [{ cause: 'command-cancelled', elapsed: 100 }])
})

test('a pre-cancelled call never reaches the native provider', async () => {
  const f = fixture(); f.lease.abort()
  const observed = await f.run()
  assert.equal(f.dispatches, 0); assert.equal(observed.cause, 'command-cancelled')
})

test('native executor timeout is runtime interruption, not an ordinary failed check', async () => {
  const f = fixture({ dispatch: async () => result({ timedOut: true, exitCode: 1 }) })
  const work = f.run(); f.done.resolve(); f.exit.resolve(true)
  assert.equal((await work).cause, 'command-timeout')
})

test('sandbox or tool policy error is never retried or replaced with an unconfined spawn', async () => {
  const clock = childClock(), runtime = new WorkflowCommandRuntime(config, clock)
  const exec = { signal: new AbortController().signal }
  let calls = 0
  const observed = await runtime.run(exec, exec.signal, 1000, async () => {
    calls++; return { isError: true, error: { message: 'SANDBOX_UNAVAILABLE' }, content: [] }
  }, () => {})
  assert.equal(calls, 1); assert.equal(observed.exitConfirmed, false)
  assert.equal(observed.cause, 'command-execution-error')
})

test('overlapping calls retain separate handles; cancelling one does not terminate its sibling', async () => {
  const clock = childClock(), runtime = new WorkflowCommandRuntime(config, clock)
  const a = new AbortController(), b = new AbortController(), ad = Promise.withResolvers(), bd = Promise.withResolvers()
  const terminated = []
  const invoke = (id, signal, gate) => runtime.run({ signal }, signal, 1000, async () => {
    await flushChild()
    runtime.spawn({ spawn: () => ({ collected: {}, done: gate.promise,
      terminate() { terminated.push(id); gate.resolve() }, waitForExit: async () => { await gate.promise; return true } }) }, {})
    await gate.promise; return result()
  }, () => {})
  const aw = invoke('a', a.signal, ad), bw = invoke('b', b.signal, bd)
  await flushChild(); await flushChild()
  a.abort(); assert.equal((await aw).cause, 'command-cancelled')
  assert.deepEqual(terminated, ['a'])
  bd.resolve(); assert.equal((await bw).cause, undefined)
  assert.equal(clock.count(), 0)
})
