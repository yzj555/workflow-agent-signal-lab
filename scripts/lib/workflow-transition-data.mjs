/** Read-only replay on owned copies. No original SQLite open, repair or migration. */
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readdir, mkdir, copyFile, mkdtemp, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { strictPath } from './workflow-profile-config.mjs'
import { digest } from './release-files.mjs'

const MiB = 1024 * 1024
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const semanticDigest = value => digest(JSON.stringify(canonical(value)))

export async function dataFiles(directory, { maximumBytes = 2048 * MiB, maximumFiles = 20000 } = {}) {
  await strictPath(directory, 'directory')
  const files = {}; let total = 0, count = 0, directories = 0
  async function walk(path, depth = 0) {
    if (++directories > 20000 || depth > 64) throw new Error('transition-directory-limit')
    for (const name of (await readdir(path)).sort()) {
      const at = join(path, name), key = relative(directory, at).replaceAll('\\', '/')
      if (key === 'writer.lock') continue // The caller holds this exact CAS owner throughout the operation.
      const stat = await lstat(at)
      if (stat.isSymbolicLink()) throw new Error('transition-data-link')
      if (stat.isDirectory()) { await walk(at, depth + 1); continue }
      if (!stat.isFile()) throw new Error('transition-data-not-file')
      if (count >= maximumFiles || stat.size > 512 * MiB || total + stat.size > maximumBytes) throw new Error('transition-data-limit')
      const hash = createHash('sha256'); let bytes = 0
      for await (const chunk of createReadStream(at)) {
        bytes += chunk.length
        if (bytes > stat.size || total + bytes > maximumBytes) throw new Error('transition-data-changed-or-limit')
        hash.update(chunk)
      }
      if (bytes !== stat.size) throw new Error('transition-data-changed')
      total += bytes; count++; files[key] = { bytes, sha256: hash.digest('hex') }
    }
  }
  await walk(directory)
  return files
}

export async function copyData(directory, destination, files) {
  await mkdir(destination)
  for (const key of Object.keys(files)) {
    const path = join(destination, key)
    const parent = dirname(path)
    await mkdir(parent, { recursive: true })
    await copyFile(join(directory, key), path, 1)
  }
  assert.deepEqual(await dataFiles(destination), files, 'transition-copy-changed')
}

export async function replayRows(rows, modulePath) {
  const { WorkflowJournal, parseWorkflowJournalRecord } = await import(pathToFileURL(modulePath).href)
  const result = []
  for (const row of rows) {
    const raw = JSON.parse(row.value), parsed = parseWorkflowJournalRecord(raw)
    // A permissive old parser must not silently drop a new field or rewrite defaults.
    assert.deepEqual(parsed, raw, 'transition-lossy-parser')
    assert.equal(parsed.rootSessionId, row.key, 'transition-row-binding')
    const values = new Map([[row.key, parsed]])
    const journal = new WorkflowJournal({ get: key => values.get(key), entries: () => values.entries(),
      put: async () => { throw new Error('transition-write-forbidden') } })
    try {
      result.push({ key: row.key, record: semanticDigest(parsed), snapshot: semanticDigest(journal.readSnapshot(row.key)),
        runs: semanticDigest(journal.readAllRunStates()), runCount: journal.readAllRunStates().length })
    } finally { await journal.close() }
  }
  return result
}

/** Caller must own writer.lock; sidecars are preserved and recovered only in this disposable copy. */
export async function replayData(directory, packageRoot) {
  const before = await dataFiles(directory)
  if (!before['journal.sqlite']) throw new Error('transition-journal-missing')
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-transition-read-'))
  const file = join(temporary, 'journal.sqlite')
  let db
  try {
    for (const suffix of ['', '-wal', '-journal']) if (before['journal.sqlite' + suffix]) await copyFile(join(directory, 'journal.sqlite' + suffix), file + suffix, 1)
    assert.deepEqual(await dataFiles(directory), before, 'transition-source-changed-during-copy')
    db = new DatabaseSync(file) // Original directory is never opened by SQLite.
    db.exec('BEGIN')
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]), ['ok'], 'transition-integrity')
    if (db.prepare('SELECT count(*) AS count FROM u_workflow_runtime_sessions').get().count > 1000) throw new Error('transition-row-limit')
    const headers = db.prepare('SELECT key, length(CAST(value AS BLOB)) AS bytes FROM u_workflow_runtime_sessions ORDER BY key').all()
    if (headers.length > 1000 || headers.some(row => typeof row.key !== 'string' || row.key.length > 512 || row.bytes > 16 * MiB)
      || headers.reduce((sum, row) => sum + row.bytes, 0) > 512 * MiB) throw new Error('transition-row-limit')
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    const query = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?')
    const rows = headers.map(row => ({ key: row.key, value: query.get(row.key).value }))
    const replay = await replayRows(rows, join(packageRoot, 'lib/workflow-journal.js'))
    return { schema: semanticDigest(schema), rows: replay }
  } finally {
    db?.close()
    // Remove only fixed names in this exact freshly-created private directory.
    // No recursive delete, no caller-supplied path, no original sidecar cleanup.
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(file + suffix, { force: true })
    await rmdir(temporary)
    assert.deepEqual(await dataFiles(directory), before, 'transition-source-changed-during-replay')
  }
}
