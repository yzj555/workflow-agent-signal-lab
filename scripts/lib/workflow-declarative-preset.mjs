/** 0.2 declaration planning and scoped audit; never waits on the Host Loader. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DECLARATIVE_DSH = '0.2.0-rc.2'
export const PRESET_ADMISSION_PROTOCOL = 1
export const PRESET_ROW = 'workflow-agent-preset-declaration'
export const REGISTRY_MODULE = '@deepseek-ai/dsh-agent-preset-registry'
export const DECLARATION_MODULE = '@deepseek-ai/dsh-agent-preset'
// The engine provides workflowController itself. All other preset providers
// must be injection-ready before its post-controller, subtree-only audit.
export const PRESET_HOST_PROVIDERS = Object.freeze(['tools', 'agents', 'agentPresets', 'systemPrompt', 'commands',
  'userQuestions', 'fs', 'subprocess', 'shell', 'shellEnv', 'sandboxPolicy'])
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, '__jsExpr')
const fail = code => { throw new Error('workflow-profile: ' + code) }

export function requirePresetAdmissionProtocol(release, dsh) {
  if (dsh === DECLARATIVE_DSH && release.presetAdmissionProtocol !== PRESET_ADMISSION_PROTOCOL) fail('release-lacks-preset-admission-protocol')
}

export async function readPresetDefinition(evidence, presetId) {
  const directory = join(evidence.packageRoot, 'preset', presetId)
  const metadata = evidence.yaml.load(await readFile(join(directory, 'preset.yml'), 'utf8'))
  const plugins = evidence.yaml.load(await readFile(join(directory, 'agent.cordis.yml'), 'utf8'), { schema: evidence.include.entryListSchema })
  if (!plain(metadata) || typeof metadata.name !== 'string' || typeof metadata.description !== 'string'
    || !Array.isArray(plugins) || (metadata.order !== undefined && !Number.isFinite(metadata.order))) fail('invalid-packaged-preset')
  return { id: presetId, name: metadata.name, description: metadata.description,
    ...(metadata.order === undefined ? {} : { order: metadata.order }), plugins }
}

export function planDeclarativePreset(rows, { presetId, packageName, definition }) {
  const registry = rows.filter(item => item.row.name === REGISTRY_MODULE)
  if (registry.length !== 1 || registry[0].parentsDisabled || registry[0].row.disabled) fail('ambiguous-or-disabled-preset-roster')
  const config = registry[0].row.config
  if (!plain(config) || config.default === undefined) fail('dynamic-preset-config-needs-manual-review')
  if (config.default === presetId || config.selectedDefault === presetId) fail('workflow-already-default')
  if (!plain(definition) || definition.id !== presetId || !Array.isArray(definition.plugins)) fail('invalid-packaged-preset')
  const declarations = rows.filter(item => item.row.name === DECLARATION_MODULE)
  for (const item of declarations) {
    if (!plain(item.row.config) || typeof item.row.config.id !== 'string') fail('dynamic-declaration-needs-manual-review')
  }
  const matching = declarations.filter(item => item.row.config.id === presetId)
  const own = rows.find(item => item.row.id === PRESET_ROW)
  if (matching.length !== 1 || matching[0] !== own || own.row.name !== DECLARATION_MODULE || own.parentsDisabled) fail('preset-missing-or-shadowed')
  if (own.row.disabled !== true) fail('fresh-activation-requires-inactive-bundle')
  assert.deepEqual(own.row.config, definition, 'workflow-profile: packaged-declaration-changed')
  if (own.row.inject !== undefined) fail('declaration-injection-needs-manual-review')
  if (definition.plugins.some(row => !plain(row) || typeof row.name !== 'string'
    || (!row.name.startsWith(packageName + '/') && !row.name.startsWith('@deepseek-ai/')))) fail('unexpected-preset-module')
  return { id: PRESET_ROW, disabled: false }
}

export function appendDeclarativeBundle(base, definition) {
  if (!Array.isArray(base) || base.some(patch => !Array.isArray(patch.insert))) fail('unexpected-base-bundle-shape')
  if (base.flatMap(patch => patch.insert).some(row => row.disabled !== true || row.id === PRESET_ROW)) fail('bundle-not-inactive-or-declaration-duplicate')
  return [...structuredClone(base), { insert: [{ id: PRESET_ROW, name: DECLARATION_MODULE, disabled: true, config: structuredClone(definition) }] }]
}

/** Called AFTER the engine publishes its controller, with all preset providers
 * ready. The actual declaration fiber and preset subtree are awaited, not the
 * whole Host tree whose engine fiber is still activating. */
