/** Explicit, read-only Profile planning. Only a new output directory is written. */
import assert from 'node:assert/strict'
import { readFile, realpath, lstat, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest, inside, newDirectory, saveJson } from './release-files.mjs'
import { DECLARATIVE_DSH, PRESET_ROW, PRESET_HOST_PROVIDERS, readPresetDefinition, planDeclarativePreset, requirePresetAdmissionProtocol } from './workflow-declarative-preset.mjs'

export const PACKAGE = '@local/workflow-agent-signal-lab'
export const PRESET = 'workflow-agent-signal-lab'
export const ROWS = Object.freeze({ ui: 'workflow-agent-signal-lab-ui', engine: 'workflow-agent-runtime', guard: 'workflow-release-guard', preset: PRESET_ROW })
const LEGACY_DSH = '0.1.5-rc.1'
const BROWSER_PEERS = new Set(['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots'])
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, '__jsExpr')
const fail = code => { throw new Error('workflow-profile: ' + code) }

export function requireStartupProfile(composition, dsh = LEGACY_DSH, entries = []) {
  if (dsh === DECLARATIVE_DSH) {
    // SDK2 removed manifest.patchReload. An inert legacy field must never
    // masquerade as a disabled live-reload service.
    const hmr = flattenRows(entries).filter(({ row }) => row.name === '@deepseek-ai/dsh-hmr' || row.name?.startsWith('@deepseek-ai/dsh-hmr/'))
    if (!hmr.length || hmr.some(({ row }) => row.disabled !== true)) {
      fail('startup-profile-required; for DSH 0.2, while offline explicitly disable every dsh-hmr row in the existing Profile/overlay; the generator does not change this policy')
    }
    return
  }
  if (dsh !== LEGACY_DSH) fail('unsupported-host')
  if (composition.patchReload !== 'startup') fail('startup-profile-required; while offline, explicitly set dsh.profile.patchReload to startup, preserving all other manifest fields')
}

export function requireStartupRuntime(ctx, dsh) {
  if (dsh === DECLARATIVE_DSH && ctx.get('hmr') !== undefined) fail('live-reload-service-active')
}

export function bundleLayerPaths(layer, dsh) {
  const files = dsh === DECLARATIVE_DSH ? layer.patchPaths : [layer.patchPath]
  if (!Array.isArray(files) || !files.length || files.length > 32 || files.some(file => typeof file !== 'string' || !isAbsolute(file))) {
    fail('invalid-bundle-patch-paths')
  }
  return files
}

export async function strictPath(file, kind, { absent = false } = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) fail('absolute-path-required')
  const path = resolve(file)
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !samePath(await realpath(path), path)) fail('path-link')
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) fail('path-kind')
  } catch (error) {
    if (!absent || error.code !== 'ENOENT') throw error
    // The immediate parent must already exist and itself have no linked ancestor.
    await strictPath(dirname(path), 'directory')
  }
  return path
}

export function flattenRows(entries) {
  const rows = []
  const walk = (list, parentsDisabled = false) => {
    for (const row of list) {
      rows.push({ row, parentsDisabled })
      if (row.group && Array.isArray(row.config)) walk(row.config, parentsDisabled || (row.disabled !== undefined && row.disabled !== false))
    }
  }
  walk(entries)
  const ids = rows.map(value => value.row.id).filter(Boolean)
  if (new Set(ids).size !== ids.length) fail('duplicate-row-id')
  return rows
}

