import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ROOT_TURN_WATCHDOG_CONFIG,
  RootTurnWatchdog,
  resolveRootTurnWatchdogConfig,
} from '../lib/workflow-control.js'

function fakeScheduler() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  const runDue = () => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!due) return
      timers.delete(due[0])
      due[1].callback()
    }
  }
  return {
    now: () => now,
    set(callback, delayMs) {
      const id = ++nextId
      timers.set(id, { at: now + delayMs, callback })
      return id
    },
    clear(id) { timers.delete(id) },
    advance(ms) { now += ms; runDue() },
    count: () => timers.size,
  }
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function harness({ persisted, waiting = false, deferSettlement = false,
  initialStatus = 'idle', cancelConverges = true, faultInjectionMode } = {}) {
  const scheduler = fakeScheduler()
  const agent = {
    id: faultInjectionMode ? 'workflow-timeout-fixture-unit' : 'root',
    status: initialStatus,
  }
  const calls = { cancel: 0, continued: [], stalls: [], settlements: [], errors: [] }
  const settlementReleases = []
  let current = persisted
  let awaitingUser = waiting
  let watchdog
  const coordinator = {
    isBoundRoot: candidate => candidate === agent,
    isAwaitingUser: () => awaitingUser,
    currentRootRecovery: () => current,
    async recordRootStall(_agent, observation) {
      calls.stalls.push(observation)
      const attempt = current?.status === 'recovering' ? current.attempt + 1 : 1
      current = {
        incidentId: `incident-${attempt}`,
        status: attempt === 1 ? 'recovering' : 'needs-attention',
        attempt,
        turn: observation.turn,
        stage: 'implementation',
        noProgressMs: observation.noProgressMs,
        journalRevision: 10 + attempt,
        reason: '测试停滞',
        preserved: ['Journal'],
        resumeFrom: '实现阶段',
      }
      return attempt === 1
        ? { kind: 'auto-continue', incidentId: current.incidentId, prompt: 'resume once' }
        : { kind: 'needs-attention', incidentId: current.incidentId }
    },
    async settleRootRecovery(_agent, incidentId, outcome, summary) {
      calls.settlements.push({ incidentId, outcome, summary })
      if (deferSettlement && outcome === 'resumed') {
        await new Promise(resolve => settlementReleases.push(resolve))
      }
      if (!current || current.incidentId !== incidentId) return false
      if (outcome === 'resumed') current = undefined
      else current = { ...current, status: 'needs-attention' }
      return true
    },
  }
  const driver = {
    cancel(candidate) {
      assert.equal(candidate, agent)
      calls.cancel++
      if (cancelConverges) {
        agent.status = 'idle'
        watchdog.observeStatus(agent, 'idle')
      }
    },
    whenIdle: cancelConverges ? async () => {} : async () => new Promise(() => {}),
    continue(candidate, prompt) {
      assert.equal(candidate, agent)
      calls.continued.push(prompt)
      agent.status = 'running'
      watchdog.observeStatus(agent, 'running')
    },
  }
  watchdog = new RootTurnWatchdog(coordinator, driver, {
    rootTurnNoProgressMs: 100,
    rootRecoveryNoProgressMs: 50,
    rootCancelGraceMs: 20,
    userWaitProbeMs: 25,
    ...(faultInjectionMode ? { faultInjections: [{
      rootSessionId: agent.id,
      rootTurnNoProgressMs: 100,
      rootRecoveryNoProgressMs: 50,
      mode: faultInjectionMode,
      acknowledge: 'controlled-local-only',
    }] } : {}),
  }, scheduler, error => calls.errors.push(error))
  watchdog.bind(agent)
  return {
    watchdog, scheduler, agent, calls,
    recovery: () => current,
    releaseSettlement() { settlementReleases.shift()?.() },
    setWaiting(value) { awaitingUser = value },
    run() { agent.status = 'running'; watchdog.observeStatus(agent, 'running') },
    idle() { agent.status = 'idle'; watchdog.observeStatus(agent, 'idle') },
  }
}

