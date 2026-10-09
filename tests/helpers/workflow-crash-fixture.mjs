import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../../lib/workflow-journal.js'

const childFile = new URL('./workflow-crash-host.mjs', import.meta.url)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = value => createHash('sha256').update(value).digest('hex')
export async function diskView(directory, rootId) {
  const db = new DatabaseSync(join(directory, 'journal/journal.sqlite'), { readOnly: true })
  let raw
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]), ['ok'])
    raw = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?').get(rootId).value
  } finally { db.close() }
  const record = parseWorkflowJournalRecord(JSON.parse(raw))
  const journal = new WorkflowJournal({ get: key => key === rootId ? record : undefined,
    entries: function* () { yield [rootId, record] }, put: async () => { throw new Error('Read-only crash witness') } })
  try {
    const snapshot = journal.readSnapshot(rootId)
    return { rawSha256: sha(raw), record, snapshot, state: journal.readRunState(rootId, snapshot.run.runId) }
  } finally { await journal.close() }
}
export async function fixture(t, name, scenario = name) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-crash-matrix-')))
  const token = randomUUID(), rootId = 'crash-fixture-' + randomUUID()
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ token, rootId, scenario }))
  const evidence = { name, directory, rootId, startedAt: new Date().toISOString(), phases: [], children: [],
    scope: 'independent native child Hosts, scripted model, real SQLite and bounded local processes; no live 3080 writes' }
  const children = []
  const save = async (phase, data) => {
    const entry = { phase, at: new Date().toISOString(), ...structuredClone(data) }
    evidence.phases.push(entry)
    await writeFile(join(directory, `${String(evidence.phases.length).padStart(2, '0')}-${phase}.json`), JSON.stringify(entry, null, 2), { flag: 'wx' })
  }
  async function host(mode) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    const child = fork(childFile, [directory, mode, token], { silent: true, windowsHide: true, execArgv: [], env })
    const messages = [], log = [], exited = once(child, 'exit')
    const entry = { child, exited, messages, log, mode }
    children.push(entry)
    child.stdout.on('data', chunk => log.push(String(chunk)))
    child.stderr.on('data', chunk => log.push(String(chunk)))
    child.on('message', message => messages.push(message))
    child.on('error', error => messages.push({ kind: 'error', message: String(error) }))
    let sequence = 0
    async function wait(predicate, milliseconds = 18000) {
      const deadline = Date.now() + milliseconds
      for (;;) {
        const found = messages.find(predicate)
        if (found) return found
        const failure = messages.find(message => message.kind === 'error')
        if (failure) throw new Error(JSON.stringify(failure) + '\n' + log.join(''))
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture Host ${mode} exited before reply: ${child.exitCode}/${child.signalCode}\n${log.join('')}`)
        if (Date.now() > deadline) throw new Error(`Fixture Host ${mode} timed out\n${log.join('')}`)
        await delay(10)
      }
    }
    const ready = await wait(message => message.kind === (mode === 'lock-probe' ? 'lock-probe' : 'ready'))
    return { child, exited, ready,
      async request(action, extra = {}) {
        const id = ++sequence
        child.send({ id, action, ...extra })
        return wait(message => message.kind === 'reply' && message.id === id)
      },
      async close() {
        await this.request('close')
        const [code, signal] = await exited
        assert.equal(code, 0); assert.equal(signal, null)
      },
    }
  }
  t.after(async () => {
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL')
      const [exitCode, exitSignal] = await entry.exited
      evidence.children.push({ pid: entry.child.pid, mode: entry.mode, exitCode, exitSignal,
        errors: entry.messages.filter(message => message.kind === 'error'), output: entry.log.join('') })
    }
    evidence.finishedAt = new Date().toISOString()
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' })
    if (process.env.WORKFLOW_CRASH_EVIDENCE_DIR) await writeFile(join(process.env.WORKFLOW_CRASH_EVIDENCE_DIR, name + '.json'),
      JSON.stringify(evidence, null, 2), { flag: 'wx' })
  })
  let cuts = 0
  async function cut(active) {
    const observed = await active.request('inspect')
    await save('before-kill', observed)
    const markerPath = join(directory, 'journal/writer.lock')
    const marker = await readFile(markerPath, 'utf8')
    assert.equal(JSON.parse(marker).pid, active.child.pid)
    assert.equal(active.child.exitCode, null)
    assert.equal(active.child.kill('SIGKILL'), true)
    await active.exited // Owned handle, never a process selected by a reused PID.
    const crashed = await diskView(directory, rootId)
    await save('durable-after-kill', crashed)
    assert.equal(await readFile(markerPath, 'utf8'), marker)
    const blocked = await host('lock-probe')
    assert.equal(blocked.ready.opened, false, 'No automatic stale-lock takeover')
    assert.match(blocked.ready.message, /owned or needs crash recovery/)
    assert.equal((await blocked.exited)[0], 0)
    assert.equal(await readFile(markerPath, 'utf8'), marker)
    assert.equal((await diskView(directory, rootId)).rawSha256, crashed.rawSha256)
    // Explicit test-only recovery after the exact child has exited. Preserve the
    // original owner marker; never delete it and never address a live profile.
    assert.match(relative(await realpath(tmpdir()), await realpath(directory)), /^workflow-crash-matrix-[^\\/]+$/u)
    assert.equal(JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8')).token, token)
    await mkdir(join(directory, 'retired-owner'), { recursive: true })
    const retiredName = ++cuts === 1 ? 'writer.lock' : `writer-${cuts}.lock`
    await rename(markerPath, join(directory, 'retired-owner', retiredName))
    await save('stale-owner-refused-and-explicitly-archived', { pid: active.child.pid, marker: JSON.parse(marker), refusal: blocked.ready })
    return crashed
  }
  async function repeated(cold, expected) {
    await cold.close()
    const stable = await diskView(directory, rootId)
    assert.deepEqual(stable.snapshot, expected.snapshot)
    for (let index = 1; index <= 2; index++) {
      const next = await host('cold')
      assert.deepEqual(next.ready.snapshot, expected.snapshot)
      assert.deepEqual(next.ready.state, expected.state)
      assert.equal(next.ready.requests.length, 0, 'No provider dispatch on restart')
      assert.deepEqual(next.ready.liveAgents.map(agent => agent.id), [rootId], 'Only root is resumed; no child is recreated')
      assert.equal((await diskView(directory, rootId)).rawSha256, stable.rawSha256, 'Restart does not rewrite an already recovered Journal')
      await save('repeat-cold-' + index, next.ready)
      await next.close()
      assert.equal((await diskView(directory, rootId)).rawSha256, stable.rawSha256)
    }
  }
  return { directory, rootId, host, cut, save, repeated }
}