/** Preserve every unrelated row and the full preset config, including unevaluated !!js fields. */
export function planPatches(entries, { presetRoot, dataDirectory, engineConfig, planPath, dsh = LEGACY_DSH, definition }) {
  if (![LEGACY_DSH, DECLARATIVE_DSH].includes(dsh)) fail('unsupported-host')
  const rows = flattenRows(entries)
  const exact = (id, name) => {
    const found = rows.find(value => value.row.id === id)
    if (!found || found.row.name !== name || found.parentsDisabled) fail('missing-or-shadowed-row: ' + id)
    return found.row
  }
  let presetPatch
  if (dsh === DECLARATIVE_DSH) presetPatch = planDeclarativePreset(rows, { presetId: PRESET, packageName: PACKAGE, definition })
  else {
    const roster = rows.filter(value => value.row.name === '@deepseek-ai/dsh-agent-presets')
    if (roster.length !== 1 || roster[0].parentsDisabled || roster[0].row.disabled) fail('ambiguous-or-disabled-preset-roster')
    const presetRow = roster[0].row
    if (!presetRow.id || !plain(presetRow.config) || presetRow.config.default === undefined) fail('dynamic-preset-config-needs-manual-review')
    if (presetRow.config.default === PRESET) fail('workflow-already-default')
    const roots = presetRow.config.roots ?? []
    if (!Array.isArray(roots) || roots.some(root => !plain(root) || typeof root.path !== 'string')) fail('dynamic-preset-roots-needs-manual-review')
    if (roots.some(root => samePath(root.path, presetRoot))) fail('preset-root-already-configured')
    presetPatch = { id: presetRow.id, config: { ...structuredClone(presetRow.config), roots: [...structuredClone(roots), { path: presetRoot, trust: 'system' }] } }
  }
  const ui = exact(ROWS.ui, PACKAGE)
  const engine = exact(ROWS.engine, PACKAGE + '/workflow-engine')
  const guard = exact(ROWS.guard, PACKAGE + '/profile-guard')
  if ([ui, engine, guard].some(row => row.disabled !== true)) fail('fresh-activation-requires-inactive-bundle')
  if (engine.config !== undefined || guard.config !== undefined) fail('existing-workflow-config-needs-upgrade-review')
  const injectReady = (row, service = 'workflowReleaseReady', providers = []) => {
    if (row.inject !== undefined && !Array.isArray(row.inject)) fail('dynamic-injection-needs-manual-review')
    return [...new Set([...(row.inject ?? []), service, ...providers])]
  }
  return [
    presetPatch,
    { id: ROWS.guard, disabled: false, config: { planPath } },
    { id: ROWS.ui, disabled: false, inject: injectReady(ui, dsh === DECLARATIVE_DSH ? 'workflowReleaseVerified' : 'workflowReleaseReady') },
    { id: ROWS.engine, disabled: false, inject: injectReady(engine, 'workflowReleaseReady', dsh === DECLARATIVE_DSH ? PRESET_HOST_PROVIDERS : []), config: { ...engineConfig, dataDirectory } },
  ]
}

async function hostTools(hostPackage) {
  const manifest = await json(hostPackage)
  if (manifest.name !== '@deepseek-ai/dsh' || ![LEGACY_DSH, DECLARATIVE_DSH].includes(manifest.version)) fail('unsupported-host')
  const requireHost = createRequire(hostPackage)
  const bootPath = requireHost.resolve('@deepseek-ai/dsh-app-boot')
  const requireBoot = createRequire(bootPath)
  const boot = await import(pathToFileURL(bootPath).href)
  const include = await import(pathToFileURL(requireBoot.resolve('@deepseek-ai/cordis-plugin-include')).href)
  const yaml = await import(pathToFileURL(requireBoot.resolve('js-yaml')).href)
  return { boot, include, yaml, requireHost, dsh: manifest.version }
}

async function hashFile(file, optional = false) {
  try { return digest(await readFile(await strictPath(file, 'file'))) }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error }
}

async function packageEvidence(profileDirectory, dsh) {
  const requireProfile = createRequire(join(profileDirectory, 'package.json'))
  const packageRoot = dirname(await realpath(requireProfile.resolve(PACKAGE + '/package.json')))
  // A real package-store directory is normal. A development link outside this
  // Profile is not a distributable installation, even when versions match.
  if (!inside(join(profileDirectory, 'node_modules'), packageRoot)) fail('development-package-not-supported')
  const release = await json(join(packageRoot, 'release-manifest.json'))
  const metadata = await json(join(packageRoot, 'package.json'))
  if (release.schemaVersion !== 1 || release.buildMode !== 'production' || release.dsh !== dsh
    || release.version !== metadata.version || !plain(release.files)) fail('invalid-release-manifest')
  requirePresetAdmissionProtocol(release, dsh)
  for (const [file, sha] of Object.entries(release.files)) {
    if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || !inside(packageRoot, join(packageRoot, file))) fail('invalid-payload-path')
    if (await hashFile(join(packageRoot, file)) !== sha) fail('installed-payload-changed: ' + file)
  }
  return { packageRoot, release, metadata, requireProfile }
}

