/** Offline maintenance: capture, prove, generate. Never install, stop, start or restore data. */
import assert from 'node:assert/strict'
import { readFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectProfile, verifyProfile, verifyHostPeers, withProfileResolution, writeActivationPlan, strictPath, PACKAGE, ROWS } from './workflow-profile-config.mjs'
import { dataFiles, copyData, replayData, semanticDigest } from './workflow-transition-data.mjs'
import { digest, inside, newDirectory, saveJson, regularFiles } from './release-files.mjs'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const fail = code => { throw new Error('workflow-transition: ' + code) }

export function transitionDirection(from, to, mode) {
  const number = version => {
    const match = /^1\.0\.0-rc\.([1-9][0-9]*)$/u.exec(version)
    if (!match) fail('unsupported-version-family')
    return Number(match[1])
  }
  const difference = number(to) - number(from)
  if (!(mode === 'upgrade' && difference > 0 || mode === 'rollback' && difference < 0 || mode === 'reconfigure' && difference === 0)) fail('mode-version-mismatch')
}

export function comparableManifest(manifest) {
  const value = structuredClone(manifest)
  if (value.dependencies) delete value.dependencies[PACKAGE]
  return value
}

export function assertTransitionOutput(output, ...checkpoints) {
  for (const file of checkpoints.filter(Boolean)) {
    const archive = dirname(resolve(file))
    if (inside(archive, output) || inside(output, archive)) fail('output-overlaps-checkpoint')
  }
}

async function configIdentity(evidence) {
  // The generated enable overlay is deliberately NOT an input to inspectProfile.
  // Every other plugin and every custom preset field must retain its value.
  const remove = entries => entries.filter(row => !Object.values(ROWS).includes(row.id)).map(row =>
    row.group && Array.isArray(row.config) ? { ...row, config: remove(row.config) } : row)
  return { entries: semanticDigest(remove(evidence.entries)),
    profile: semanticDigest(comparableManifest(await json(join(evidence.profileDirectory, 'package.json')))) }
}

function outputSafe(output, plan, evidence) {
  for (const protectedPath of [plan.dataDirectory, evidence.profileDirectory, evidence.packageRoot, dirname(plan.hostPackage)]) {
    if (inside(protectedPath, output) || inside(output, protectedPath)) fail('output-overlaps-protected-input')
  }
}

export async function maintenanceOwner(packageRoot, directory) {
  await strictPath(directory, 'directory')
  const { acquireWorkflowOwner } = await import(pathToFileURL(join(packageRoot, 'lib/workflow-runtime.js')).href)
  // Same atomic protocol as the actual runtime. Existing, stale, malformed or
  // foreign owners all refuse. No PID inference or automatic marker reclamation.
  return acquireWorkflowOwner(directory)
}

export async function captureTransition({ planPath, output }) {
  const { plan, evidence } = await verifyProfile(planPath)
  outputSafe(output, plan, evidence)
  return withProfileResolution(evidence, runtimeContext => captureVerifiedTransition(planPath, output, plan, evidence, runtimeContext))
}

async function captureVerifiedTransition(planPath, output, plan, evidence, runtimeContext) {
  const owner = await maintenanceOwner(evidence.packageRoot, plan.dataDirectory)
  try {
    const before = await dataFiles(plan.dataDirectory)
    if (!before['journal.sqlite']) fail('journal-required')
    const replay = await replayData(plan.dataDirectory, evidence.packageRoot)
    await newDirectory(output)
    await copyData(plan.dataDirectory, join(output, 'data'), before)
    // Preserve exactly the verified old payload, not a mutable development tree.
    const packageFiles = { ...evidence.release.files,
      'release-manifest.json': digest(await readFile(join(evidence.packageRoot, 'release-manifest.json'))) }
    for (const file of Object.keys(packageFiles)) {
      await mkdir(dirname(join(output, 'previous-package', file)), { recursive: true })
      await copyFile(join(evidence.packageRoot, file), join(output, 'previous-package', file), 1)
    }
    assert.deepEqual(await regularFiles(join(output, 'previous-package')), packageFiles)
    await saveJson(join(output, 'previous-plan.json'), plan)
    const checkpoint = { schemaVersion: 1, kind: 'workflow-transition-checkpoint', createdAt: new Date().toISOString(),
      sourcePlanPath: resolve(planPath), sourcePlanSha256: digest(await readFile(planPath)), plan,
      packageFiles, packageVersion: evidence.metadata.version, configIdentity: await configIdentity(evidence),
      resourcePolicy: semanticDigest(plan.engineConfig), dataFiles: before, replay,
      guarantees: { sourceDataWritten: false, currentWriterExcluded: true, noMigration: true },
      notProven: ['Host-wide idle', 'native history compatibility', 'installation or rollback performed', 'permission to start'] }
    assert.deepEqual(await dataFiles(plan.dataDirectory), before, 'transition-source-changed')
    await verifyProfile(planPath, { runtimeContext })
    await saveJson(join(output, 'checkpoint.json'), checkpoint)
    return { status: 'captured-not-upgraded', checkpointPath: join(resolve(output), 'checkpoint.json'), rows: replay.rows.length,
      runs: replay.rows.reduce((sum, row) => sum + row.runCount, 0) }
  } finally { await owner.release() }
}

export async function readCheckpoint(file) {
  file = await strictPath(file, 'file')
  const checkpoint = await json(file), directory = dirname(file)
  if (checkpoint.schemaVersion !== 1 || checkpoint.kind !== 'workflow-transition-checkpoint') fail('invalid-checkpoint')
  assert.deepEqual(await dataFiles(join(directory, 'data')), checkpoint.dataFiles, 'transition-backup-changed')
  assert.deepEqual(await regularFiles(join(directory, 'previous-package')), checkpoint.packageFiles, 'transition-archived-package-changed')
  assert.deepEqual(await json(join(directory, 'previous-plan.json')), checkpoint.plan, 'transition-archived-plan-changed')
  if (checkpoint.packageVersion !== checkpoint.plan.version) fail('checkpoint-version-binding')
  return checkpoint
}

