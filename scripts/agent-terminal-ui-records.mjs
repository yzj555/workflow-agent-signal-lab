/** Read-only maintenance baseline; this UI correction never writes workflow records. */
import assert from 'node:assert/strict'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { backupJournal } from './lib/journal-backup.mjs'

export const root = resolve(import.meta.dirname, '..')
export const base = join(root, '.dsh/activation/workflow-agent-terminal-ui-20260917')
const sha = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
async function hashes(folder) {
  const result = {}
  for (const entry of await readdir(join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name)
      result[file.slice(root.length + 1).replaceAll('\\', '/')] = sha(await readFile(file))
    }
  }
  return result
}
const [action, label = 'final'] = process.argv.slice(2)
assert.ok(['baseline', 'check'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,40}$/u)
if (action === 'baseline') {
  await mkdir(base)
  await mkdir(join(base, 'baseline'))
  for (const name of ['src', 'lib', 'tests', 'preset', 'README.md', 'docs', 'cordis.patch.yml', 'tsdown.config.ts', 'package.json']) {
    await cp(join(root, name), join(base, 'baseline', name), { recursive: true, force: false, errorOnExist: true })
  }
  const witness = { writer: await json(join(root, '.dsh/workflow-runtime/writer.lock')),
    config: sha(await readFile(join(root, 'cordis.patch.yml'))), source: await hashes('src'), build: await hashes('lib'), preset: await hashes('preset') }
  const expected = await json(join(root, '.dsh/activation/workflow-budget-live-matrix-20260917/final-journal/records.json'))
  const backup = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, 'baseline/journal'),
    mode: 'online', validate: snapshot => assert.deepEqual(snapshot.records, expected) })
  await writeFile(join(base, 'baseline/witness.json'), JSON.stringify(witness, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ base, records: backup.rowCount, writer: witness.writer }))
} else {
  const before = await json(join(base, 'baseline/witness.json'))
  assert.deepEqual(await json(join(root, '.dsh/workflow-runtime/writer.lock')), before.writer, 'Host restarted unexpectedly')
  assert.equal(sha(await readFile(join(root, 'cordis.patch.yml'))), before.config, 'Configuration changed')
  assert.deepEqual(await hashes('preset'), before.preset, 'Preset changed')
  const changed = {}
  for (const [folder, allowed] of [
    ['src', ['src/client/workflow-display.ts', 'src/client/workflow-surface.ts']],
    ['lib', ['lib/client.js', 'lib/client.js.map', 'lib/workflow-display.js']],
  ]) {
    const after = await hashes(folder), previous = before[folder === 'src' ? 'source' : 'build']
    changed[folder] = [...new Set([...Object.keys(previous), ...Object.keys(after)])].filter(file => previous[file] !== after[file])
    assert.ok(changed[folder].every(file => allowed.includes(file)), `Out-of-scope ${folder} change: ${changed[folder].join(', ')}`)
  }
  const frozen = await json(join(base, 'baseline/journal/records.json'))
  const backup = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination: join(base, `${label}-journal`),
    mode: 'online', validate: snapshot => assert.deepEqual(snapshot.records, frozen) })
  const result = { checkedAt: new Date().toISOString(), status: 'passed', unchangedRecords: backup.rowCount,
    hostUnchanged: true, configUnchanged: true, presetUnchanged: true, changed, writer: before.writer }
  await writeFile(join(base, `${label}-protection.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(result))
}
