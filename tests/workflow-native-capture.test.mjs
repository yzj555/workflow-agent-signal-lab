import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { captureNative, launchUrlFromLog, parseLaunchUrl, readEndpoint } from '../scripts/lib/workflow-native-capture.mjs'

const token = 'a'.repeat(43), privateText = 'secret-prompt-path-key-never-export'
const cli = new URL('../scripts/capture-workflow-native.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')
async function fixture(t, options = {}) {
  const requests = [], opens = [], server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: new URL(req.url, origin).pathname, cookie: req.headers.cookie })
    if (req.method === 'GET') {
      if (options.authRedirect) { res.writeHead(303, { location: options.authRedirect }); res.end(); return }
      if (options.authDenied) { res.writeHead(401); res.end(privateText); return }
      res.writeHead(303, { location: '/', 'set-cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return
    }
    assert.equal(req.headers.cookie, cookie)
    let raw = ''; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    assert.equal(request.type, 'client-request')
    assert.equal(req.url, '/api/' + request.method)
    let value
    if (request.method === 'session/list') {
      lists++
      value = { items: (options.roots ?? [{ sessionId: 'root', running: false, title: privateText }]) }
      if (options.changedRoots && lists > 1) value.items = []
    } else if (request.method === 'session/projections') {
      assert.equal(options.newControl, true)
      value = { asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] }, subagentCatalog: [] } }
    } else {
      assert.equal(request.method, 'subagents/list')
      value = { entries: options.catalog?.[request.payload.args.parentSessionId] ?? [] }
    }
    if (options.rpcStatus) { res.writeHead(options.rpcStatus); res.end(privateText); return }
    if (options.largeBody) { res.end('x'.repeat(options.largeBody)); return }
    const envelope = { type: 'server-response', rpcId: options.wrongId ? 'wrong' : request.rpcId,
      result: { ok: !options.rpcRejected, value, error: privateText } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(envelope))
  })
  let lists = 0
  const ws = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/api/remote.mux'); assert.equal(req.headers.cookie, cookie); assert.equal(req.headers.origin, origin)
    ws.handleUpgrade(req, socket, head, s => ws.emit('connection', s))
  })
  ws.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data); opens.push(message)
    assert.equal(message.type, 'open')
    if (message.endpoint === 'job/list') {
      assert.equal(options.newControl, true); assert.deepEqual(message.payload, { args: { request: { sessionId: 'root' } } })
      socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'rows', jobs: [] } }))
      return
    }
    assert.equal(message.endpoint, 'session/control'); assert.deepEqual(message.payload, { args: {} })
    if (options.silentSocket) return
    const baseline = options.baseline ?? (options.newControl
      ? { projections: { root: { asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] }, subagentCatalog: [] } } } }
      : { projections: { root: { values: { title: privateText } } }, queues: { root: [] }, jobs: { root: [] } })
    const frame = { type: options.socketError ? 'error' : 'item', streamId: options.wrongStream ? 'wrong' : message.streamId,
      value: { type: 'baseline', value: baseline }, error: privateText }
    if (options.malformedFrame) socket.send('{not-json')
    else if (options.frameFlood) for (let i = 0; i < 5; i++) socket.send(JSON.stringify({ type: 'opened', streamId: message.streamId }))
    else socket.send(JSON.stringify(frame), { binary: options.binaryFrame ?? false })
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const cookie = 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url') + '=v1.YQ.Yg'
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => ws.close(resolve))
  })
  return { url: origin + '/?token=' + token, requests, opens }
}

