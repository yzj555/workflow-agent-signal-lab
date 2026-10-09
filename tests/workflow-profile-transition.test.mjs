import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openWorkflowStorage } from '../lib/workflow-runtime.js'
import { fixture } from './helpers/workflow-fixture.mjs'
import { dataFiles, copyData, replayData, replayRows, semanticDigest } from '../scripts/lib/workflow-transition-data.mjs'
import { maintenanceOwner, transitionDirection, comparableManifest, readCheckpoint, acceptTransitionData, assertTransitionOutput } from '../scripts/lib/workflow-profile-transition.mjs'
import { digest, saveJson, regularFiles } from '../scripts/lib/release-files.mjs'
const packageRoot = resolve(import.meta.dirname, '..')
const temporary = () => mkdtemp(join(tmpdir(), 'workflow-transition-test-'))

async function setup() {
  const root = await temporary(), directory = join(root, 'data')
  const runtime = await openWorkflowStorage(directory)
  const f = fixture('transition-session', 'transition-run')
  await runtime.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  await runtime.close()
  return { root, directory, f }
}

async function acceptanceFixture() {
  const sample = await setup(), backup = join(sample.root, 'checkpoint'), output = join(sample.root, 'configuration')
  await mkdir(backup); await mkdir(output)
  const files = await dataFiles(sample.directory), replay = await replayData(sample.directory, packageRoot)
  await copyData(sample.directory, join(backup, 'data'), files)
  await mkdir(join(backup, 'previous-package'))
  await writeFile(join(backup, 'previous-package', 'synthetic-package.txt'), 'explicit isolated fixture, not a distribution')
  const prior = { version: '1.0.0-rc.3' }
  await saveJson(join(backup, 'previous-plan.json'), prior)
  const checkpointPath = join(backup, 'checkpoint.json')
  await saveJson(checkpointPath, { schemaVersion: 1, kind: 'workflow-transition-checkpoint', plan: prior,
    packageVersion: prior.version, packageFiles: await regularFiles(join(backup, 'previous-package')), dataFiles: files })
  const planPath = join(output, 'activation-plan.json')
  const plan = { schemaVersion: 2, dataDirectory: sample.directory, transition: { protocol: 1, mode: 'upgrade',
    toVersion: '1.0.0-rc.4', checkpointPath, checkpointSha256: digest(await readFile(checkpointPath)),
    expectedData: files, expectedReplay: replay, noDataRollback: true, receiptPath: join(output, 'transition-accepted.json') } }
  await saveJson(planPath, plan)
  return { ...sample, backup, output, planPath, plan, files, checkpointPath, evidence: { packageRoot, metadata: { version: '1.0.0-rc.4' } } }
}

test('transition: direction is explicit, ordered and limited to the verified release family', () => {
  transitionDirection('1.0.0-rc.2', '1.0.0-rc.3', 'upgrade')
  transitionDirection('1.0.0-rc.4', '1.0.0-rc.3', 'rollback')
  transitionDirection('1.0.0-rc.3', '1.0.0-rc.3', 'reconfigure')
  for (const [from, to, mode] of [['1.0.0-rc.3', '1.0.0-rc.3', 'upgrade'], ['1.0.0-rc.3', '1.0.0-rc.4', 'rollback'],
    ['0.0.1', '1.0.0-rc.3', 'upgrade'], ['1.0.0-rc.3', '1.0.0', 'upgrade'], ['1.0.0-rc.3', '1.0.0-rc.2', 'reconfigure']]) {
    assert.throws(() => transitionDirection(from, to, mode))
  }
})

test('transition: only the workflow dependency is excluded from manifest equivalence', () => {
  const original = { dependencies: { '@local/workflow-agent-signal-lab': 'old', other: 'keep' }, dsh: { profile: { patchReload: 'startup' } } }
  const expected = structuredClone(original); delete expected.dependencies['@local/workflow-agent-signal-lab']
  assert.deepEqual(comparableManifest(original), expected)
  assert.equal(original.dependencies['@local/workflow-agent-signal-lab'], 'old')
})

test('transition: new configuration cannot be written into either preserved checkpoint', () => {
  const root = resolve('C:/transition-fixture'), a = join(root, 'source', 'checkpoint.json'), b = join(root, 'target', 'checkpoint.json')
  for (const path of [join(root, 'source', 'data', 'new-output'), join(root, 'target', 'previous-package', 'new-output'), root]) {
    assert.throws(() => assertTransitionOutput(path, a, b), /output-overlaps-checkpoint/u)
  }
  assertTransitionOutput(join(root, 'separate-output'), a, b)
})