export async function inspectProfile(options) {
  const { hostPackage, home, profile, patches = [] } = options
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(profile) || profile === 'node_modules') fail('invalid-profile')
  await strictPath(hostPackage, 'file'); await strictPath(home, 'directory')
  const profileDirectory = await strictPath(join(home, 'profiles', profile), 'directory')
  const inputs = {}
  const track = async (file, optional = false) => { inputs[resolve(file)] = await hashFile(file, optional) }
  const tools = await hostTools(hostPackage)
  const { boot } = tools
  // Unlike loadProfile(), this does not initialize or normalize a manifest.
  const composition = boot.loadProfileDirectory('dsh', profileDirectory, hostPackage)
  // Live recomposition could retain an already-satisfied guard fiber while
  // applying a newer home/profile layer underneath our frozen final overlay.
  // This distribution flow therefore requires the official startup lifecycle.
  await track(hostPackage); await track(join(profileDirectory, 'package.json'))
  await track(join(profileDirectory, 'pnpm-lock.yaml'), true)
  await track(join(profileDirectory, 'pnpm-workspace.yaml'), true)
  // Official bundle resolution intentionally returns paths through pnpm's
  // package-store links. Freeze their actual targets; do not mistake these
  // installation links for unsafe writable data/configuration destinations.
  for (const layer of composition.layers) {
    await track(await realpath(join(layer.packageDir, 'package.json')))
    for (const patchPath of bundleLayerPaths(layer, tools.dsh)) await track(await realpath(patchPath))
  }
  await track(composition.patchPath, true)
  const homePatch = join(home, 'cordis.patch.yml')
  await track(homePatch, true)
  const extra = []
  for (const patch of patches) { await track(patch); extra.push(boot.loadOverlayPatches('dsh', patch)) }
  const layers = [...composition.layers.map(layer => layer.patches), composition.patches, boot.loadOptionalPatches('dsh', homePatch) ?? [], ...extra]
  const warnings = []
  const entries = boot.composeEntries(layers, value => warnings.push(value))
  if (warnings.length) fail('configuration-has-unmatched-patches')
  requireStartupProfile(composition, tools.dsh, entries)
  const installed = await packageEvidence(profileDirectory, tools.dsh)
  await track(join(installed.packageRoot, 'release-manifest.json'))
  return { ...tools, ...installed, hostPackage, composition, profileDirectory, inputs, entries, layers }
}

export async function verifyHostPeers(evidence, { runtimeContext } = {}) {
  if (evidence.dsh === DECLARATIVE_DSH && runtimeContext === undefined) {
    return withProfileResolution(evidence, () => verifyResolvedPeers(evidence))
  }
  if (runtimeContext !== undefined && evidence.dsh === DECLARATIVE_DSH && runtimeContext.get('pluginPackages') === undefined) fail('host-runtime-resolution-missing')
  return verifyResolvedPeers(evidence)
}

/** Offline helpers own official routing until all installed imports/owners
 * have closed. No legacy link projection or persistent resolver replacement. */
export async function withProfileResolution(evidence, operation) {
  if (evidence.dsh !== DECLARATIVE_DSH) return operation(undefined)
  const resolution = await evidence.boot.createRuntimeResolution({ installAnchor: evidence.hostPackage, profile: evidence.composition })
  const { Context } = await import(pathToFileURL(evidence.requireHost.resolve('@deepseek-ai/cordis')).href)
  const ctx = new Context()
  try {
    new evidence.boot.PluginPackages(ctx, { resolution })
    return await operation(ctx)
  } finally { await ctx.fiber.dispose() }
}

