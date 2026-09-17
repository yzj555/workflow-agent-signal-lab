/** Read/backup-only evidence guard for two explicitly authorized online Sessions. */
import assert from 'node:assert/strict'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { resolve, join } from 'node:path'
import { backupJournal } from './lib/journal-backup.mjs'

export const root = 'F:/dsh/workflow-agent-signal-lab'
export const base = resolve(root, '.dsh/activation/workflow-budget-live-matrix-20260917')
export const cases = {
  command: { id: 'workflow-budget-command-online-20260917', title: '整轮预算验收 · 命令额度', workspace: 'F:/dsh/workflow-budget-live-command-20260917' },
  time: { id: 'workflow-budget-time-online-20260917', title: '整轮预算验收 · 累计时长', workspace: 'F:/dsh/workflow-budget-live-time-20260917' },
}
const runtime = join(root, '.dsh/workflow-runtime')
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
export async function records(file = join(runtime, 'journal.sqlite')) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare('SELECT key,value FROM u_workflow_runtime_sessions ORDER BY key').all() }
  finally { db.close() }
}
async function codeHashes() {
  const hashes = {}
  for (const folder of ['src', 'lib', 'preset']) {
    for (const entry of await readdir(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = join(entry.parentPath, entry.name)
      hashes[file.slice(resolve(root).length + 1).replaceAll('\\', '/')] = sha(await readFile(file))
    }
  }
  return hashes
}
export async function guard(file) {
  const frozen = await readJson(join(base, 'baseline/journal/records.json'))
  const current = await records(file)
  const hashes = Object.fromEntries(current.map(row => [row.key, sha(row.value)]))
  for (const [id, hash] of Object.entries(frozen)) assert.equal(hashes[id], hash, `protected record changed: ${id}`)
  try {
    const sealed = await readJson(join(base, 'sealed-samples.json'))
    for (const [id, hash] of Object.entries(sealed)) assert.equal(hashes[id], hash, `closed test sample changed: ${id}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.ok(current.every(row => row.key in frozen || Object.values(cases).some(item => item.id === row.key)), 'Unexpected new workflow row')
  assert.deepEqual(await codeHashes(), await readJson(join(base, 'baseline/code-hashes.json')), 'Runtime source/build/preset changed')
  return { protectedRecords: Object.keys(frozen).length, currentRecords: current.length,
    testRecords: Object.fromEntries(current.filter(row => Object.values(cases).some(item => item.id === row.key)).map(row => [row.key, JSON.parse(row.value)])) }
}
export async function checkConfig(phase) {
  assert.ok(['baseline', 'command', 'time'].includes(phase))
  const original = await readFile(join(base, 'baseline/cordis.patch.yml'), 'utf8')
  const active = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  const addons = phase === 'baseline' ? '' : `        # BEGIN budget-live-matrix-20260917 (${phase})\n        runBudgetEnabled: true\n        runBudgetScope:\n          - ${cases[phase].id}\n        runModelRequests: 240\n        runCommands: ${phase === 'command' ? 1 : 40}\n        runTimeBudgetEnabled: ${phase === 'time'}\n${phase === 'time' ? '        runActiveMs: 120000\n' : ''}        # END budget-live-matrix-20260917\n`
  const anchor = '        childCancelGraceMs: 15000\n'
  assert.equal(original.split(anchor).length, 2)
  assert.equal(active, original.replace(anchor, anchor + addons), `Wrong configuration for ${phase}`)
  return { phase, sha256: sha(active) }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'scripts/budget-live-matrix-records.mjs')) {
  const [action, label, pid, instance] = process.argv.slice(2)
  if (action === 'baseline') {
    assert.equal((await records()).length, 18)
    await mkdir(base)
    await mkdir(join(base, 'baseline'))
    for (const file of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']) {
      await cp(join(root, file), join(base, 'baseline', file), { errorOnExist: true, force: false })
    }
    await cp(join(root, 'lib'), join(base, 'baseline/lib'), { recursive: true, errorOnExist: true, force: false })
    await cp(join(runtime, 'writer.lock'), join(base, 'baseline/writer.lock'), { errorOnExist: true, force: false })
    await writeFile(join(base, 'baseline/code-hashes.json'), JSON.stringify(await codeHashes(), null, 2) + '\n', { flag: 'wx' })
    const backup = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(base, 'baseline/journal'), mode: 'online',
      validate: value => assert.equal(value.rowCount, 18) })
    console.log(JSON.stringify({ base, backup }))
  } else if (action === 'check-config') {
    console.log(JSON.stringify(await checkConfig(label)))
  } else if (action === 'check') {
    const checked = await guard()
    console.log(JSON.stringify({ ...checked, testRecords: Object.fromEntries(Object.entries(checked.testRecords).map(([id, record]) => [id, { revision: record.revision }])) }))
  } else {
    assert.equal(action, 'backup')
    assert.match(label, /^[a-z][a-z0-9-]{0,55}$/u)
    const stopped = pid !== undefined
    assert.ok(!stopped || (Number.isSafeInteger(Number(pid)) && Number(pid) > 0 && instance))
    const destination = join(base, label)
    const backup = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination, mode: stopped ? 'stopped' : 'online',
      assertStopped: stopped ? async () => {
        const owner = await readJson(join(runtime, 'writer.lock'))
        assert.equal(owner.pid, Number(pid)); assert.equal(owner.instanceId, instance)
        assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' })
        await new Promise((accept, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: 3080 })
          socket.setTimeout(1500)
          socket.once('connect', () => { socket.destroy(); reject(Error('3080 still serving')) })
          socket.once('timeout', () => { socket.destroy(); reject(Error('Cannot establish stopped port')) })
          socket.once('error', error => error.code === 'ECONNREFUSED' ? accept() : reject(error))
        })
        return { ...owner, checkedAt: new Date().toISOString(), port3080: 'not-listening' }
      } : undefined,
      validate: async () => guard(join(destination, 'journal.sqlite')) })
    await cp(join(root, 'cordis.patch.yml'), join(destination, 'cordis.patch.yml'), { errorOnExist: true, force: false })
    console.log(JSON.stringify(backup))
  }
}