test('root watchdog cancels only the stalled turn, retries once, then stops the loop', async () => {
  const f = harness()
  f.run()
  f.watchdog.observeSessionEvent(f.agent, { type: 'turn/start', data: { turn: 7 } })
  f.scheduler.advance(99)
  assert.equal(f.calls.cancel, 0)
  f.scheduler.advance(1)
  await flush()
  assert.equal(f.calls.cancel, 1)
  assert.deepEqual(f.calls.continued, ['resume once'])
  assert.equal(f.recovery().status, 'recovering')
  assert.equal(f.calls.stalls[0].turn, 7)

  f.scheduler.advance(50)
  await flush()
  assert.equal(f.calls.cancel, 2)
  assert.equal(f.calls.continued.length, 1, 'the recovery turn must not recursively retry')
  assert.equal(f.recovery().status, 'needs-attention')
  assert.equal(f.recovery().attempt, 2)
  f.watchdog.close()
})

test('an exact diagnostic fixture suppresses progress on both turns and reaches needs-attention', async () => {
  const f = harness({ faultInjectionMode: 'first-and-recovery' })
  f.run()
  f.scheduler.advance(60)
  f.watchdog.observeAssistantFrame(f.agent)
  f.watchdog.observeSessionEvent(f.agent, { type: 'tool/result' })
  f.scheduler.advance(39)
  assert.equal(f.calls.cancel, 0)
  f.scheduler.advance(1)
  await flush()
  assert.equal(f.calls.cancel, 1)
  assert.equal(f.calls.stalls[0].faultInjected, true)
  assert.equal(f.recovery().status, 'recovering')

  f.scheduler.advance(25)
  f.watchdog.observeAssistantFrame(f.agent)
  f.scheduler.advance(24)
  assert.equal(f.calls.cancel, 1)
  f.scheduler.advance(1)
  await flush()
  assert.equal(f.calls.cancel, 2)
  assert.equal(f.calls.stalls[1].faultInjected, true)
  assert.equal(f.recovery().status, 'needs-attention')
  assert.equal(f.calls.continued.length, 1)
  f.watchdog.close()
})

test('first-stall-only injection restores normal progress semantics during its recovery turn', async () => {
  const f = harness({ faultInjectionMode: 'first-stall-only' })
  f.run()
  f.scheduler.advance(100)
  await flush()
  assert.equal(f.calls.cancel, 1)
  assert.equal(f.calls.stalls[0].faultInjected, true)

  f.scheduler.advance(40)
  f.watchdog.observeAssistantFrame(f.agent)
  f.scheduler.advance(49)
  assert.equal(f.calls.cancel, 1, 'recovery progress must restart its normal budget')
  f.idle()
  await flush()
  assert.equal(f.recovery(), undefined)
  assert.equal(f.calls.settlements.at(-1).outcome, 'resumed')
  f.watchdog.close()
})

test('native user-question waiting is excluded and progress restarts the full budget', async () => {
  const f = harness({ waiting: true })
  f.run()
  f.scheduler.advance(100)
  await flush()
  assert.equal(f.calls.cancel, 0)
  f.setWaiting(false)
  f.watchdog.observeSessionEvent(f.agent, { type: 'tool/result' })
  f.scheduler.advance(99)
  assert.equal(f.calls.cancel, 0)
  f.scheduler.advance(1)
  await flush()
  assert.equal(f.calls.cancel, 1)
  f.watchdog.close()
})

test('native wait settlement grants a fresh budget without depending on a later tool event', async () => {
  const f = harness()
  f.run()
  f.scheduler.advance(95)
  f.setWaiting(true)
  f.watchdog.observeUserWait(f.agent)
  for (let count = 0; count < 12; count++) {
    f.scheduler.advance(25)
    await flush()
  }
  assert.equal(f.calls.cancel, 0)
  f.setWaiting(false)
  f.watchdog.observeUserWait(f.agent)
  f.scheduler.advance(99)
  await flush()
  assert.equal(f.calls.cancel, 0)
  f.scheduler.advance(1)
  await flush()
  assert.equal(f.calls.cancel, 1, 'true inactivity is still supervised after an answer')
  f.watchdog.close()
  f.watchdog.observeUserWait(f.agent)
  assert.equal(f.scheduler.count(), 0)
})

test('a successful automatic continuation settles the Journal marker and starts a fresh chain later', async () => {
  const f = harness()
  f.run()
  f.scheduler.advance(100)
  await flush()
  assert.equal(f.recovery().status, 'recovering')
  f.watchdog.observeAssistantFrame(f.agent)
  f.idle()
  await flush()
  assert.equal(f.recovery(), undefined)
  assert.equal(f.calls.settlements.at(-1).outcome, 'resumed')

  f.run()
  f.scheduler.advance(100)
  await flush()
  assert.equal(f.calls.continued.length, 2, 'a later independent turn receives its own single recovery allowance')
  f.watchdog.close()
})

