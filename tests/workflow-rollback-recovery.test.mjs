import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, readdir, rename, mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { fixture, diskView } from './helpers/workflow-crash-fixture.mjs'
import { displayWorkflowState } from '../lib/workflow-display.js'
import { applyDurableRollback, inspectDurableRollback, cleanDurableRollback } from '../lib/workflow-control.js'

const original = 'export const nativeReady = "original"\n'
const stages = ['需求确认', '计划与拆解', '实现', '验证', '独立审查', '交付', '沉淀'].map(name => ({ name, purpose: name }))
const display = snapshot => displayWorkflowState({ status: 'ready', snapshot }, [], stages)
const temps = async directory => (await readdir(join(directory, 'src'))).filter(name => name.startsWith('.workflow-rollback-')).sort()
async function assertRestored(directory) {
  assert.equal(await readFile(join(directory, 'src/native.js'), 'utf8'), original)
  assert.deepEqual(await readFile(join(directory, 'src/other.txt')), Buffer.from([255, 254, 0, 1, 128, 10]))
  await assert.rejects(readFile(join(directory, 'src/added.txt')), { code: 'ENOENT' })
  assert.deepEqual(await temps(directory), [])
}

for (const mode of ['rollback-before', 'rollback-backed', 'rollback-installed', 'rollback-applied', 'rollback-cleanup']) {
  test(`real Host cut at ${mode}: durable intent, explicit recovery and repeat restart`, { timeout: 90000 }, async t => {
    const f = await fixture(t, mode)
    const active = await f.host(mode)
    assert.equal(active.ready.state.outcome.outcome, 'PASS') // historical result is retained, not rewritten
    const transaction = active.ready.state.rollbackTransaction
    assert.ok(transaction)
    assert.equal(transaction.files.length, 3)
    const committed = ['rollback-applied', 'rollback-cleanup'].includes(mode)
    assert.equal(transaction.phase, committed ? 'applied' : 'prepared')
    assert.equal(active.ready.state.gates[transaction.gateId].status, 'approved')
    await f.cut(active)
    let cold = await f.host('cold')
    await f.save('first-cold', cold.ready)
    assert.equal(cold.ready.requests.length, 0)
    assert.equal(cold.ready.questions.length, 0, 'Restart must not generate or auto-answer a native question')
    if (!committed) {
      assert.equal(cold.ready.state.rollbackTransaction.phase, 'interrupted')
      assert.equal(cold.ready.state.rollbacks.length, 0, 'Files matching targets are not a committed rollback')
      assert.equal(display(cold.ready.snapshot).badge, '撤销未完成')
      assert.equal(display(cold.ready.snapshot).stageDetails[5].label, '撤销未完成')
      const status = await cold.request('read-status')
      assert.equal('deliverables' in status.detail, false)
      assert.deepEqual(status.detail.learning.sources, [])
      assert.match(status.detail.next ?? status.detail.hint ?? JSON.stringify(status.detail), /撤销/)
      assert.equal((await cold.request('probe-new-run')).detail.accepted, false)
      await f.repeated(cold, (await cold.request('inspect')))
      cold = await f.host('cold')
      const recovered = await cold.request('explicit-rollback')
      await f.save('explicitly-recovered', recovered)
      assert.equal(recovered.detail.accepted, true, JSON.stringify(recovered.detail))
      assert.equal(recovered.detail.result.applied, true)
      assert.equal(recovered.questions.length, 1)
      assert.match(recovered.questions[0].details[0], /中断/)
      assert.notEqual(recovered.state.rollbackTransaction.gateId, transaction.gateId)
      assert.equal(recovered.state.rollbackTransaction.rollbackId, transaction.rollbackId)
    }
    const final = await cold.request('inspect')
    assert.equal(final.state.rollbackTransaction.phase, 'cleaned')
    assert.equal(final.state.rollbacks.length, 1)
    assert.equal(display(final.snapshot).badge, '已撤销')
    assert.equal(final.requests.length, 0, 'No extra model or background Agent needed for recovery')
    await assertRestored(f.directory)
    await f.repeated(cold, final)
    const disk = await diskView(f.directory, f.rootId)
    assert.equal(disk.record.events.filter(e => e.data?.name === 'rollback/applied' || e.name === 'rollback/applied').length, 1)
  })
}