test('native capture: only canonical literal loopback launch URLs and read endpoints', () => {
  for (const host of ['127.0.0.1:3080', '[::1]:1234']) assert.equal(parseLaunchUrl('http://' + host + '/?token=' + token).protocol, 'http:')
  for (const value of ['http://localhost:3080/', 'http://127.1/', 'http://2130706433/', 'http://127.0.0.1@evil.test/',
    'http://127.0.0.1:99999/', 'https://127.0.0.1/', 'http://127.0.0.1/api/', 'http://127.0.0.1/?x=1&token=', 'file:///']) {
    assert.throws(() => parseLaunchUrl(value + '?token=' + token), /launch-url-invalid/u)
  }
  assert.equal(launchUrlFromLog('dsh web: http://127.0.0.1:3080/?token=' + token), 'http://127.0.0.1:3080/?token=' + token)
  assert.throws(() => launchUrlFromLog('dsh web: http://127.0.0.1:3080/?token=' + token + '\ndsh web: http://evil.test/'), /launch-url-invalid/u)
  assert.equal(readEndpoint('subagents/list'), '/api/subagents/list')
  for (const method of ['session/prompt', 'session/cancel', 'subagents/spawn', '../session/list']) assert.throws(() => readEndpoint(method), /not-read-only/u)
})

test('native capture: recursive official catalogue is allowlisted and uses real cookie exchange', async t => {
  const f = await fixture(t, { catalog: {
    root: [{ kind: 'child', id: 'child', activity: 'inactive', hasChildren: true, title: privateText }],
    child: [{ kind: 'diagnostic', id: 'old', reason: 'unsupported', detail: privateText }],
  } })
  const report = await captureNative(f.url)
  assert.equal(report.status, 'no-activity-observed'); assert.deepEqual(report.failures, [])
  assert.deepEqual(report.roots, [{ id: 'root', running: false }])
  assert.equal(report.catalog.length, 2); assert.equal(report.catalog.find(item => item.entry.id === 'old').parent, 'child')
  assert.deepEqual(Object.fromEntries(Object.entries(report.resident.queues)), { root: 0 })
  assert.equal(f.opens.length, 1)
  assert.deepEqual(f.requests.map(r => r.method + ' ' + r.path), ['GET /', 'POST /api/session/list', 'POST /api/subagents/list', 'POST /api/subagents/list', 'POST /api/session/list'])
  assert.doesNotMatch(JSON.stringify(report), new RegExp(privateText + '|' + token, 'u'))
})

test('native capture: a child exposed by session/list is not another root or a cycle', async t => {
  const f = await fixture(t, { roots: ['a-grandchild', 'b-child', 'root'].map(sessionId => ({ sessionId, running: false })),
    catalog: {
      root: [{ kind: 'child', id: 'b-child', activity: 'inactive', hasChildren: true }],
      'b-child': [{ kind: 'child', id: 'a-grandchild', activity: 'inactive', hasChildren: false }],
    } })
  const report = await captureNative(f.url)
  assert.equal(report.status, 'no-activity-observed'); assert.deepEqual(report.failures, [])
  assert.deepEqual(report.roots, [{ id: 'root', running: false }])
  assert.ok(report.catalog.every(item => item.root === 'root'))
  assert.equal(f.requests.filter(item => item.path === '/api/subagents/list').length, 3)
})

for (const [name, options] of [
  ['running root', { roots: [{ sessionId: 'root', running: true }] }],
  ['running child', { catalog: { root: [{ kind: 'child', id: 'child', activity: 'running', hasChildren: false }] } }],
  ['queued message', { baseline: { projections: { root: {} }, queues: { root: [{ message: privateText }] }, jobs: { root: [] } } }],
  ['background job', { baseline: { projections: { root: {} }, queues: { root: [] }, jobs: { root: [{ label: privateText }] } } }],
  ['unknown resident', { baseline: { projections: { orphan: {} }, queues: { orphan: [] }, jobs: { orphan: [] } } }],
]) test('native capture: ' + name + ' cannot be reported as quiet', async t => {
  const f = await fixture(t, options), report = await captureNative(f.url)
  assert.equal(report.status, 'needs-attention'); assert.doesNotMatch(JSON.stringify(report), new RegExp(privateText, 'u'))
})