test('a new native turn is not timed against stale recovery state while durable settlement is pending', async () => {
  const f = harness({ deferSettlement: true })
  f.run()
  f.scheduler.advance(100)
  await flush()
  f.idle()
  await flush()
  assert.equal(f.calls.settlements.length, 1)

  f.run()
  f.scheduler.advance(500)
  await flush()
  assert.equal(f.calls.cancel, 1, 'no timeout is armed before recovery settlement commits')

  f.releaseSettlement()
  await flush()
  assert.equal(f.recovery(), undefined)
  f.scheduler.advance(99)
  assert.equal(f.calls.cancel, 1)
  f.scheduler.advance(1)
  await flush()
  assert.equal(f.calls.cancel, 2, 'the new turn receives a fresh full budget after settlement')
  f.watchdog.close()
})

test('a recovering marker found after Host lifecycle loss becomes needs-attention, never blind auto-resume', async () => {
  const persisted = {
    incidentId: 'persisted-incident', status: 'recovering', attempt: 1, turn: 4,
    stage: 'delivery', noProgressMs: 180_000, journalRevision: 20,
    reason: '旧 Host 中断', preserved: ['Journal'], resumeFrom: '交付说明',
  }
  const f = harness({ persisted })
  await flush()
  assert.equal(f.recovery().status, 'needs-attention')
  assert.equal(f.calls.continued.length, 0)
  assert.equal(f.calls.settlements[0].outcome, 'needs-attention')
  f.watchdog.close()
})

test('lifecycle recovery fails closed when cancellation does not converge', async () => {
  const persisted = {
    incidentId: 'persisted-running', status: 'recovering', attempt: 1, turn: 4,
    stage: 'delivery', noProgressMs: 180_000, journalRevision: 20,
    reason: '旧 Host 中断', preserved: ['Journal'], resumeFrom: '交付说明',
  }
  const f = harness({ persisted, initialStatus: 'running', cancelConverges: false })
  f.scheduler.advance(20)
  await flush()
  assert.equal(f.calls.cancel, 1)
  assert.equal(f.calls.settlements.length, 0, 'an Agent still running must not be marked durably settled')
  assert.equal(f.calls.continued.length, 0)
  assert.equal(f.recovery().status, 'recovering')
  assert.match(String(f.calls.errors[0]), /did not converge to idle/)
  f.watchdog.close()
})

test('production watchdog defaults and config reject accidental sub-second budgets', () => {
  assert.equal(resolveRootTurnWatchdogConfig({}).rootTurnNoProgressMs,
    DEFAULT_ROOT_TURN_WATCHDOG_CONFIG.rootTurnNoProgressMs)
  assert.throws(() => resolveRootTurnWatchdogConfig({ rootTurnNoProgressMs: 999 }), /1000ms/)
})

test('fault injection config is exact, acknowledged, bounded and independently validated', () => {
  const fixture = {
    rootSessionId: 'workflow-timeout-fixture-requirements-stop',
    rootTurnNoProgressMs: 100,
    rootRecoveryNoProgressMs: 250,
    mode: 'first-and-recovery',
    acknowledge: 'controlled-local-only',
  }
  assert.deepEqual(resolveRootTurnWatchdogConfig({ faultInjections: [fixture] }).faultInjections, [fixture])
  assert.throws(() => resolveRootTurnWatchdogConfig({
    faultInjections: [{ ...fixture, rootSessionId: 'ordinary-session' }],
  }), /exact workflow-timeout-fixture/)
  assert.throws(() => resolveRootTurnWatchdogConfig({
    faultInjections: [{ ...fixture, acknowledge: 'yes' }],
  }), /controlled-local-only/)
  assert.throws(() => resolveRootTurnWatchdogConfig({
    faultInjections: [{ ...fixture, rootTurnNoProgressMs: 99 }],
  }), /100ms/)
  assert.throws(() => resolveRootTurnWatchdogConfig({ faultInjections: [fixture, fixture] }), /unique/)
  assert.throws(() => resolveRootTurnWatchdogConfig({
    faultInjections: [{ ...fixture, extra: true }],
  }), /undeclared fields/)
})