test('post-crash user edits block the whole restore; stale and rejected answers never resume it', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'rollback-drift-and-answer', 'rollback-backed')
  const active = await f.host('rollback-backed')
  const oldQuestionId = active.ready.state.rollbackTransaction.gateId
  await f.cut(active)
  const target = join(f.directory, 'src/native.js')
  await writeFile(target, 'user work after crash\n')
  const cold = await f.host('cold')
  assert.match(cold.ready.state.rollbackTransaction.reason, /冲突/)
  const beforeTemps = await temps(f.directory)
  const blocked = await cold.request('explicit-rollback')
  assert.equal(blocked.detail.accepted, false)
  assert.equal(blocked.questions.length, 0)
  assert.equal(await readFile(target, 'utf8'), 'user work after crash\n')
  assert.deepEqual(await temps(f.directory), beforeTemps)
  // Simulate a human preserving their conflicting work elsewhere, not deleting it.
  await rename(target, join(f.directory, 'user-work-preserved.txt'))
  const stale = await cold.request('explicit-rollback', { oldQuestionId })
  assert.ok(!stale.detail.accepted || !stale.detail.result.applied)
  const rejected = await cold.request('explicit-rollback', { reject: true })
  assert.equal(rejected.detail.result.applied, false)
  assert.equal(rejected.state.rollbacks.length, 0)
  await assert.rejects(readFile(target), { code: 'ENOENT' })
  const recovered = await cold.request('explicit-rollback')
  assert.equal(recovered.detail.result.applied, true)
  assert.equal(await readFile(join(f.directory, 'user-work-preserved.txt'), 'utf8'), 'user work after crash\n')
  await assertRestored(f.directory)
  await f.save('conflict-stale-reject-and-confirm', recovered)
  await f.repeated(cold, recovered)
})

test('applied-before-cleanup restart preserves subsequent atomic user edits', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'rollback-applied-user-edit', 'rollback-applied')
  const active = await f.host('rollback-applied')
  await f.cut(active)
  const draft = join(f.directory, 'src/user-draft.txt')
  await writeFile(draft, 'new user-owned content\n')
  await rename(draft, join(f.directory, 'src/native.js'))
  const cold = await f.host('cold')
  assert.equal(cold.ready.state.rollbackTransaction.phase, 'cleaned')
  assert.equal(await readFile(join(f.directory, 'src/native.js'), 'utf8'), 'new user-owned content\n')
  assert.deepEqual(await temps(f.directory), [])
  assert.equal(cold.ready.state.rollbacks.length, 1)
  await f.save('post-commit-edit-preserved', cold.ready)
  await f.repeated(cold, cold.ready)
})

const stateOf = value => ({ kind: 'file', digest: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) })
test('committed rollback with a changed backup stays pending cleanup, never deletes the evidence', { timeout: 90000 }, async t => {
  const f = await fixture(t, 'rollback-cleanup-conflict', 'rollback-applied')
  const active = await f.host('rollback-applied')
  await f.cut(active)
  const beforeTemps = await temps(f.directory)
  const backup = beforeTemps.find(name => name.endsWith('.backup'))
  await writeFile(join(f.directory, 'src', backup), 'user annotation in backup')
  const cold = await f.host('cold')
  assert.equal(cold.ready.state.rollbackTransaction.phase, 'applied')
  assert.equal(cold.ready.state.rollbacks.length, 1)
  assert.equal(display(cold.ready.snapshot).badge, '已撤销 · 待清理')
  assert.deepEqual(await temps(f.directory), beforeTemps)
  const refused = await cold.request('explicit-rollback')
  assert.equal(refused.detail.accepted, false)
  assert.match(refused.detail.error, /备份摘要/)
  assert.equal(refused.questions.length, 0)
  assert.equal((await cold.request('probe-new-run')).detail.accepted, false)
  await rename(join(f.directory, 'src', backup), join(f.directory, 'preserved-annotated-backup.txt'))
  const cleaned = await cold.request('explicit-rollback')
  assert.equal(cleaned.detail.accepted, true)
  assert.equal(cleaned.state.rollbackTransaction.phase, 'cleaned')
  assert.equal(cleaned.state.rollbacks.length, 1)
  assert.equal(cleaned.questions.length, 0, 'Cleanup uses the existing applied transaction, no new file-restoration gate')
  await assertRestored(f.directory)
  assert.equal(await readFile(join(f.directory, 'preserved-annotated-backup.txt'), 'utf8'), 'user annotation in backup')
  await f.save('cleanup-conflict-preserved-and-resolved', cleaned)
  await f.repeated(cold, cleaned)
})

