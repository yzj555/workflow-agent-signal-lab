/** This cleanup is read-only with respect to all 18 historical workflow records. */
import assert from 'node:assert/strict'
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { createConnection } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { backupJournal } from './lib/journal-backup.mjs'

const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-budget-cleanup-20260917')
const runtime = join(root, '.dsh/workflow-runtime')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const [action, label = 'final'] = process.argv.slice(2)
assert.ok(['baseline', 'check'].includes(action))
assert.match(label, /^[a-z][a-z0-9-]{0,40}$/u)
const ownerBytes = await readFile(join(runtime, 'writer.lock'))
const owner = JSON.parse(ownerBytes)
assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.instanceId === 'string')
async function assertStopped() {
  assert.equal(sha(await readFile(join(runtime, 'writer.lock'))), sha(ownerBytes), 'Writer changed')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}'; if ($null -ne $p) { @{pid=$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`], { windowsHide: true })
  const current = stdout.trim() ? JSON.parse(stdout) : null
  // Windows can reuse a dead Host's PID. Never stop or otherwise touch its new owner.
  if (current) assert.ok(Date.parse(current.createdAt) > owner.startedAt + 10000, 'Recorded writer may still be alive')
  await new Promise((accept, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 3080 })
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); reject(new Error('3080 is serving; stopped backup refused')) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot establish stopped-port state')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? accept() : reject(error))
  })
  return { pid: owner.pid, instanceId: owner.instanceId, checkedAt: new Date().toISOString(), pidReusedByLaterProcess: current, port3080: 'not-listening' }
}
await assertStopped()
if (action === 'baseline') {
  await mkdir(base)
  const baseline = join(base, 'baseline')
  await mkdir(baseline)
  for (const file of ['src', 'tests', 'scripts', 'docs', 'lib', 'preset', 'README.md', 'cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'tsdown.config.ts']) {
    await cp(join(root, file), join(baseline, file), { recursive: true, force: false, errorOnExist: true })
  }
  await writeFile(join(baseline, 'writer.lock'), ownerBytes, { flag: 'wx' })
  const receipt = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(baseline, 'journal'), mode: 'stopped', assertStopped,
    validate: snapshot => assert.equal(snapshot.rowCount, 18) })
  console.log(JSON.stringify({ base, ...receipt }))
} else {
  const records = JSON.parse(await readFile(join(base, 'baseline/journal/records.json'), 'utf8'))
  assert.equal(sha(await readFile(join(root, 'cordis.patch.yml'))), sha(await readFile(join(base, 'baseline/cordis.patch.yml'))), 'Default budget scope changed')
  const receipt = await backupJournal({ source: join(runtime, 'journal.sqlite'), destination: join(base, label + '-journal'), mode: 'stopped', assertStopped,
    validate: snapshot => assert.deepEqual(snapshot.records, records, 'Historical records changed') })
  console.log(JSON.stringify(receipt))
}
