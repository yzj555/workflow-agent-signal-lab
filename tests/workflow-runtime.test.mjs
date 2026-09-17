import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import Sessions from '@deepseek-ai/dsh-session'
import * as RuntimePlugin from '../lib/workflow-runtime.js'
import { readWorkflowSnapshot } from '../lib/workflow-source.js'
import { fixture } from './helpers/workflow-fixture.mjs'

const { openWorkflowStorage, acquireWorkflowOwner } = RuntimePlugin
const requireOfficial = createRequire(import.meta.url)
// Test-only: execute the installed official browser caller, with an HTTP base override.
const connectionRoot = dirname(requireOfficial.resolve('@deepseek-ai/dsh-client-connection'))
const { createWebConnectionRpc } = await import(pathToFileURL(join(connectionRoot, 'types/client/rpc.js')).href)
const executeFile = promisify(execFile)
const childPath = fileURLToPath(new URL('./helpers/workflow-owner-child.mjs', import.meta.url))
const options = { timeout: 15_000 }
const temporaryDirectory = () => mkdtemp(join(tmpdir(), 'workflow-journal-test-'))

test('runtime declares every capability required by dedicated Connection RPC routes', () => {
  assert.deepEqual(RuntimePlugin.inject, ['connection', 'webServer'])
})

test('official SQLite + storageDomain recovers the exact committed view in a fresh Node process', options, async t => {
  const directory = await temporaryDirectory()
  const runtime = await openWorkflowStorage(directory)
  t.after(() => runtime.close())
  const f = fixture()
  const expected = await runtime.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0,
    events: [...f.initial(), f.approve(), f.readyTask(), f.runTask(), f.assign()] })
  await runtime.close()
  const { stdout } = await executeFile(process.execPath, [childPath, directory, 'read', f.rootSessionId], { windowsHide: true, timeout: 10_000 })
  assert.deepEqual(JSON.parse(stdout), expected)
  await assert.rejects(access(join(directory, 'writer.lock')))
})

test('two independent Node processes racing for one store produce exactly one owner', options, async t => {
  const directory = await temporaryDirectory()
  const children = [0, 1].map(() => fork(childPath, [directory, 'hold'], { silent: true, windowsHide: true }))
  const exits = children.map(child => once(child, 'exit'))
  const opened = new Set()
  const replies = children.map(child => once(child, 'message').then(([message]) => {
    if (message.kind === 'opened') opened.add(child)
    return message
  }))
  let closing
  const closeChildren = () => closing ??= (async () => {
    // A rejected child closes its IPC channel itself; child.connected may
    // briefly lag behind that close. Only the owner needs a shutdown message.
    await Promise.all([...opened].map(child => new Promise((resolve, reject) => {
      child.send('close', error => error ? reject(error) : resolve())
    })))
    return Promise.all(exits)
  })()
  t.after(closeChildren)
  const messages = await Promise.all(replies)
  assert.equal(messages.filter(message => message.kind === 'opened').length, 1)
  assert.equal(messages.filter(message => message.kind === 'rejected' && /owned|recovery/.test(message.message)).length, 1)
  const outcomes = await closeChildren()
  messages.forEach((message, index) => {
    assert.equal(outcomes[index][0], message.kind === 'opened' ? 0 : 2)
    assert.equal(outcomes[index][1], null)
  })
  const next = await openWorkflowStorage(directory)
  await next.close()
})

test('stale or malformed owner markers are never automatically replaced', options, async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'writer.lock')
  await writeFile(path, 'unverifiable previous owner', 'utf8')
  await assert.rejects(openWorkflowStorage(directory), /owned or needs crash recovery/)
  assert.equal(await readFile(path, 'utf8'), 'unverifiable previous owner')
})

test('release refuses to delete a changed owner marker', options, async () => {
  const directory = await temporaryDirectory()
  const owner = await acquireWorkflowOwner(directory)
  const path = join(directory, 'writer.lock')
  await writeFile(path, 'different owner', 'utf8')
  await assert.rejects(owner.release(), /owner changed/)
  assert.equal(await readFile(path, 'utf8'), 'different owner')
})

test('real SQLite busy failure publishes no advance and requires recovery', options, async t => {
  const directory = await temporaryDirectory()
  const runtime = await openWorkflowStorage(directory)
  t.after(() => runtime.close())
  const f = fixture()
  const before = await runtime.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  const external = new DatabaseSync(join(directory, 'journal.sqlite'))
  let changes = 0
  runtime.journal.subscribe(() => changes++)
  try {
    external.exec('BEGIN IMMEDIATE')
    await assert.rejects(runtime.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: before.revision, events: [f.approve()] }), error => error.code === 'recovery-required')
    assert.equal(changes, 0)
    assert.throws(() => runtime.journal.readSnapshot(f.rootSessionId), /reopen and verify/)
  } finally { external.exec('ROLLBACK'); external.close() }
  await runtime.close()
  const recovered = await openWorkflowStorage(directory)
  try { assert.deepEqual(recovered.journal.readSnapshot(f.rootSessionId), before) }
  finally { await recovered.close() }
})

