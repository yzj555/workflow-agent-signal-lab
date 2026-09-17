/** Offline slice baseline; never acquires the active Journal writer. */
import { mkdir, cp, writeFile } from 'node:fs/promises'
import { DatabaseSync, backup } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const directory = resolve('.dsh/activation/workflow-budget-scope-20260916')
await mkdir(directory)
const baseline = resolve(directory, 'baseline')
await mkdir(baseline)
for (const name of ['src', 'tests', 'docs', 'lib', 'preset', 'README.md', 'cordis.patch.yml',
  'package.json', 'pnpm-lock.yaml', 'tsdown.config.ts']) {
  await cp(name, resolve(baseline, name), { recursive: true, errorOnExist: true, force: false })
}
await cp('.dsh/workflow-runtime/writer.lock', resolve(baseline, 'writer.lock'))
const live = new DatabaseSync('.dsh/workflow-runtime/journal.sqlite', { readOnly: true })
try { await backup(live, resolve(baseline, 'journal.sqlite')) } finally { live.close() }
const snapshot = new DatabaseSync(resolve(baseline, 'journal.sqlite'), { readOnly: true })
try {
  const rows = snapshot.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all()
  await writeFile(resolve(baseline, 'records.json'), JSON.stringify(Object.fromEntries(rows.map(row =>
    [row.key, createHash('sha256').update(row.value).digest('hex')])), null, 2) + '\n')
  console.log(JSON.stringify({ directory, rows: rows.length }))
} finally { snapshot.close() }
