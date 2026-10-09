import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { planPatches, PACKAGE, PRESET, ROWS, flattenRows } from '../scripts/lib/workflow-profile-config.mjs'
import { DECLARATIVE_DSH, DECLARATION_MODULE, REGISTRY_MODULE, PRESET_HOST_PROVIDERS, createPresetAdmission,
  verifyDeclarativeRuntime } from '../scripts/lib/workflow-declarative-preset.mjs'
import { appendDeclarativeBundle, requirePresetAdmissionProtocol } from '../scripts/lib/workflow-declarative-preset.mjs'
const yaml = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-app-boot'))('js-yaml')
const definition = () => ({ id: PRESET, name: 'Workflow', description: 'Synthetic frozen definition', plugins: [
  { id: 'controlled', name: PACKAGE + '/workflow-preset' },
  { id: 'pwsh', name: PACKAGE + '/workflow-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } },
] })
const input = () => [
  { id: 'unrelated', name: 'unrelated', config: { token: 'synthetic-only' } },
  { id: 'my-registry', name: REGISTRY_MODULE, config: { default: 'standard', selectedDefault: 'custom', futureField: 'keep' } },
  { id: 'custom-preset', name: DECLARATION_MODULE, config: { id: 'custom', plugins: [] } },
  { id: ROWS.preset, name: DECLARATION_MODULE, disabled: true, config: definition() },
  { id: ROWS.guard, name: PACKAGE + '/profile-guard', disabled: true },
  { id: ROWS.ui, name: PACKAGE, disabled: true, inject: ['existing-service'] },
  { id: ROWS.engine, name: PACKAGE + '/workflow-engine', disabled: true },
]
const options = () => ({ dsh: DECLARATIVE_DSH, definition: definition(), dataDirectory: 'C:/synthetic/private-data',
  planPath: 'C:/synthetic/plan.json', engineConfig: { runBudgetEnabled: true } })
const compose = (entries, patches) => composeEntries([[{ insert: entries }], patches], warning => assert.fail(warning))

test('declarative release requires an explicit supported admission protocol, never infers it from a new version number', () => {
  requirePresetAdmissionProtocol({ presetAdmissionProtocol: 1 }, DECLARATIVE_DSH)
  requirePresetAdmissionProtocol({}, '0.1.5-rc.1')
  for (const presetAdmissionProtocol of [undefined, 0, 2, '1', true]) assert.throws(() =>
    requirePresetAdmissionProtocol({ presetAdmissionProtocol }, DECLARATIVE_DSH), /lacks-preset-admission-protocol/u)
})

test('declarative release layer adds an inert official definition without modifying its source rows or expressions', () => {
  const base = [{ insert: input().slice(4) }], before = structuredClone(base)
  const layer = appendDeclarativeBundle(base, definition())
  assert.deepEqual(base, before)
  assert.equal(layer.flatMap(patch => patch.insert).filter(row => row.disabled === true).length, 4)
  const last = layer.at(-1).insert[0]
  assert.equal(last.name, DECLARATION_MODULE); assert.deepEqual(last.config, definition())
  assert.equal(last.inject, undefined)
  assert.deepEqual(yaml.load(yaml.dump(layer, { schema: entryListSchema, noRefs: true }), { schema: entryListSchema }), layer)
  for (const invalid of [[{ insert: [{ id: ROWS.preset, disabled: true }] }], [{ insert: [{ id: 'enabled' }] }], [{ id: 'foreign-patch' }]]) {
    assert.throws(() => appendDeclarativeBundle(invalid, definition()))
  }
})

test('declarative profile preserves registry/defaults and other presets; only the owned declaration is enabled', () => {
  const rows = input(), before = structuredClone(rows), patches = planPatches(rows, options())
  const after = compose(rows, patches)
  assert.deepEqual(rows, before)
  for (const id of ['unrelated', 'my-registry', 'custom-preset']) assert.deepEqual(after.find(row => row.id === id), rows.find(row => row.id === id))
  assert.equal(after.find(row => row.id === ROWS.preset).disabled, false)
  assert.deepEqual(after.find(row => row.id === ROWS.preset).config, definition())
  assert.ok(!JSON.stringify(patches).includes('synthetic-only'))
  assert.equal(patches.some(row => row.id === 'my-registry'), false)
})

test('declarative profile gives engine provider readiness and UI final readiness, without making declaration depend on controller', () => {
  const after = compose(input(), planPatches(input(), options()))
  assert.deepEqual(after.find(row => row.id === ROWS.ui).inject, ['existing-service', 'workflowReleaseVerified'])
  assert.deepEqual(after.find(row => row.id === ROWS.engine).inject, ['workflowReleaseReady', ...PRESET_HOST_PROVIDERS])
  assert.equal(after.find(row => row.id === ROWS.preset).inject, undefined)
})

test('declarative profile preserves unevaluated child expressions and round trips through official YAML', () => {
  const rows = input(), patches = planPatches(rows, options())
  const serialized = yaml.dump([{ insert: rows }, ...patches], { schema: entryListSchema, noRefs: true })
  assert.match(serialized, /!!js/u)
  assert.deepEqual(yaml.load(serialized, { schema: entryListSchema }), [{ insert: rows }, ...patches])
})

test('declarative profile refuses missing, shadowed, duplicate and externally injected definitions', () => {
  for (const edit of [rows => rows.splice(3, 1), rows => { rows[3].name = 'foreign' },
    rows => rows.push({ ...rows[3], id: 'shadow' }), rows => { rows[3].inject = ['foreign-ready'] },
    rows => { rows[3].disabled = false }, rows => { rows[3].config.plugins = [] }]) {
    const rows = input(); edit(rows)
    assert.throws(() => planPatches(rows, options()))
  }
})

test('declarative profile refuses dynamic declaration identities and inactive ancestors instead of guessing', () => {
  for (const edit of [rows => { rows[2].config = { __jsExpr: 'unknownDefinition' } },
    rows => { rows[2].config.id = { __jsExpr: 'unknownId' } },
    rows => { rows[1].config = { __jsExpr: 'unknownRegistry' } },
    rows => { const child = rows.splice(3, 1)[0]; rows.push({ id: 'conditional', name: 'cordis:group', group: true, disabled: { __jsExpr: 'unknown' }, config: [child] }) },
    rows => { const child = rows.splice(1, 1)[0]; rows.push({ id: 'conditional', name: 'cordis:group', group: true, disabled: true, config: [child] }) }]) {
    const rows = input(); edit(rows)
    assert.throws(() => planPatches(rows, options()))
  }
})

test('declarative profile requires a fresh inactive bundle and rejects existing default selection', () => {
  for (const edit of [rows => { rows[1].config.default = PRESET }, rows => { rows[1].config.selectedDefault = PRESET },
    rows => { rows[6].config = { dataDirectory: 'C:/old' } }, rows => { rows[5].disabled = false }]) {
    const rows = input(); edit(rows)
    assert.throws(() => planPatches(rows, options()))
  }
  assert.throws(() => planPatches(input(), { ...options(), dsh: 'unknown-version' }), /unsupported-host/u)
})

test('declarative profile enable overlay can be omitted and enabled nested declarations retain global addressing', () => {
  const rows = input(), declaration = rows.splice(3, 1)[0]
  rows.push({ id: 'container', name: 'cordis:group', group: true, config: [declaration] })
  const patches = planPatches(rows, options())
  assert.equal(flattenRows(compose(rows, patches)).find(value => value.row.id === ROWS.preset).row.disabled, false)
  assert.equal(flattenRows(compose(rows, [])).find(value => value.row.id === ROWS.preset).row.disabled, true)
})

test('release preset admission stays closed through an in-flight audit and rejects concurrent or repeated audits', async () => {
  let finish, notifications = 0
  const admission = createPresetAdmission(() => new Promise(resolve => { finish = resolve }), () => { notifications++ })
  assert.throws(() => admission.assertReady(), /not-verified/u)
  const pending = admission.verifyRuntime()
  assert.throws(() => admission.assertReady(), /not-verified/u)
  await assert.rejects(admission.verifyRuntime(), /already-started/u)
  finish(); await pending
  admission.assertReady(); assert.equal(notifications, 1)
  await assert.rejects(admission.verifyRuntime(), /already-started/u)
  admission.revoke(); assert.throws(() => admission.assertReady(), /not-verified/u)
})

test('release preset admission cannot open after a failed audit, a late completion after revoke or publication failure', async () => {
  const failed = createPresetAdmission(async () => { throw new Error('broken preset') })
  await assert.rejects(failed.verifyRuntime(), /broken preset/u)
  assert.throws(() => failed.assertReady(), /not-verified/u)
  let finish, notifications = 0
  const revoked = createPresetAdmission(() => new Promise(resolve => { finish = resolve }), () => { notifications++ })
  const pending = revoked.verifyRuntime(); revoked.revoke(); finish()
  await assert.rejects(pending, /revoked/u); assert.equal(notifications, 0)
  assert.throws(() => revoked.assertReady(), /not-verified/u)
  const publication = createPresetAdmission(async () => {}, () => { throw new Error('cannot publish') })
  await assert.rejects(publication.verifyRuntime(), /cannot publish/u)
  assert.throws(() => publication.assertReady(), /not-verified/u)
})

test('scoped runtime audit refuses a missing required provider before attempting any registry or Host-tree wait', async () => {
  let touchedLoader = false
  const ctx = { get: () => undefined, loader: { entries() { touchedLoader = true; throw new Error('must not enumerate') },
    await() { throw new Error('must not wait on Host tree') } } }
  await assert.rejects(verifyDeclarativeRuntime(ctx, {}, definition()), /provider-not-ready/u)
  assert.equal(touchedLoader, false)
})