test('unknown on-disk workflow schema fails cold open instead of resetting the run', options, async t => {
  const directory = await temporaryDirectory()
  const runtime = await openWorkflowStorage(directory)
  t.after(() => runtime.close())
  const f = fixture()
  await runtime.journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: [f.created()] })
  await runtime.close()
  const db = new DatabaseSync(join(directory, 'journal.sqlite'))
  const row = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?').get(f.rootSessionId)
  const invalid = JSON.parse(row.value); invalid.schemaVersion = 99
  db.prepare('UPDATE u_workflow_runtime_sessions SET value = ? WHERE key = ?').run(JSON.stringify(invalid), f.rootSessionId)
  db.close()
  await assert.rejects(openWorkflowStorage(directory), /does not match its schema/)
  const reopened = new DatabaseSync(join(directory, 'journal.sqlite'))
  try { assert.equal(JSON.parse(reopened.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?').get(f.rootSessionId).value).schemaVersion, 99) }
  finally { reopened.close() }
})

async function httpRuntime(t) {
  const directory = await temporaryDirectory()
  const ctx = new Context()
  const routes = new Map()
  await ctx.plugin({ name: 'fixture-web-server', apply(webCtx) {
    webCtx.provide('webServer', { register(route) {
      if (routes.has(route.path)) throw new Error('duplicate test route')
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    } })
  } })
  // Browser authentication belongs to Connection and is exercised by the real
  // isolated Web-profile smoke test. This focused carrier fixture supplies an
  // authenticated browser while retaining the official Host/Origin trust fence.
  // Keep both providers in independent fibers so route ownership exercises the
  // same caller-context tracing used by a loader-started Web profile.
  await ctx.plugin({ name: 'fixture-connection', apply(connectionCtx) {
    new HostConnectionService(connectionCtx, [], {
      isAuthenticated: () => true,
      authorizeIndex: () => true,
      authenticatedUrl: value => value,
    })
  } })
  await ctx.plugin(Sessions)
  await ctx.plugin(RuntimePlugin, { dataDirectory: directory })
  const server = createServer((request, response) => {
    const route = [...routes.values()].find(item => request.url.startsWith(item.path + '/'))
    if (!route) { response.writeHead(404); response.end(); return }
    Promise.resolve(route.handler(request, response)).catch(error => { response.writeHead(500); response.end(String(error)) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const rpc = createWebConnectionRpc((input, init) => fetch(new URL(new URL(input).pathname, origin), init))
  return { ctx, directory, origin, rpc, routes }
}

test('official Host+Client Connection round-trips a committed snapshot over real loopback HTTP', options, async t => {
  const { ctx, rpc } = await httpRuntime(t)
  const f = fixture()
  const native = ctx.sessions.create()
  const journal = ctx.get('workflowJournal')
  const before = await readWorkflowSnapshot(rpc, f.rootSessionId)
  assert.equal(before.availability, 'absent')
  const expected = await journal.commit({ rootSessionId: f.rootSessionId, expectedRevision: 0, events: f.initial() })
  assert.deepEqual(await readWorkflowSnapshot(rpc, f.rootSessionId), expected)
  assert.equal(native.snapshotEvents().length, 0)
  assert.equal(ctx.get('tools'), undefined)
  const forbidden = await rpc.call('/workflow-runtime', 'commit', { events: [f.approve()] })
  assert.equal(forbidden.ok, false)
  assert.equal(journal.readSnapshot(f.rootSessionId).revision, expected.revision)
})

test('read channel rejects cross-site requests through the official trust fence', options, async t => {
  const { origin } = await httpRuntime(t)
  for (const headers of [
    { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example' },
  ]) {
    // Use node:http so a forged Host header actually reaches the server;
    // fetch implementations may normalize it back to the URL authority.
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/workflow-runtime/snapshot`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)) })
      request.once('error', reject)
      request.end(JSON.stringify({ type: 'client-request', rpcId: 'trust-test', method: 'snapshot', payload: { schemaVersion: 1, rootSessionId: 'session-a' } }))
    })
    assert.equal(status, 403, JSON.stringify(headers))
  }
})

test('bad schema requests and mismatched client snapshots fail without creating records', options, async t => {
  const { ctx, rpc } = await httpRuntime(t)
  const request = await rpc.call('/workflow-runtime', 'snapshot', { schemaVersion: 2, rootSessionId: 'session-a', extra: true })
  assert.equal(request.ok, false)
  const absent = ctx.get('workflowJournal').readSnapshot('session-a')
  await assert.rejects(readWorkflowSnapshot({ call: async () => ({ ok: true, value: { ...absent, rootSessionId: 'foreign' } }) }, 'session-a'), /another root Session/)
  await assert.rejects(readWorkflowSnapshot({ call: async () => ({ ok: true, value: { ...absent, source: 'text-guess' } }) }, 'session-a'))
  assert.equal(absent.revision, 0)
})

test('unloading the plugin removes the read channel and releases the writer', options, async t => {
  const { ctx, directory, routes, origin } = await httpRuntime(t)
  await ctx.fiber.dispose()
  assert.equal(routes.size, 0)
  assert.equal((await fetch(`${origin}/workflow-runtime/snapshot`, { method: 'POST' })).status, 404)
  await assert.rejects(access(join(directory, 'writer.lock')))
  const again = await openWorkflowStorage(directory)
  await again.close()
})
