import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { backupJournal, journalFiles, inspectJournal } from '../scripts/lib/journal-backup.mjs'

const json = async file => JSON.parse(await readFile(file, 'utf8'))
async function fixture(t) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'workflow-backup-isolated-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(dirname(target), parent)
    assert.ok(basename(target).startsWith('workflow-backup-isolated-'))
    await rm(target, { recursive: true }) // Only this verified mkdtemp, never the user's workspace.
  })
  return { root, source: join(root, 'journal.sqlite'), destination: join(root, 'backup') }
}
function create(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE u_workflow_runtime_sessions (key TEXT PRIMARY KEY,value TEXT NOT NULL);')
  db.prepare('INSERT INTO u_workflow_runtime_sessions VALUES (?,?)').run('a', 'protected-record')
  return db
}
test('clean stopped snapshot keeps raw bytes and validates records from the final recovered backup', async t => {
  const f = await fixture(t), db = create(f.source)
  db.close()
  const before = await journalFiles(f.source)
  let guards = 0
  const receipt = await backupJournal({ ...f, mode: 'stopped', assertStopped: () => ({ stopped: true, sequence: ++guards }) })
  assert.equal(guards, 3)
  assert.equal(receipt.backup, 'complete')
  assert.equal(receipt.integrity, 'ok')
  assert.equal(receipt.sourceUnchanged, true)
  assert.equal(receipt.rowCount, 1)
  assert.deepEqual(await journalFiles(f.source), before)
  assert.deepEqual(await json(join(f.destination, 'records.json')), inspectJournal(join(f.destination, 'journal.sqlite')).records)
  assert.deepEqual(await json(join(f.destination, 'backup.json')), receipt)
})
test('crashed isolated WAL writer recovers committed WAL-only rows without reading SQLite on the source', async t => {
  const f = await fixture(t)
  const child = fork(fileURLToPath(new URL('./helpers/sqlite-stopped-writer.mjs', import.meta.url)), [f.source], { silent: true, windowsHide: true })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const ready = await Promise.race([once(child, 'message'), new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('isolated writer readiness timeout')), 5000)
    timeout.unref()
  })])
  assert.equal(ready[0].pid, child.pid)
  const stopped = once(child, 'exit')
  child.kill('SIGKILL')
  await stopped
  const before = await journalFiles(f.source)
  assert.ok(before['-wal'].bytes > 32)
  const assertStopped = () => { assert.ok(child.exitCode !== null || child.signalCode !== null); return { pid: child.pid, exited: true } }
  const result = await backupJournal({ ...f, mode: 'stopped', assertStopped })
  assert.equal(result.rowCount, 2, 'committed WAL-only row must not be lost')
  assert.deepEqual(await journalFiles(f.source), before)
  // Recovery also works without a SHM; the original retained evidence is not removed.
  const replay = join(f.destination, 'raw/journal.sqlite')
  await rm(replay + '-shm') // A known isolated-test copy, not the source Journal.
  const second = await backupJournal({ source: replay, destination: join(f.root, 'no-shm'), mode: 'stopped', assertStopped })
  assert.equal(second.rowCount, 2)
  assert.deepEqual(await journalFiles(f.source), before)
})
test('online snapshot hashes its own consistent data; it never silently switches to raw stopped capture', async t => {
  const f = await fixture(t), db = create(f.source)
  try {
    const result = await backupJournal({ ...f, mode: 'online' })
    assert.equal(result.rowCount, 1)
    assert.equal(result.sourceUnchanged, null)
    db.prepare('INSERT INTO u_workflow_runtime_sessions VALUES (?,?)').run('newer', 'written after snapshot')
    assert.deepEqual(await json(join(f.destination, 'records.json')), inspectJournal(join(f.destination, 'journal.sqlite')).records)
    assert.equal(inspectJournal(join(f.destination, 'journal.sqlite')).rowCount, 1)
  } finally { db.close() }
})
test('stopped mode refuses missing/lost owner proof or changing source and keeps failed evidence', async t => {
  const f = await fixture(t), db = create(f.source); db.close()
  await assert.rejects(backupJournal({ ...f, mode: 'stopped' }), /guard required/)
  let calls = 0
  await assert.rejects(backupJournal({ ...f, mode: 'stopped', assertStopped: async () => {
    if (++calls === 2) await writeFile(f.source + '-wal', 'new unverified writer')
    return { stopped: true }
  } }), /changed after capture/)
  assert.equal((await json(join(f.destination, 'backup.json'))).backup, 'failed')
  await assert.rejects(readFile(join(f.destination, 'records.json')), { code: 'ENOENT' })
  await assert.rejects(backupJournal({ ...f, mode: 'stopped', assertStopped: () => true }), { code: 'EEXIST' })
  await assert.rejects(backupJournal({ ...f, destination: join(f.root, 'lost-owner'), mode: 'stopped', assertStopped: () => { throw new Error('owner changed') } }), /owner changed/)
  assert.equal((await json(join(f.root, 'lost-owner/backup.json'))).backup, 'failed')
})
test('corruption and logical-validation failure never produce a green backup receipt', async t => {
  const f = await fixture(t)
  await writeFile(f.source, 'not a SQLite database')
  const before = await journalFiles(f.source)
  await assert.rejects(backupJournal({ ...f, mode: 'stopped', assertStopped: () => ({ stopped: true }) }))
  assert.deepEqual(await journalFiles(f.source), before)
  assert.equal((await json(join(f.destination, 'backup.json'))).backup, 'failed')
  const validSource = join(f.root, 'valid.sqlite'), db = create(validSource); db.close()
  const destination = join(f.root, 'bad-contract')
  await assert.rejects(backupJournal({ source: validSource, destination, mode: 'online', validate: snapshot => assert.equal(snapshot.rowCount, 99) }))
  const receipt = await json(join(destination, 'backup.json'))
  assert.equal(receipt.integrity, 'ok')
  assert.equal(receipt.backup, 'failed', 'SQLite integrity is not the protected-record contract')
  await assert.rejects(readFile(join(destination, 'records.json')), { code: 'ENOENT' })
})