export async function prepareTransition({ checkpointPath, output, mode, acceptConfigChange = false, rollbackCheckpoint }) {
  assertTransitionOutput(output, checkpointPath, rollbackCheckpoint)
  const checkpoint = await readCheckpoint(checkpointPath)
  const prior = checkpoint.plan
  const evidence = await inspectProfile(prior)
  outputSafe(output, prior, evidence)
  transitionDirection(prior.version, evidence.metadata.version, mode)
  // RC.2 can be a source, but cannot enforce the v2 transition plan and lock
  // handoff. Do not pretend it is a safe automated rollback destination.
  if (evidence.release.transitionProtocol !== 1) fail('target-lacks-transition-guard')
  if (acceptConfigChange && mode !== 'reconfigure') fail('config-review-only-for-reconfigure')
  const identity = await configIdentity(evidence)
  if (!acceptConfigChange) assert.deepEqual(identity, checkpoint.configIdentity, 'configuration-changed; review reconfigure separately')
  const policy = await json(join(evidence.packageRoot, 'resource-policy.json'))
  assert.equal(semanticDigest(policy.engineConfig), checkpoint.resourcePolicy, 'resource-policy-changed; separate explicit policy review required')
  if (mode === 'rollback') {
    if (!rollbackCheckpoint) fail('rollback-target-checkpoint-required')
    const target = await readCheckpoint(rollbackCheckpoint)
    assert.equal(target.packageVersion, evidence.metadata.version, 'rollback-version-not-archived-target')
    assert.deepEqual(target.packageFiles, { ...evidence.release.files,
      'release-manifest.json': digest(await readFile(join(evidence.packageRoot, 'release-manifest.json'))) }, 'rollback-payload-not-archived-target')
    if (!same(target.plan.home, prior.home) || target.plan.profile !== prior.profile || !same(target.plan.dataDirectory, prior.dataDirectory)) fail('rollback-profile-binding')
  }
  return withProfileResolution(evidence, async runtimeContext => {
  await verifyHostPeers(evidence, { runtimeContext })
  const owner = await maintenanceOwner(evidence.packageRoot, prior.dataDirectory)
  try {
    assert.deepEqual(await dataFiles(prior.dataDirectory), checkpoint.dataFiles, 'current-data-changed; capture CURRENT data again, never restore the old backup')
    const replay = await replayData(prior.dataDirectory, evidence.packageRoot)
    assert.deepEqual(replay, checkpoint.replay, 'target-data-semantics-differ')
    const transition = { protocol: 1, mode, fromVersion: prior.version, toVersion: evidence.metadata.version,
      checkpointPath: resolve(checkpointPath), checkpointSha256: digest(await readFile(checkpointPath)),
      expectedData: checkpoint.dataFiles, expectedReplay: checkpoint.replay,
      configChangeReviewed: acceptConfigChange, changedConfig: identity.entries !== checkpoint.configIdentity.entries || identity.profile !== checkpoint.configIdentity.profile,
      receiptPath: join(resolve(output), 'transition-accepted.json'), noDataRollback: true }
    const result = await writeActivationPlan({ ...prior, output, policy: 'packaged-candidate' }, evidence, transition)
    assert.deepEqual(await dataFiles(prior.dataDirectory), checkpoint.dataFiles, 'transition-source-changed')
    return { ...result, mode, fromVersion: prior.version, toVersion: evidence.metadata.version, existingDataPreserved: true,
      rows: replay.rows.length, activated: false }
  } finally { await owner.release() }
  })
}

/** Called while the startup guard owns the writer; the same owner is handed to storage. */
export async function acceptTransitionData(plan, planPath, evidence) {
  const transition = plan.transition
  if (transition?.protocol !== 1 || transition.noDataRollback !== true || transition.toVersion !== evidence.metadata.version
    || !same(transition.receiptPath, join(dirname(planPath), 'transition-accepted.json'))) fail('invalid-transition-plan')
  const planSha256 = digest(await readFile(planPath))
  const files = await dataFiles(plan.dataDirectory)
  // Always re-read actual current data on an owned copy. The receipt is NOT a
  // promise that every future data image is readable by this pinned runtime.
  const replay = await replayData(plan.dataDirectory, evidence.packageRoot)
  let receipt
  try { receipt = await json(await strictPath(transition.receiptPath, 'file')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (receipt) {
    if (receipt.schemaVersion !== 1 || receipt.planSha256 !== planSha256 || receipt.version !== evidence.metadata.version) fail('transition-receipt-mismatch')
    return { firstActivation: false, rows: replay.rows.length }
  }
  assert.equal(digest(await readFile(await strictPath(transition.checkpointPath, 'file'))), transition.checkpointSha256, 'transition-checkpoint-changed')
  await readCheckpoint(transition.checkpointPath)
  assert.deepEqual(files, transition.expectedData, 'transition-data-changed-before-first-start')
  assert.deepEqual(replay, transition.expectedReplay, 'transition-semantics-changed-before-first-start')
  await saveJson(transition.receiptPath, { schemaVersion: 1, planSha256, version: evidence.metadata.version,
    checkedAt: new Date().toISOString(), state: 'compatibility-accepted-not-task-authorized', initialDataDigest: semanticDigest(files) })
  return { firstActivation: true, rows: replay.rows.length }
}
