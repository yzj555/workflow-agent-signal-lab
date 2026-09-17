/** One authorized online experiment: backup/read guards only, no Journal writer. */
import assert from 'node:assert/strict'
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { backupJournal } from './lib/journal-backup.mjs'

export const root = 'F:/dsh/workflow-agent-signal-lab'
export const base = resolve(root, '.dsh/activation/workflow-budget-online-20260916')
export const testId = 'workflow-budget-online-control-20260916'
export const testTitle = '预算在线验收 · 补额与结束'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
export async function records(file = resolve(root, '.dsh/workflow-runtime/journal.sqlite')) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all() }
  finally { db.close() }
}
export async function guard(file) {
  const frozen = await readJson(join(base, 'baseline/records.json')), current = await records(file)
  const hashes = Object.fromEntries(current.map(row => [row.key, sha(row.value)]))
  for (const [id, hash] of Object.entries(frozen)) assert.equal(hashes[id], hash, `protected record changed: ${id}`)
  assert.ok(current.every(row => row.key in frozen || row.key === testId), 'unexpected new workflow row')
  for (const [file, hash] of Object.entries(await readJson(join(base, 'baseline/code-hashes.json')))) {
    assert.equal(sha(await readFile(join(root, file))), hash, `activated code changed: ${file}`)
  }
  return { protectedRecords: Object.keys(frozen).length, currentRecords: current.length,
    testRecord: current.find(row => row.key === testId) ? JSON.parse(current.find(row => row.key === testId).value) : null }
}
async function save(destination, { stopped, validate } = {}) {
  const receipt = await backupJournal({ source: join(root, '.dsh/workflow-runtime/journal.sqlite'), destination,
    mode: stopped ? 'stopped' : 'online',
    assertStopped: stopped ? async () => {
      const owner = await readJson(join(root, '.dsh/workflow-runtime/writer.lock'))
      assert.equal(owner.pid, stopped.pid); assert.equal(owner.instanceId, stopped.instanceId)
      assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' }, 'Expected stopped Host may still be alive')
      return { ...stopped, checkedAt: new Date().toISOString() }
    } : undefined,
    validate: validate ? () => guard(join(destination, 'journal.sqlite')) : undefined })
  for (const file of ['cordis.patch.yml', '.dsh/workflow-runtime/writer.lock']) {
    await cp(join(root, file), join(destination, file.endsWith('lock') ? 'writer.lock' : 'cordis.patch.yml'), { force: false, errorOnExist: true })
  }
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/budget-online-records.mjs')) {
  const [action, name, stoppedPid, stoppedInstance] = process.argv.slice(2)
  if (action === 'baseline') {
    assert.equal((await records()).length, 17)
    assert.ok(!(await records()).some(row => row.key === testId))
    await mkdir(base)
    await save(join(base, 'baseline'))
    const codeHashes = {}
    for (const file of ['lib/workflow-engine.js', 'lib/workflow-pwsh.js', 'lib/client.js', 'preset/workflow-agent-signal-lab/agent.cordis.yml']) {
      codeHashes[file] = sha(await readFile(join(root, file)))
    }
    await cp(join(root, 'lib'), join(base, 'baseline/lib'), { recursive: true, force: false, errorOnExist: true })
    await writeFile(join(base, 'baseline/code-hashes.json'), JSON.stringify(codeHashes, null, 2), { flag: 'wx' })
    console.log(JSON.stringify({ baseline: base, protectedRecords: 17, codeHashes }))
  } else {
    if (action === 'backup') {
      assert.match(name, /^(?:(activation|activation-retry|restore)-(before|after)|restore-recovered-live)$/u)
      const stopped = name.endsWith('-after') ? { pid: Number(stoppedPid), instanceId: stoppedInstance } : null
      if (stopped) assert.ok(Number.isSafeInteger(stopped.pid) && stopped.pid > 0 && stopped.instanceId, 'Post-stop backup requires exact stopped owner')
      else assert.ok(!stoppedPid && !stoppedInstance, 'Unexpected stopped-owner arguments')
      // Never query the source SQLite before stopped capture; validate the recovered backup.
      const receipt = await save(join(base, name), { stopped, validate: true })
      console.log(JSON.stringify(receipt))
      process.exit(0)
    }
    assert.equal(action, 'check')
    const checked = await guard()
    console.log(JSON.stringify({ protectedRecords: checked.protectedRecords, currentRecords: checked.currentRecords,
      testRevision: checked.testRecord?.revision ?? null, checkedAt: new Date().toISOString() }))
  }
}