async function verifyResolvedPeers(evidence) {
  const { metadata, packageRoot, requireHost } = evidence
  const requirePlugin = createRequire(join(packageRoot, 'package.json'))
  const peers = {}
  for (const [name, expectedVersion] of Object.entries(metadata.peerDependencies)) {
    if (BROWSER_PEERS.has(name)) continue
    const hostEntry = await realpath(requireHost.resolve(name))
    const pluginEntry = await realpath(requirePlugin.resolve(name))
    if (!samePath(hostEntry, pluginEntry)) fail('split-host-module: ' + name)
    let at = dirname(hostEntry)
    for (;;) {
      try {
        const pkg = await json(join(at, 'package.json'))
        if (pkg.name === name) {
          if (pkg.version !== expectedVersion) fail('host-peer-version: ' + name)
          peers[name] = { version: pkg.version, entry: hostEntry }
          break
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (dirname(at) === at) fail('host-peer-manifest: ' + name)
      at = dirname(at)
    }
  }
  return peers
}

export async function prepareProfile(options) {
  const { output, dataDirectory } = options
  if (options.policy !== 'packaged-candidate') fail('explicit-resource-policy-required')
  const evidence = await inspectProfile(options)
  await strictPath(dataDirectory, 'directory', { absent: true })
  for (const protectedPath of [dirname(options.hostPackage), evidence.profileDirectory, evidence.packageRoot]) {
    if (inside(protectedPath, dataDirectory) || inside(dataDirectory, protectedPath)) fail('data-overlaps-installation')
  }
  if (inside(dataDirectory, options.home) || inside(dataDirectory, output) || inside(output, dataDirectory)) fail('data-overlaps-configuration')
  try { if ((await readdir(dataDirectory)).length) fail('existing-data-needs-upgrade-review') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return writeActivationPlan(options, evidence)
}

/** Shared serializer. Existing-data callers must first hold the owner and prove compatibility. */
export async function writeActivationPlan(options, evidence, transition) {
  const { output, dataDirectory } = options
  const policy = await json(join(evidence.packageRoot, 'resource-policy.json'))
  if (policy.schemaVersion !== 1 || policy.dsh !== evidence.dsh || !plain(policy.engineConfig)) fail('invalid-resource-policy')
  const presetRoot = join(evidence.packageRoot, 'preset')
  const planPath = join(resolve(output), 'activation-plan.json')
  const definition = evidence.dsh === DECLARATIVE_DSH ? await readPresetDefinition(evidence, PRESET) : undefined
  const overlay = planPatches(evidence.entries, { presetRoot, dataDirectory: resolve(dataDirectory), engineConfig: policy.engineConfig, planPath, dsh: evidence.dsh, definition })
  // Compose with the official algorithm. A global-id collision or unmatched
  // row is a refusal, not an apparently successful no-op.
  const warnings = []
  const composed = evidence.boot.composeEntries([...evidence.layers, overlay], value => warnings.push(value))
  if (warnings.length) fail('generated-patch-not-applied')
  const after = flattenRows(composed)
  for (const { row } of flattenRows(evidence.entries)) {
    if ([ROWS.ui, ROWS.engine, ROWS.guard, overlay[0].id].includes(row.id) || row.group) continue
    assert.deepEqual(after.find(value => value.row.id === row.id)?.row, row, 'Unrelated configuration must not change')
  }
  // Configuration parsing must not execute !!js. The official serializer keeps
  // those nodes intact instead of converting them into literal JSON objects.
  const text = evidence.yaml.dump(overlay, { schema: evidence.include.entryListSchema, noRefs: true, lineWidth: 110 })
  await newDirectory(output)
  const overlayPath = join(resolve(output), 'workflow-enable.patch.yml')
  await writeFile(overlayPath, text, { flag: 'wx' })
  const plan = { schemaVersion: transition ? 2 : 1, kind: 'workflow-profile-activation', status: 'prepared-not-activated',
    hostPackage: resolve(options.hostPackage), home: resolve(options.home), profile: options.profile,
    patches: (options.patches ?? []).map(resolvePath => resolve(resolvePath)), dataDirectory: resolve(dataDirectory),
    packageRoot: evidence.packageRoot, version: evidence.metadata.version, dsh: evidence.dsh, inputs: evidence.inputs,
    overlayPath, overlaySha256: digest(text), policy: options.policy, engineConfig: policy.engineConfig,
    startupProtocol: evidence.dsh === DECLARATIVE_DSH ? 'identity-and-owner-then-scoped-preset-admission' : 'legacy-preset-preflight',
    generatedAt: new Date().toISOString(), changesExistingFiles: false,
    startupRequires: ['same profile, Host and patch inputs', 'official shared module identity', 'same installed payload', 'healthy registered preset'],
    notProven: ['user authorization to launch', 'Host idle', 'browser rendering', 'real model', 'upgrade compatibility'],
    ...(transition ? { transition } : {}) }
  await saveJson(planPath, plan)
  return { planPath, overlayPath, status: plan.status, version: plan.version }
}

/** Read-only preflight, also called by the guard at each actual Host activation. */
export async function verifyProfile(planPath, { requirePeers = true, runtimeContext } = {}) {
  const plan = await json(await strictPath(planPath, 'file'))
  if (![1, 2].includes(plan.schemaVersion) || plan.kind !== 'workflow-profile-activation'
    || (plan.schemaVersion === 2 && !plain(plan.transition))) fail('invalid-plan')
  const evidence = await inspectProfile(plan)
  if ((plan.dsh ?? LEGACY_DSH) !== evidence.dsh) fail('plan-host-version-changed')
  if (plan.schemaVersion === 2 && evidence.release.transitionProtocol !== 1) fail('transition-guard-not-supported')
  assert.deepEqual(evidence.inputs, plan.inputs, 'Profile or installation changed; prepare a new activation plan')
  if (!samePath(evidence.packageRoot, plan.packageRoot) || evidence.metadata.version !== plan.version) fail('installed-version-changed')
  if (await hashFile(plan.overlayPath) !== plan.overlaySha256) fail('activation-overlay-changed')
  const expected = planPatches(evidence.entries, { presetRoot: join(evidence.packageRoot, 'preset'), dataDirectory: plan.dataDirectory,
    engineConfig: (await json(join(evidence.packageRoot, 'resource-policy.json'))).engineConfig, planPath: resolve(planPath), dsh: evidence.dsh,
    definition: evidence.dsh === DECLARATIVE_DSH ? await readPresetDefinition(evidence, PRESET) : undefined })
  const actual = evidence.boot.loadOverlayPatches('dsh', plan.overlayPath)
  assert.deepEqual(actual, expected, 'Activation overlay no longer matches its source configuration')
  await strictPath(plan.dataDirectory, 'directory', { absent: true })
  const peers = requirePeers ? await verifyHostPeers(evidence, { runtimeContext }) : undefined
  return { plan, evidence, peers }
}