test('transition: real runtime owner blocks maintenance; maintenance blocks another runtime', async () => {
  const { directory } = await setup(), active = await openWorkflowStorage(directory)
  try { await assert.rejects(maintenanceOwner(packageRoot, directory), /owned|recovery/u) } finally { await active.close() }
  const owner = await maintenanceOwner(packageRoot, directory)
  try { await assert.rejects(openWorkflowStorage(directory), /owned|recovery/u) } finally { await owner.release() }
})

test('transition: stale or malformed owner is never automatically reclaimed', async () => {
  const { directory } = await setup()
  await writeFile(join(directory, 'writer.lock'), 'malformed-do-not-reclaim', { flag: 'wx' })
  await assert.rejects(maintenanceOwner(packageRoot, directory), /owned|recovery/u)
  assert.equal(await readFile(join(directory, 'writer.lock'), 'utf8'), 'malformed-do-not-reclaim')
})

test('transition: verified owner transfers to storage without an unlocked interval', async () => {
  const { directory, f } = await setup(), before = await dataFiles(directory)
  const owner = await maintenanceOwner(packageRoot, directory), marker = await readFile(join(directory, 'writer.lock'), 'utf8')
  const runtime = await openWorkflowStorage(directory, () => {}, owner)
  try {
    assert.equal(await readFile(join(directory, 'writer.lock'), 'utf8'), marker)
    assert.equal(runtime.journal.readSnapshot(f.rootSessionId).revision, 6)
    await assert.rejects(maintenanceOwner(packageRoot, directory), /owned|recovery/u)
  } finally { await runtime.close() }
  await assert.rejects(access(join(directory, 'writer.lock')), { code: 'ENOENT' })
  assert.deepEqual(await dataFiles(directory), before)
})

test('transition: a transferred owner cannot open another data directory and is released on refusal', async () => {
  const { root, directory } = await setup(), other = join(root, 'other')
  await mkdir(other)
  const owner = await maintenanceOwner(packageRoot, directory)
  await assert.rejects(openWorkflowStorage(other, () => {}, owner), /another data directory/u)
  await assert.rejects(access(join(directory, 'writer.lock')), { code: 'ENOENT' })
  assert.deepEqual(await dataFiles(other), {})
})

test('transition: bounded file capture rejects links, size and count excess without changing data', async () => {
  const root = await temporary()
  await writeFile(join(root, 'a'), 'abc')
  assert.deepEqual(await dataFiles(root), { a: { bytes: 3, sha256: digest('abc') } })
  await assert.rejects(dataFiles(root, { maximumBytes: 2 }), /limit/u)
  await assert.rejects(dataFiles(root, { maximumFiles: 0 }), /limit/u)
  await mkdir(join(root, 'dir')); await symlink(join(root, 'dir'), join(root, 'linked'), 'junction')
  await assert.rejects(dataFiles(root), /link/u)
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'abc')
})

test('transition: private backup preserves objects and refuses to overwrite an earlier backup', async () => {
  const { root, directory } = await setup()
  await mkdir(join(directory, 'objects')); await writeFile(join(directory, 'objects', 'sample'), 'kept')
  const files = await dataFiles(directory), destination = join(root, 'backup')
  await copyData(directory, destination, files)
  assert.deepEqual(await dataFiles(destination), files)
  await assert.rejects(copyData(directory, destination, files), { code: 'EEXIST' })
  assert.deepEqual(await dataFiles(directory), files)
})

test('transition: cold replay preserves complete records, snapshots and all run states', async () => {
  const { directory } = await setup(), before = await dataFiles(directory)
  const result = await replayData(directory, packageRoot)
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].runCount, 1)
  assert.match(result.rows[0].record, /^[a-f0-9]{64}$/u)
  assert.match(result.rows[0].snapshot, /^[a-f0-9]{64}$/u)
  assert.match(result.rows[0].runs, /^[a-f0-9]{64}$/u)
  assert.deepEqual(await dataFiles(directory), before)
  assert.equal(semanticDigest({ a: 1, b: 2 }), semanticDigest({ b: 2, a: 1 }))
})

test('transition: WAL recovery occurs on a copy; original DB and all sidecars stay unchanged', async () => {
  const { root, directory } = await setup(), target = join(root, 'wal')
  await mkdir(target)
  const source = new DatabaseSync(join(directory, 'journal.sqlite'), { readOnly: true })
  const row = source.prepare('SELECT key,value FROM u_workflow_runtime_sessions').get(); source.close()
  const db = new DatabaseSync(join(target, 'journal.sqlite'))
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE u_workflow_runtime_sessions (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO u_workflow_runtime_sessions VALUES (?,?)').run(row.key, row.value)
    const before = await dataFiles(target)
    assert.ok(before['journal.sqlite-wal'].bytes > 0)
    assert.equal((await replayData(target, packageRoot)).rows.length, 1)
    assert.deepEqual(await dataFiles(target), before)
  } finally { db.close() }
})

