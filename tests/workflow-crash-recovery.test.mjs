import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { fixture, diskView } from './helpers/workflow-crash-fixture.mjs'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const options = { timeout: 90000 }
const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))

function recoveredBudget(before, after) {
  const old = before.snapshot.run.budget, next = after.snapshot.run.budget
  assert.deepEqual(next.used, old.used, 'Requests and command counts cannot reset or increment on recovery')
  assert.deepEqual(next.limits, old.limits, 'Larger new Host defaults must not refill a frozen account')
  if (old.time) {
    assert.ok(old.time.reservedMs > 0, 'Crash actually left a durable unsettled grant')
    assert.equal(next.time.uncertainMs, old.time.uncertainMs + old.time.reservedMs)
    assert.equal(next.time.observedMs, old.time.observedMs)
    assert.equal(next.time.overrunMs, old.time.overrunMs)
    assert.equal(next.time.reservedMs, 0)
    assert.equal(next.time.ownerId, null)
  }
  assert.equal(after.snapshot.run.outcome, null, 'Host failure is not business PASS/FAIL or user cancellation')
  assert.equal(after.snapshot.run.ledger.fail, 0)
}

test('cross-process crash: active child model becomes unknown; time recovered once; advance cannot re-dispatch', options, async t => {
  const h = await fixture(t, 'child-model'), active = await h.host('child-model')
  assert.ok(active.ready.requests.some(request => request.held && request.role === 'engineer'))
  const before = await h.cut(active)
  const cold = await h.host('cold'), after = cold.ready
  recoveredBudget(before, after)
  const agents = after.snapshot.run.agents
  assert.equal(agents.length, 1)
  assert.equal(agents[0].runtimeIssue.status, 'unknown')
  assert.equal(agents[0].runtimeIssue.cause, 'host-restart')
  assert.match(JSON.stringify(displayWorkflowState({ status: 'ready', snapshot: after.snapshot }, [], stages)), /未确认/)
  assert.equal(after.requests.length, 0)
  const denied = await cold.request('probe-advance')
  assert.equal(denied.detail.accepted, false)
  assert.deepEqual(denied.snapshot, after.snapshot)
  assert.equal(denied.requests.length, 0)
  await h.save('cold-and-advance-denied', denied)
  await h.repeated(cold, after)
})

test('cross-process crash: unsettled root duration may conservatively exhaust once, never count Host downtime', options, async t => {
  const h = await fixture(t, 'root-time-cap'), active = await h.host('root-time-cap')
  assert.ok(active.ready.requests.some(request => request.held && request.sessionId === h.rootId))
  const before = await h.cut(active)
  assert.equal(before.snapshot.run.budget.blocked, null, 'Cut occurred before the live deadline')
  await delay(5250) // Longer than the whole allowance; downtime must not be counted.
  const cold = await h.host('cold'), after = cold.ready
  recoveredBudget(before, after)
  const budget = after.snapshot.run.budget
  assert.equal(budget.blocked.resource, 'active-time')
  assert.equal(budget.time.observedMs + budget.time.uncertainMs, 5000)
  assert.equal(budget.recovery.blocks, 1)
  assert.equal(budget.recovery.closed, false)
  const denied = await cold.request('probe-advance')
  assert.equal(denied.detail.accepted, false)
  assert.deepEqual(denied.snapshot, after.snapshot)
  await h.save('conservative-time-exhaustion', denied)
  await h.repeated(cold, after)
})

test('cross-process crash: live frozen command stays unknown while files and completed review survive', options, async t => {
  const h = await fixture(t, 'command'), active = await h.host('command')
  const owned = JSON.parse(await readFile(join(h.directory, 'budget-owned-pids.json'), 'utf8'))
  for (const pid of [owned.testPid, owned.descendantPid]) assert.doesNotThrow(() => process.kill(pid, 0))
  const originalFile = await readFile(join(h.directory, 'src/native.js'), 'utf8')
  const control = spawn(process.execPath, ['-e', "console.log('control-ready');setTimeout(()=>{},60000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const controlExit = once(control, 'exit')
  t.after(async () => { if (control.exitCode === null && control.signalCode === null) control.kill(); await controlExit })
  await once(control.stdout, 'data')
  const before = await h.cut(active)
  assert.equal(Object.values(before.state.commands).length, 1)
  assert.equal(Object.values(before.state.commands)[0].status, 'running')
  const cold = await h.host('cold'), after = cold.ready
  recoveredBudget(before, after)
  const command = Object.values(after.state.commands)[0]
  assert.equal(command.status, 'unknown')
  assert.equal(command.observation.exitConfirmed, false)
  assert.equal(command.observation.toolSettled, false)
  assert.equal(command.observation.exitCode, null)
  const role = id => after.snapshot.run.agents.find(agent => agent.taskId === id)
  assert.equal(role('engineering-test').runtimeIssue.status, 'unknown')
  assert.equal(role('code-review').status, 'idle')
  assert.equal(role('code-review').runtimeIssue, undefined)
  assert.deepEqual(after.state.records, before.state.records, 'Preserve completed artifacts and frozen requirements')
  assert.equal(await readFile(join(h.directory, 'src/native.js'), 'utf8'), originalFile, 'No automatic file rollback')
  const denied = await cold.request('probe-advance')
  assert.equal(denied.detail.accepted, false)
  assert.deepEqual(denied.snapshot, after.snapshot)
  await h.save('cold-command-unknown', { ...denied, owned, unrelatedPid: control.pid })
  await h.repeated(cold, after)
  // Old command/descendant have their own 20s fuse; Windows may also reclaim
  // them with the dead Host. Do not infer which mechanism caused their exit.
  // Their disappearance is NOT managed exit proof for the fresh Host.
  const end = Date.now() + 24000
  const exists = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  while ([owned.testPid, owned.descendantPid].some(exists) && Date.now() < end) await delay(100)
  assert.ok([owned.testPid, owned.descendantPid].every(pid => !exists(pid)), 'Bounded fixture processes must exit')
  assert.equal(control.exitCode, null); assert.equal(control.signalCode, null)
  assert.equal(exists(control.pid), true, 'Unrelated process is not stopped')
  const final = await diskView(h.directory, h.rootId)
  assert.deepEqual(final.snapshot, after.snapshot)
  const markers = (await readFile(join(h.directory, 'budget-processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(markers.filter(item => item.event === 'started').length, 1, 'No automatic command rerun')
  await h.save('old-processes-gone-not-exit-proof', { final, markers, owned, unrelatedStillAlive: true })
})

test('cross-process crash: pending native budget approval is cancelled and a late decision cannot refill', options, async t => {
  const h = await fixture(t, 'pending-gate'), active = await h.host('pending-gate')
  assert.ok(active.ready.nativeQuestion)
  const before = await h.cut(active)
  const pending = before.snapshot.run.budget.recovery.requests.at(-1)
  assert.equal(pending.status, 'pending')
  const cold = await h.host('cold'), after = cold.ready
  recoveredBudget(before, after)
  const request = after.snapshot.run.budget.recovery.requests.at(-1)
  assert.equal(request.id, pending.id)
  assert.equal(request.status, 'cancelled')
  assert.equal(request.decisionAudit, undefined)
  const denied = await cold.request('late-approval', { requestId: pending.id })
  assert.equal(denied.detail.accepted, false)
  assert.deepEqual(denied.snapshot, after.snapshot)
  assert.equal(denied.requests.length, 0)
  await h.save('pending-gate-cancelled-old-approval-denied', denied)
  await h.repeated(cold, after)
})
