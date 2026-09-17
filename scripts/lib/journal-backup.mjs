/** Maintenance snapshots, not a Journal writer. Never repair/checkpoint the stopped source.
 * See https://sqlite.org/wal.html and https://sqlite.org/backup.html.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'

const suffixes = ['', '-wal', '-shm', '-journal']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

export async function journalFiles(source) {
  const files = {}
  for (const suffix of suffixes) {
    try {
      const info = await lstat(source + suffix)
      assert.ok(info.isFile() && !info.isSymbolicLink(), `Not a regular journal file: ${suffix || 'database'}`)
      const bytes = await readFile(source + suffix)
      files[suffix] = { bytes: bytes.length, sha256: sha(bytes) }
    } catch (error) {
      if (suffix && error.code === 'ENOENT') files[suffix] = null
      else throw error
    }
  }
  return files
}

/** Hash the validated snapshot itself, never a second, potentially newer live SELECT. */
export function inspectJournal(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]), ['ok'], 'Snapshot integrity failed')
    const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
    return { records: Object.fromEntries(rows.map(row => [row.key, sha(row.value)])), rowCount: rows.length }
  } finally { db.close() }
}

export async function backupJournal({ source, destination, mode, assertStopped, validate }) {
  source = resolve(source); destination = resolve(destination)
  assert.ok(mode === 'online' || mode === 'stopped', 'Explicit backup mode required')
  assert.notEqual(dirname(source), destination, 'Backup must use its own new directory')
  if (mode === 'stopped') assert.equal(typeof assertStopped, 'function', 'Stopped-owner guard required; never infer it from a SQLite error')
  await mkdir(destination) // Exclusive: failed/partial evidence cannot be silently overwritten.
  const receipt = { mode, source, startedAt: new Date().toISOString(), backup: 'failed', integrity: 'not-checked',
    sourceUnchanged: mode === 'stopped' ? false : null }
  const target = join(destination, 'journal.sqlite')
  try {
    if (mode === 'online') {
      const live = new DatabaseSync(source, { readOnly: true })
      try { await backup(live, target) } finally { live.close() }
    } else {
      receipt.stoppedBefore = await assertStopped()
      const before = await journalFiles(source)
      await mkdir(join(destination, 'raw'))
      for (const suffix of suffixes) if (before[suffix]) {
        await copyFile(source + suffix, join(destination, 'raw', 'journal.sqlite' + suffix), constants.COPYFILE_EXCL)
      }
      const captured = await journalFiles(join(destination, 'raw', 'journal.sqlite'))
      assert.deepEqual(captured, before, 'Journal changed during capture')
      receipt.stoppedAfterCapture = await assertStopped()
      assert.deepEqual(await journalFiles(source), before, 'Journal changed after capture')
      receipt.rawFiles = captured
      // SHM is a reconstructible WAL index. Retain it as raw evidence but rebuild
      // it only in the disposable recovery copy. Never remove any source sidecar.
      const working = join(destination, 'recovery')
      await mkdir(working)
      for (const suffix of ['', '-wal', '-journal']) if (captured[suffix]) {
        await copyFile(join(destination, 'raw', 'journal.sqlite' + suffix), join(working, 'journal.sqlite' + suffix), constants.COPYFILE_EXCL)
      }
      const recovered = new DatabaseSync(join(working, 'journal.sqlite'))
      try { await backup(recovered, target) } finally { recovered.close() }
      receipt.stoppedAfterRecovery = await assertStopped()
      assert.deepEqual(await journalFiles(source), before, 'Source changed while recovering the copy')
      receipt.sourceUnchanged = true
    }
    const snapshot = inspectJournal(target)
    receipt.integrity = 'ok'
    if (validate) await validate(snapshot)
    await json(join(destination, 'records.json'), snapshot.records)
    Object.assign(receipt, { backup: 'complete', rowCount: snapshot.rowCount, databaseSha256: sha(await readFile(target)) })
    return receipt
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error)
    receipt.sqliteCode = error.errcode ?? null
    throw error
  } finally {
    receipt.finishedAt = new Date().toISOString()
    await json(join(destination, 'backup.json'), receipt)
  }
}