async function fileFixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-restore-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.txt'), 'current-a')
  await writeFile(join(root, 'src/b.txt'), 'current-b')
  const entries = ['a', 'b'].map(key => ({ relativePath: `src/${key}.txt`, expected: stateOf('current-' + key), target: stateOf('old-' + key) }))
  return { root, id: randomUUID(), entries, read: async digest => Buffer.from(digest === stateOf('old-a').digest ? 'old-a' : 'old-b') }
}
test('corrupt immutable target rejects before any file mutation', async () => {
  const f = await fileFixture()
  await assert.rejects(applyDurableRollback(f.root, f.id, f.entries, async () => Buffer.from('corrupt')), /损坏/)
  assert.equal(await readFile(join(f.root, 'src/a.txt'), 'utf8'), 'current-a')
  assert.deepEqual(await temps(f.root), [])
})
test('cancellation after checkpoint reads prevents starting file replacement', async () => {
  const f = await fileFixture(), abort = new AbortController()
  await assert.rejects(applyDurableRollback(f.root, f.id, f.entries, async digest => {
    abort.abort(new Error('user cancelled rollback')); return f.read(digest)
  }, abort.signal), /user cancelled rollback/)
  assert.equal(await readFile(join(f.root, 'src/a.txt'), 'utf8'), 'current-a')
  assert.deepEqual(await temps(f.root), [])
})
test('partial staging and missing pre-transaction backups require manual reconciliation', async () => {
  const f = await fileFixture()
  await applyDurableRollback(f.root, f.id, f.entries, f.read)
  const names = await temps(f.root)
  const staged = names.find(name => name.endsWith('.restore'))
  // Break the hard link through an atomic replacement, retaining target bytes.
  await writeFile(join(f.root, 'partial-stage'), 'partial')
  await rename(join(f.root, 'partial-stage'), join(f.root, 'src', staged))
  await assert.rejects(inspectDurableRollback(f.root, f.id, f.entries), /暂存内容/)
  await assert.rejects(cleanDurableRollback(f.root, f.id, f.entries), /暂存内容/)
  assert.equal(await readFile(join(f.root, 'src/a.txt'), 'utf8'), 'old-a')
  await rename(join(f.root, 'src', staged), join(f.root, 'preserved-partial-stage'))
  const backup = names.find(name => name.endsWith('.backup'))
  await rename(join(f.root, 'src', backup), join(f.root, 'preserved-backup'))
  await assert.rejects(inspectDurableRollback(f.root, f.id, f.entries), /缺失备份/)
  assert.equal(await readFile(join(f.root, 'src/a.txt'), 'utf8'), 'old-a')
})
test('changed backup or staged file is never deleted or reused', async () => {
  const f = await fileFixture()
  await applyDurableRollback(f.root, f.id, f.entries, f.read)
  const names = await temps(f.root)
  const backup = names.find(name => name.endsWith('.backup'))
  await writeFile(join(f.root, 'src', backup), 'user modified backup')
  await assert.rejects(cleanDurableRollback(f.root, f.id, f.entries), /备份摘要/)
  assert.equal(await readFile(join(f.root, 'src', backup), 'utf8'), 'user modified backup')
  assert.deepEqual(await temps(f.root), names, 'Preflight all backups before deleting even one')
  await assert.rejects(inspectDurableRollback(f.root, f.id, f.entries), /备份摘要/)
})
test('a file appearing after preflight is not overwritten at installation', async () => {
  const f = await fileFixture(), originalLink = fs.link
  fs.link = async (from, to) => {
    if (to === join(f.root, 'src/a.txt')) await writeFile(to, 'racing user content', { flag: 'wx' })
    return originalLink(from, to)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(applyDurableRollback(f.root, f.id, f.entries, f.read), { code: 'EEXIST' })
    assert.equal(await readFile(join(f.root, 'src/a.txt'), 'utf8'), 'racing user content')
    assert.equal(await readFile(join(f.root, 'src/b.txt'), 'utf8'), 'current-b')
    await assert.rejects(inspectDurableRollback(f.root, f.id, f.entries), /冲突/)
  } finally { fs.link = originalLink; syncBuiltinESMExports() }
})
test('parent redirection cannot redirect a persisted authorization', async () => {
  const f = await fileFixture()
  const elsewhere = await mkdtemp(join(tmpdir(), 'workflow-restore-elsewhere-'))
  await writeFile(join(elsewhere, 'a.txt'), 'other user file')
  await rename(join(f.root, 'src'), join(f.root, 'saved-src'))
  await symlink(elsewhere, join(f.root, 'src'), 'junction')
  await assert.rejects(applyDurableRollback(f.root, f.id, f.entries, f.read), /symbolic link/)
  assert.equal(await readFile(join(elsewhere, 'a.txt'), 'utf8'), 'other user file')
})