test('transition: future unknown fields, row misbinding and lossy parsers refuse', async () => {
  const { directory, root } = await setup()
  const db = new DatabaseSync(join(directory, 'journal.sqlite'), { readOnly: true })
  const row = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions').get(); db.close()
  const raw = JSON.parse(row.value)
  await assert.rejects(replayRows([{ ...row, value: JSON.stringify({ ...raw, futurePermission: true }) }], join(packageRoot, 'lib/workflow-journal.js')))
  await assert.rejects(replayRows([{ ...row, key: 'foreign' }], join(packageRoot, 'lib/workflow-journal.js')), /row-binding/u)
  const fake = join(root, 'lossy.mjs')
  await writeFile(fake, "export function parseWorkflowJournalRecord(raw){ const value={...raw}; delete value.futurePermission; return value }; export class WorkflowJournal { constructor(){throw new Error('must reject before construction')} }")
  await assert.rejects(replayRows([{ ...row, value: JSON.stringify({ ...raw, futurePermission: true }) }], fake), /lossy-parser/u)
})

test('transition: checkpoint package and data tampering is detected, not blessed again', async () => {
  const sample = await acceptanceFixture()
  await readCheckpoint(sample.checkpointPath)
  await writeFile(join(sample.backup, 'previous-package', 'synthetic-package.txt'), 'changed')
  await assert.rejects(readCheckpoint(sample.checkpointPath), /archived-package-changed/u)
})

test('transition: first activation accepts compatible data without writing source records', async () => {
  const sample = await acceptanceFixture(), owner = await maintenanceOwner(packageRoot, sample.directory)
  try {
    assert.deepEqual(await acceptTransitionData(sample.plan, sample.planPath, sample.evidence), { firstActivation: true, rows: 1 })
    const receipt = JSON.parse(await readFile(sample.plan.transition.receiptPath, 'utf8'))
    assert.equal(receipt.state, 'compatibility-accepted-not-task-authorized')
    assert.deepEqual(await dataFiles(sample.directory), sample.files)
  } finally { await owner.release() }
})

test('transition: changes after preparation but before first startup refuse; no old-data restoration', async () => {
  const sample = await acceptanceFixture()
  await writeFile(join(sample.directory, 'unexpected-new-object'), 'preserve-me')
  const owner = await maintenanceOwner(packageRoot, sample.directory)
  try { await assert.rejects(acceptTransitionData(sample.plan, sample.planPath, sample.evidence), /data-changed-before-first/u) }
  finally { await owner.release() }
  assert.equal(await readFile(join(sample.directory, 'unexpected-new-object'), 'utf8'), 'preserve-me')
  await assert.rejects(access(sample.plan.transition.receiptPath), { code: 'ENOENT' })
})

test('transition: a subsequent cold start replays CURRENT data without demanding the old revision', async () => {
  const sample = await acceptanceFixture(), owner = await maintenanceOwner(packageRoot, sample.directory)
  try { await acceptTransitionData(sample.plan, sample.planPath, sample.evidence) } finally { await owner.release() }
  const runtime = await openWorkflowStorage(sample.directory)
  try { await runtime.journal.commit({ rootSessionId: sample.f.rootSessionId, expectedRevision: 6, events: [sample.f.approve()] }) }
  finally { await runtime.close() }
  const current = await dataFiles(sample.directory), owner2 = await maintenanceOwner(packageRoot, sample.directory)
  try { assert.deepEqual(await acceptTransitionData(sample.plan, sample.planPath, sample.evidence), { firstActivation: false, rows: 1 }) }
  finally { await owner2.release() }
  assert.deepEqual(await dataFiles(sample.directory), current)
  assert.notDeepEqual(current, sample.files)
})

test('transition: accepted receipt does not hide later corruption or authorize a different plan', async () => {
  const sample = await acceptanceFixture()
  await acceptTransitionData(sample.plan, sample.planPath, sample.evidence)
  const mutated = { ...sample.plan, changed: true }
  await writeFile(sample.planPath, JSON.stringify(mutated))
  await assert.rejects(acceptTransitionData(mutated, sample.planPath, sample.evidence), /receipt-mismatch/u)
  await writeFile(join(sample.directory, 'journal.sqlite'), 'broken current database')
  await assert.rejects(acceptTransitionData(mutated, sample.planPath, sample.evidence))
  assert.equal(await readFile(join(sample.directory, 'journal.sqlite'), 'utf8'), 'broken current database')
})
