/** Host activation guard for an explicitly prepared distribution Profile. */
import { realpath } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { verifyProfile, requireStartupRuntime, PRESET } from './lib/workflow-profile-config.mjs'
import { acceptTransitionData } from './lib/workflow-profile-transition.mjs'
import { DECLARATIVE_DSH, readPresetDefinition, verifyDeclarativeRuntime, createPresetAdmission } from './lib/workflow-declarative-preset.mjs'
export const name = 'workflow-release-guard'
export const inject = ['agentPresets', 'loader']
export async function apply(ctx, config) {
  const { plan, evidence } = await verifyProfile(config?.planPath, { runtimeContext: ctx })
  requireStartupRuntime(ctx, evidence.dsh)
  // Only the declared installed Node CLI is covered, not an arbitrary embedder
  // or packaged executable pretending to be the tested installation.
  const expectedCli = await realpath(join(dirname(plan.hostPackage), 'lib/bin.js'))
  const actualCli = await realpath(resolve(process.argv[1] ?? ''))
  if (expectedCli.toLowerCase() !== actualCli.toLowerCase()) throw new Error('workflow-profile: launcher-changed')
  if (resolve(process.env.DSH_HOME ?? '').toLowerCase() !== plan.home.toLowerCase()) throw new Error('workflow-profile: DSH_HOME-changed')
  const actualBase = await realpath(fileURLToPath(ctx.baseUrl))
  if (actualBase.toLowerCase() !== evidence.profileDirectory.toLowerCase()) throw new Error('workflow-profile: active-profile-changed')
  const patches = evidence.boot.loadOverlayPatches('dsh', plan.overlayPath)
  const mounted = [...ctx.loader.entries()]
  for (const patch of patches) {
    const matches = mounted.filter(entry => entry.options.id === patch.id)
    if (matches.length !== 1) throw new Error('workflow-profile: active-composition-ambiguous')
    for (const [key, value] of Object.entries(patch)) {
      assert.deepEqual(matches[0].options[key], value, 'workflow-profile: active-composition-changed: ' + patch.id)
    }
  }
  if (evidence.dsh !== DECLARATIVE_DSH) {
    const roster = await ctx.agentPresets.list()
    const preset = roster.find(row => row.id === PRESET)
    if (!preset || preset.broken || preset.trust !== 'system'
      || (await realpath(preset.path)).toLowerCase() !== join(plan.packageRoot, 'preset', PRESET, 'agent.cordis.yml').toLowerCase()) {
      throw new Error('workflow-profile: preset-missing-broken-or-shadowed')
    }
  }
  const { acquireWorkflowOwner } = await import(pathToFileURL(join(evidence.packageRoot, 'lib/workflow-runtime.js')).href)
  const owner = await acquireWorkflowOwner(plan.dataDirectory)
  let claimed = false
  try {
    if (plan.schemaVersion === 2) await acceptTransitionData(plan, config.planPath, evidence)
    ctx.effect(() => async () => { if (!claimed) await owner.release() }, 'workflow-release-guard.unclaimed-owner')
    const admission = evidence.dsh === DECLARATIVE_DSH
      ? createPresetAdmission(async () => {
        requireStartupRuntime(ctx, evidence.dsh)
        await verifyDeclarativeRuntime(ctx, evidence, await readPresetDefinition(evidence, PRESET))
      },
        () => { ctx.provide('workflowReleaseVerified', Object.freeze({ version: plan.version })) }) : undefined
    ctx.effect(() => () => admission?.revoke(), 'workflow-release-guard.revoke-admission')
    ctx.provide('workflowReleaseReady', Object.freeze({ ...admission, version: plan.version, claimOwner() {
      if (claimed) throw new Error('workflow-profile: startup-owner-already-claimed')
      claimed = true
      return owner
    } }))
  } catch (error) { if (!claimed) await owner.release(); throw error }
}