export async function verifyDeclarativeRuntime(ctx, evidence, definition) {
  for (const name of [...PRESET_HOST_PROVIDERS, 'workflowController']) if (ctx.get(name) === undefined) fail('preset-provider-not-ready: ' + name)
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.id === PRESET_ROW)
  if (entries.length !== 1 || entries[0].disabled || entries[0].options.name !== DECLARATION_MODULE || !entries[0].fiber) fail('active-declaration-missing-or-shadowed')
  assert.deepEqual(entries[0].options.config, definition, 'workflow-profile: active-declaration-changed')
  await entries[0].fiber.await()
  const document = await ctx.agentPresets.readDocument(definition.id)
  assert.equal(document.agentPreset, definition.id)
  assert.equal(document.name, definition.name); assert.equal(document.description, definition.description)
  assert.deepEqual(evidence.yaml.load(document.content, { schema: evidence.include.entryListSchema }), definition.plugins,
    'workflow-profile: registered-declaration-changed')
  const native = await import(pathToFileURL(evidence.requireHost.resolve(REGISTRY_MODULE)).href)
  const mounts = native.livePresetMounts(ctx.root.fiber).filter(mount => mount.presetId === definition.id)
  if (mounts.length !== 1) fail('active-preset-generation-ambiguous')
  const audit = await native.auditRows(mounts[0].tree)
  if (audit.failed.length || audit.pending.length || native.leakedServices(ctx, mounts[0].fiber).length) fail('preset-missing-broken-or-leaking')
  // The fixed Workflow preset has flat, explicitly named rows. Refuse an
  // unreviewed shape/condition, and inspect the public EntryTree rather than
  // importing the registry's private composition helper implementation.
  const declared = definition.plugins.map(row => {
    if (!plain(row) || row.group || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') fail('preset-shape-needs-review')
    let disabled = row.disabled ?? false
    if (row.disabled?.__jsExpr !== undefined) {
      if (row.disabled.__jsExpr !== "process.platform !== 'win32'") fail('preset-condition-needs-review')
      disabled = process.platform !== 'win32'
    }
    if (typeof disabled !== 'boolean') fail('preset-condition-needs-review')
    return { entryId: row.id, moduleName: row.name, enabled: !disabled }
  })
  const owner = mounts[0].tree.ctx.fiber.entry
  const prefix = owner === undefined ? '' : owner.id + ':'
  const actual = [...mounts[0].tree.entries()].map(entry => ({ entryId: entry.id.slice(prefix.length),
    moduleName: entry.options.name, enabled: !entry.disabled, fiberState: entry.fiber?.state }))
  const identities = list => list.map(({ entryId, moduleName, enabled }) => ({ entryId, moduleName, enabled }))
  assert.deepEqual(identities(actual), declared, 'workflow-profile: effective-preset-composition-changed')
  // FiberState is a TypeScript const enum (no JS export). The fixed Cordis
  // 4.0.4 and official app-boot both define ACTIVE as 2; peer version and module
  // identity are checked by verifyProfile before this callback is admitted.
  const FIBER_ACTIVE = 2
  if (actual.some(row => row.enabled && row.fiberState !== FIBER_ACTIVE)) fail('preset-row-not-active')
}

/** Closed until the scoped audit finishes; failed/re-entrant audits never
 * publish an admission. This is not task approval, only release readiness. */
export function createPresetAdmission(verify, onVerified = () => {}) {
  let state = 'pending'
  return Object.freeze({
    assertReady() { if (state !== 'verified') fail('release-preset-not-verified') },
    revoke() { state = 'revoked' },
    async verifyRuntime() {
      if (state !== 'pending') fail('release-audit-already-started')
      state = 'checking'
      try {
        await verify()
        if (state !== 'checking') fail('release-audit-revoked')
        onVerified(); state = 'verified'
      } catch (error) { state = 'failed'; throw error }
    },
  })
}
