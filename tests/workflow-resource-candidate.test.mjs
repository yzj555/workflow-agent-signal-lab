import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolveRootTurnWatchdogConfig, resolveChildWatchdogConfig, resolveCommandConfig,
  resolveRunBudgetEnabled, resolveRunBudgetScope, resolveRunBudgetLimits, MAX_RUN_TOPUPS,
  CONTROL_REQUESTS_PER_GRANT, CONTROL_REQUESTS_PER_TURN, CLOSED_RUN_HANDOFF_REQUESTS, resolveHostAdmissionConfig } from '../lib/workflow-control.js'

test('resource candidate matches validated runtime knobs but cannot silently activate or claim Host enforcement', async () => {
  const policy = JSON.parse(await readFile(new URL('../src/workflow-resource-candidate.json', import.meta.url), 'utf8'))
  const config = policy.engineConfig
  assert.equal(policy.status, 'candidate-not-activated'); assert.equal(policy.dsh, '0.2.0-rc.2')
  assert.equal(resolveRunBudgetEnabled(), false); assert.deepEqual(resolveRunBudgetScope(), [])
  assert.equal(resolveRunBudgetEnabled(config), true); assert.equal(resolveRunBudgetScope(config), 'all')
  assert.deepEqual(resolveRunBudgetLimits(config), { modelRequests: 240, commands: 40, activeMs: 1800000 })
  assert.deepEqual(resolveRootTurnWatchdogConfig(config), { rootTurnNoProgressMs: 180000, rootRecoveryNoProgressMs: 120000,
    rootCancelGraceMs: 15000, userWaitProbeMs: 30000, faultInjections: [] })
  assert.deepEqual(resolveChildWatchdogConfig(config), { childAdmissionMs: 30000, childNoProgressMs: 180000, childMaxRunMs: 1200000,
    childReportGraceMs: 15000, childCancelGraceMs: 15000, childRoleBudgets: {} })
  assert.deepEqual(resolveCommandConfig(config), { commandTimeoutMs: 120000, commandExitGraceMs: 15000 })
  assert.equal(policy.frozenBounds.runTopups, MAX_RUN_TOPUPS)
  assert.equal(policy.frozenBounds.controlRequestsPerGrant, CONTROL_REQUESTS_PER_GRANT)
  assert.equal(policy.frozenBounds.controlRequestsPerTurn, CONTROL_REQUESTS_PER_TURN)
  assert.equal(policy.frozenBounds.closedRunHandoffRequests, CLOSED_RUN_HANDOFF_REQUESTS)
  assert.deepEqual(resolveHostAdmissionConfig(config), { hostAdmissionEnabled: true, hostMaxActiveRoots: 2, hostMaxRoleExecutions: 4 })
  assert.equal(resolveHostAdmissionConfig().hostAdmissionEnabled, false)
  assert.equal(policy.hostConcurrency.enforced, true, 'enforcement describes the candidate when explicitly configured, not the serving Host')
  assert.equal(policy.hostConcurrency.maxActiveRoots, config.hostMaxActiveRoots)
  assert.equal(policy.hostConcurrency.maxRoleExecutions, config.hostMaxRoleExecutions)
  assert.ok(policy.activationRequires.length > 0)
  assert.equal(Object.hasOwn(config, 'dataDirectory'), false, 'candidate cannot select a real data directory')
})
