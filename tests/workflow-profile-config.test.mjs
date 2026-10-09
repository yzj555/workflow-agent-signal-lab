import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import * as boot from '@deepseek-ai/dsh-app-boot'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { planPatches, flattenRows, strictPath, requireStartupProfile, requireStartupRuntime, bundleLayerPaths, withProfileResolution, PACKAGE, PRESET, ROWS } from '../scripts/lib/workflow-profile-config.mjs'
const requireBoot = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-app-boot'))
const yaml = requireBoot('js-yaml')
const options = { presetRoot: 'C:/fixture/package/preset', dataDirectory: 'C:/fixture/data', planPath: 'C:/fixture/plan.json',
  engineConfig: { runBudgetEnabled: true, runBudgetScope: 'all', runCommands: 40, hostAdmissionEnabled: true } }
const input = () => [
  { id: 'another-plugin', name: 'unrelated', config: { token: 'synthetic-keep-private' } },
  { id: 'custom-preset-row', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'my-preset', roots: [{ path: 'C:/existing', trust: 'user' }], includeUserRoot: false, includeShippedRoot: false, futureField: 'keep-me' } },
  { id: ROWS.guard, name: PACKAGE + '/profile-guard', disabled: true },
  { id: ROWS.ui, name: PACKAGE, disabled: true, inject: ['existing-service'] },
  { id: ROWS.engine, name: PACKAGE + '/workflow-engine', disabled: true },
]
const compose = (rows, patches) => composeEntries([[{ insert: rows }], patches], warning => assert.fail(warning))

test('profile: a frozen activation plan refuses default live reload rather than hiding newer changes', () => {
  requireStartupProfile({ patchReload: 'startup' })
  for (const patchReload of [undefined, 'live', { __jsExpr: '"startup"' }]) {
    assert.throws(() => requireStartupProfile({ patchReload }), /startup-profile-required/u)
  }
})

test('profile: SDK2 requires explicitly disabled actual HMR, not an ignored legacy manifest field', () => {
  const dsh = '0.2.0-rc.2', row = { id: 'hmr', name: '@deepseek-ai/dsh-hmr', disabled: true }
  requireStartupProfile({}, dsh, [row])
  for (const disabled of [undefined, false, { __jsExpr: 'true' }]) {
    assert.throws(() => requireStartupProfile({ patchReload: 'startup' }, dsh, [{ ...row, disabled }]), /startup-profile-required/u)
  }
  assert.throws(() => requireStartupProfile({ patchReload: 'startup' }, dsh, []), /startup-profile-required/u)
})

test('profile: SDK2 refuses a second live or nested HMR and does not modify configuration', () => {
  const entries = [{ id: 'hmr', name: '@deepseek-ai/dsh-hmr', disabled: true, config: { root: ['keep'] } },
    { id: 'nested', group: true, config: [{ id: 'second', name: '@deepseek-ai/dsh-hmr' }] }]
  const before = structuredClone(entries)
  assert.throws(() => requireStartupProfile({}, '0.2.0-rc.2', entries), /startup-profile-required/u)
  assert.deepEqual(entries, before)
  entries[1].config[0].disabled = true
  requireStartupProfile({}, '0.2.0-rc.2', entries)
})

test('profile: actual live-reload service independently refuses SDK2 admission', () => {
  requireStartupRuntime({ get: () => undefined }, '0.2.0-rc.2')
  assert.throws(() => requireStartupRuntime({ get: () => ({}) }, '0.2.0-rc.2'), /live-reload-service-active/u)
})

test('profile: SDK2 freezes all official bundle patchPaths; old SDK retains its singular path', () => {
  const paths = [join(tmpdir(), 'bundle-a.yml'), join(tmpdir(), 'bundle-b.yml')]
  assert.deepEqual(bundleLayerPaths({ patchPaths: paths }, '0.2.0-rc.2'), paths)
  assert.deepEqual(bundleLayerPaths({ patchPath: paths[0] }, '0.1.5-rc.1'), [paths[0]])
  for (const patchPaths of [undefined, [], ['relative.yml'], new Array(33).fill(paths[0])]) {
    assert.throws(() => bundleLayerPaths({ patchPaths }, '0.2.0-rc.2'), /invalid-bundle-patch-paths/u)
  }
})

test('profile: real SDK2 offline routing shares Host Cordis and releases its fiber after success and rejection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workflow-offline-sdk2-resolution-'))
  const directory = join(home, 'profiles', 'isolated'); await mkdir(directory, { recursive: true })
  boot.initProfile(directory, [])
  const hostPackage = await realpath(join(import.meta.dirname, '../node_modules/@deepseek-ai/dsh/package.json'))
  const requireHost = createRequire(hostPackage), requireProfile = createRequire(join(directory, 'offline-probe.mjs'))
  const evidence = { dsh: '0.2.0-rc.2', boot, hostPackage, requireHost, composition: boot.loadProfileDirectory('dsh', directory, hostPackage) }
  assert.throws(() => requireProfile.resolve('@deepseek-ai/cordis'), { code: 'MODULE_NOT_FOUND' })
  const result = await withProfileResolution(evidence, async ctx => {
    assert.ok(ctx.get('pluginPackages'))
    assert.equal(await realpath(requireProfile.resolve('@deepseek-ai/cordis')), await realpath(requireHost.resolve('@deepseek-ai/cordis')))
    return 'verified-and-closed'
  })
  assert.equal(result, 'verified-and-closed')
  assert.throws(() => requireProfile.resolve('@deepseek-ai/cordis'), { code: 'MODULE_NOT_FOUND' })
  await assert.rejects(withProfileResolution(evidence, async () => { throw new Error('synthetic-operation-refused') }), /synthetic-operation-refused/u)
  assert.throws(() => requireProfile.resolve('@deepseek-ai/cordis'), { code: 'MODULE_NOT_FOUND' })
})

