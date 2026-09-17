// Consistent, read-only baseline of the active Journal; no writer acquisition.
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync, backup } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const dir = resolve('.dsh/activation/workflow-budget-recovery-20260915/baseline')
await mkdir(dir, { recursive: false })
for (const name of ['src', 'lib', 'preset', 'package.json', 'tsdown.config.ts']) {
  await cp(name, resolve(dir, name), { recursive: true, errorOnExist: true, force: false })
}
await cp('.dsh/workflow-runtime/writer.lock', resolve(dir, 'writer.lock'))
const live = new DatabaseSync('.dsh/workflow-runtime/journal.sqlite', { readOnly: true })
try { await backup(live, resolve(dir, 'journal.sqlite')) } finally { live.close() }
const db = new DatabaseSync(resolve(dir, 'journal.sqlite'), { readOnly: true })
try {
  const rows = db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
  await writeFile(resolve(dir, 'records.json'), JSON.stringify(Object.fromEntries(rows.map(row =>
    [row.key, createHash('sha256').update(row.value).digest('hex')])), null, 2))
  console.log(JSON.stringify({ directory: dir, rows: rows.length,
    owner: JSON.parse(await readFile(resolve(dir, 'writer.lock'), 'utf8')) }))
} finally { db.close() }