for (const [name, options] of [
  ['denied auth', { authDenied: true }], ['redirected auth', { authRedirect: 'http://example.invalid/' }],
  ['HTTP 200 rejected RPC', { rpcRejected: true }], ['wrong RPC identity', { wrongId: true }], ['RPC redirect', { rpcStatus: 307 }],
  ['incomplete control schema', { baseline: { projections: { root: {} } } }],
  ['missing per-resident job observation', { baseline: { projections: { root: {} }, queues: { root: [] }, jobs: {} } }],
  ['root changed', { changedRoots: true }], ['missing running flag', { roots: [{ sessionId: 'root' }] }],
  ['duplicate roots', { roots: [{ sessionId: 'root', running: false }, { sessionId: 'root', running: false }] }],
  ['cyclic children', { catalog: { root: [{ kind: 'child', id: 'root', activity: 'inactive', hasChildren: true }] } }],
  ['multi-node cycle', { roots: [{ sessionId: 'root', running: false }, { sessionId: 'child', running: false }],
    catalog: { root: [{ kind: 'child', id: 'child', activity: 'inactive', hasChildren: true }], child: [{ kind: 'child', id: 'root', activity: 'inactive', hasChildren: true }] } }],
  ['unclassified child', { catalog: { root: [{ kind: 'child', id: 'child', activity: 'unknown', hasChildren: false }] } }],
  ['wrong stream', { wrongStream: true }], ['malformed frame', { malformedFrame: true }],
  ['binary frame', { binaryFrame: true }], ['error frame', { socketError: true }],
]) test('native capture: ' + name + ' retains explicit incomplete evidence', async t => {
  const f = await fixture(t, options), report = await captureNative(f.url)
  assert.equal(report.status, 'incomplete'); assert.ok(report.failures.length)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(privateText + '|' + token, 'u'))
  if (options.authDenied || options.authRedirect) assert.equal(f.requests.length, 1)
})

test('native capture: response, total traffic, catalogue, frame and time budgets fail closed', async t => {
  for (const [options, limits] of [
    [{ largeBody: 1024 }, { responseBytes: 512 }], [{ largeBody: 1024 }, { totalBytes: 512 }],
    [{ catalog: { root: [{ kind: 'child', id: 'child', activity: 'inactive', hasChildren: false }] } }, { catalog: 0 }],
    [{ frameFlood: true }, { frames: 2 }], [{ silentSocket: true }, { requestMs: 100 }],
    [{ silentSocket: true }, { requestMs: 1000, totalMs: 100 }],
  ]) {
    const f = await fixture(t, options), report = await captureNative(f.url, { limits })
    assert.equal(report.status, 'incomplete'); assert.ok(report.failures.length)
  }
  const f = await fixture(t)
  await assert.rejects(captureNative(f.url, { limits: { outputBytes: 8 } }), /capture-output-limit/u)
})

test('native capture CLI: exclusive output, private console, unchanged log and no network on refused paths', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  const f = await fixture(t, { newControl: manifest.peerDependencies?.['@deepseek-ai/dsh-agent-preset-registry'] === '0.2.0-rc.2' })
  const directory = await mkdtemp(join(tmpdir(), 'workflow-native-cli-'))
  const log = join(directory, 'startup.private.log'), output = join(directory, 'capture.private.json')
  await writeFile(log, 'dsh web: ' + f.url + '\n')
  const before = await readFile(log)
  const run = argv => promisify(execFile)(process.execPath, [cli, ...argv], { timeout: 15000, windowsHide: true })
  const args = ['--startup-log', log, '--output', output]
  const result = await run(args)
  assert.equal(JSON.parse(result.stdout).status, 'no-activity-observed')
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token + '|' + privateText + '|startup.private.log', 'u'))
  assert.deepEqual(await readFile(log), before)
  const saved = await readFile(output), count = f.requests.length
  await assert.rejects(run(args)); assert.equal(f.requests.length, count); assert.deepEqual(await readFile(output), saved)
  const link = join(directory, 'linked.log'); await symlink(log, link, 'file')
  const deniedOutput = join(directory, 'denied.json')
  await assert.rejects(run(['--startup-log', link, '--output', deniedOutput]))
  assert.equal(f.requests.length, count); await assert.rejects(access(deniedOutput), { code: 'ENOENT' })
})

test('release: portable native capture and its exact dependency are in the distribution recipe', async () => {
  const build = await readFile(new URL('../scripts/build-release.mjs', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  assert.equal(manifest.dependencies.ws, '8.21.3')
  assert.ok(build.includes("'scripts/capture-workflow-native.mjs'"))
  assert.ok(build.includes("'scripts/lib/workflow-native-capture.mjs'"))
})