test('profile: additive roots preserve default, authoring switches, extra fields and unrelated rows', () => {
  const rows = input(), before = structuredClone(rows)
  const patches = planPatches(rows, options), result = compose(rows, patches)
  assert.deepEqual(rows, before)
  assert.deepEqual(result[0], before[0])
  assert.deepEqual(result[1].config, { ...before[1].config, roots: [...before[1].config.roots, { path: options.presetRoot, trust: 'system' }] })
  assert.deepEqual(result[3].inject, ['existing-service', 'workflowReleaseReady'])
  assert.deepEqual(result[4].config, { ...options.engineConfig, dataDirectory: options.dataDirectory })
  assert.ok(!JSON.stringify(patches).includes('synthetic-keep-private'))
})

test('profile: official YAML keeps nested !!js unevaluated and round-trips its exact meaning', () => {
  const rows = input()
  rows[1].config.default = { __jsExpr: "(() => { throw new Error('must not evaluate'); })()" }
  const patches = planPatches(rows, options)
  const text = yaml.dump(patches, { schema: entryListSchema, noRefs: true })
  assert.match(text, /!!js/u)
  assert.deepEqual(yaml.load(text, { schema: entryListSchema }), patches)
})

test('profile: direct and nested duplicate row identifiers refuse rather than patch the wrong entry', () => {
  const rows = input()
  rows.push({ id: 'group', name: 'group', group: true, config: [structuredClone(rows[1])] })
  assert.throws(() => planPatches(rows, options), /duplicate-row-id/u)
})

test('profile: disabled/conditional ancestors and duplicate roster modules cannot be enabled by guessing', () => {
  for (const disabled of [true, { __jsExpr: 'process.env.NOT_KNOWN' }]) {
    const rows = input()
    const child = rows.splice(1, 1)[0]
    rows.push({ id: 'group', group: true, disabled, name: 'group', config: [child] })
    assert.throws(() => planPatches(rows, options), /disabled-preset-roster/u)
  }
  const rows = input(); rows.push({ ...rows[1], id: 'another-roster' })
  assert.throws(() => planPatches(rows, options), /ambiguous/u)
})

test('profile: dynamic whole config or root arrays require review, never become empty defaults', () => {
  for (const config of [{ __jsExpr: 'ctx.config' }, { default: 'standard', roots: { __jsExpr: 'ctx.roots' } }, { roots: [] }]) {
    const rows = input(); rows[1].config = config
    assert.throws(() => planPatches(rows, options), /manual-review/u)
  }
})

test('profile: existing enabled setup, default selection or engine configuration belongs to an upgrade path', () => {
  const edits = [rows => { rows[4].disabled = false }, rows => { rows[4].config = { dataDirectory: 'C:/old' } },
    rows => { rows[1].config.default = PRESET }, rows => { rows[1].config.roots.push({ path: options.presetRoot.toUpperCase(), trust: 'user' }) }]
  for (const edit of edits) { const rows = input(); edit(rows); assert.throws(() => planPatches(rows, options)) }
})

test('profile: reusing an id with another module, missing guard or expression injection is rejected', () => {
  const edits = [rows => { rows[4].name = 'foreign' }, rows => { rows.splice(2, 1) }, rows => { rows[3].inject = { __jsExpr: '[]' } }]
  for (const edit of edits) { const rows = input(); edit(rows); assert.throws(() => planPatches(rows, options)) }
})

test('profile: explicit enable overlay can be omitted without changing its source composition', () => {
  const rows = input(), base = [{ insert: rows }]
  const original = composeEntries([base])
  const enabled = composeEntries([base, planPatches(rows, options)])
  assert.equal(enabled.find(row => row.id === ROWS.engine).disabled, false)
  assert.deepEqual(composeEntries([base]), original)
  assert.equal(original.find(row => row.id === ROWS.engine).disabled, true)
})

test('profile: private filesystem destinations reject parent links, relative names and wrong kinds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-profile-path-'))
  await mkdir(join(root, 'real')); await symlink(join(root, 'real'), join(root, 'link'), 'junction')
  await writeFile(join(root, 'file'), 'unchanged')
  await assert.rejects(strictPath('relative', 'directory'), /absolute/u)
  await assert.rejects(strictPath(join(root, 'file'), 'directory'), /kind/u)
  await assert.rejects(strictPath(join(root, 'link', 'new'), 'directory', { absent: true }), /link/u)
  await strictPath(join(root, 'new'), 'directory', { absent: true })
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'unchanged')
})

test('profile: enabled nested groups retain a single globally-addressed roster', () => {
  const rows = input(), child = rows.splice(1, 1)[0]
  rows.push({ id: 'group', name: 'group', group: true, config: [child] })
  const result = compose(rows, planPatches(rows, options))
  const preset = flattenRows(result).find(item => item.row.id === child.id).row
  assert.equal(preset.config.default, 'my-preset')
  assert.equal(preset.config.roots.length, 2)
})
