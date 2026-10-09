import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { captureNative, captureHostVersion, readEndpoint, readStreamEndpoint } from '../scripts/lib/workflow-native-capture.mjs'

const dsh = '0.2.0-rc.2', secret = 'prompt-job-output-private-never-export'
const projection = (nextTurn = [], nextStep = [], seq = 0) => ({ asOfSeq: seq,
  values: { inbox: { 'next-turn': nextTurn, 'next-step': nextStep }, subagentCatalog: [], title: secret } })
const job = (status = 'running', owner = 'root', id = 'bash-1') => ({ id, ...(owner === null ? {} : { owner }), status,
  label: secret, progress: secret, detail: secret, output: { total: 10, earliest: 0, spillPaths: [secret] } })

async function fixture(t, options = {}) {
  const requests = [], opens = [], projectionReads = new Map(), rosterReads = new Map()
  let controlReads = 0
  const roots = options.roots ?? [{ sessionId: 'root', running: false }]
  const defaultProjection = options.pending ?? projection()
  const resident = options.resident ?? { root: options.catalog
    ? { ...defaultProjection, values: { ...defaultProjection.values, subagentCatalog:
      (options.catalog.root ?? []).map(entry => ({ id: entry.id, createdAt: 0, mode: 'one-shot' })) } }
    : defaultProjection }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname
    requests.push({ method: req.method, path })
    if (req.method === 'GET') {
      res.writeHead(303, { location: '/', 'set-cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return
    }
    assert.equal(req.headers.cookie, cookie)
    let raw = ''; for await (const part of req) raw += part
    const request = JSON.parse(raw), args = request.payload.args
    assert.equal(path, '/api/' + request.method)
    let value
    if (request.method === 'session/list') value = { items: roots }
    else {
      assert.equal(request.method, 'session/projections')
      assert.deepEqual(Object.keys(args), ['request'])
      const sessionId = args.request.sessionId
      const count = (projectionReads.get(sessionId) ?? 0) + 1; projectionReads.set(sessionId, count)
      value = options.projectionRead?.(sessionId, count) ?? defaultProjection
      if (options.catalog) value = { ...value, values: { ...value.values, subagentCatalog:
        (options.catalog[sessionId] ?? []).map(entry => ({ id: entry.id, createdAt: 0, mode: 'one-shot' })) } }
    }
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
  })
  const ws = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/api/remote.mux'); assert.equal(req.headers.cookie, cookie); assert.equal(req.headers.origin, origin)
    ws.handleUpgrade(req, socket, head, s => ws.emit('connection', s))
  })
  ws.on('connection', socket => socket.on('message', data => {
    const open = JSON.parse(data); opens.push(open)
    assert.equal(open.type, 'open')
    let value
    if (open.endpoint === 'session/control') {
      assert.deepEqual(open.payload.args, {}); controlReads++
      value = { type: 'baseline', value: options.controlRead?.(controlReads) ?? { projections: resident } }
    } else {
      assert.equal(open.endpoint, 'job/list')
      assert.deepEqual(Object.keys(open.payload.args), ['request'])
      const { sessionId } = open.payload.args.request
      const count = (rosterReads.get(sessionId) ?? 0) + 1; rosterReads.set(sessionId, count)
      if (options.jobError) { socket.send(JSON.stringify({ type: 'error', streamId: open.streamId, error: secret })); return }
      if (options.jobSilent) return
      value = options.rosterRead?.(sessionId, count) ?? { type: 'rows', jobs: options.jobs ?? [] }
    }
    socket.send(JSON.stringify({ type: 'opened', streamId: open.streamId }))
    socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value }))
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const cookie = 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url') + '=v1.YQ.Yg'
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => ws.close(resolve))
  })
  return { url: origin + '/?token=' + 'a'.repeat(43), requests, opens, projectionReads, rosterReads }
}

test('capture 0.2: exact contract and read-only endpoint whitelist refuse mutations and unknown versions', () => {
  assert.equal(captureHostVersion(dsh), dsh)
  assert.equal(captureHostVersion('0.1.5-rc.1'), '0.1.5-rc.1')
  for (const value of [undefined, '0.2', '0.3.0', 2]) assert.throws(() => captureHostVersion(value), /unsupported/u)
  assert.equal(readEndpoint('session/projections'), '/api/session/projections')
  assert.equal(readStreamEndpoint('job/list'), 'job/list')
  for (const endpoint of ['job/kill', 'job/follow', 'session/prompt', 'session/cancel', 'subagents/spawn']) {
    assert.throws(() => readEndpoint(endpoint), /not-read-only/u)
    assert.throws(() => readStreamEndpoint(endpoint), /not-read-only/u)
  }
})

test('capture 0.2: independently reads inbox and job rosters twice without retaining private contents', async t => {
  const f = await fixture(t), report = await captureNative(f.url, { dsh })
  assert.equal(report.status, 'no-activity-observed'); assert.deepEqual(report.failures, [])
  assert.equal(report.resident.queues.root, 0); assert.equal(report.resident.jobCounts.root, 0)
  assert.equal(f.projectionReads.get('root'), 3); assert.equal(f.rosterReads.get('root'), 2)
  assert.equal(f.opens.filter(open => open.endpoint === 'session/control').length, 2)
  assert.equal(report.observation.wholeHostJobsProven, false)
  assert.equal(report.expectedDsh, dsh); assert.equal(report.observation.hostVersionVerified, false)
  assert.equal(report.observation.processExitProven, false); assert.equal(report.observation.restartPermission, false)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
  assert.ok(f.requests.every(item => ['GET /', 'POST /api/session/list', 'POST /api/session/projections'].includes(item.method + ' ' + item.path)))
})

for (const [name, options] of [
  ['next-turn input', { pending: projection([{ text: secret }]) }],
  ['next-step input', { pending: projection([], [{ text: secret }]) }],
  ['running owned job', { jobs: [job()] }],
  ['stopping owned job', { jobs: [job('stopping')] }],
  ['running unowned job', { jobs: [job('running', null)] }],
]) test('capture 0.2: ' + name + ' is not quiet', async t => {
  const f = await fixture(t, options), report = await captureNative(f.url, { dsh })
  assert.equal(report.status, 'needs-attention'); assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
})

test('capture 0.2: known terminal jobs are observed but do not count as live; no exit proof is inferred', async t => {
  const f = await fixture(t, { jobs: ['completed', 'killed', 'failed'].map((status, i) => job(status, 'root', 'bash-' + i)) })
  const report = await captureNative(f.url, { dsh })
  assert.equal(report.status, 'no-activity-observed'); assert.equal(report.resident.jobCounts.root, 0)
  assert.equal(report.resident.jobObservations.root.total, 3); assert.equal(report.observation.processExitProven, false)
})

for (const [name, options] of [
  ['missing inbox', { resident: { root: { asOfSeq: 0, values: {} } } }],
  ['malformed inbox', { pending: { asOfSeq: 0, values: { inbox: { 'next-turn': [] } } } }],
  ['wrong watermark', { pending: { ...projection(), asOfSeq: -1 } }],
  ['unknown job status', { jobs: [job('unknown')] }],
  ['foreign-owned job', { jobs: [job('running', 'other')] }],
  ['duplicate jobs', { jobs: [job(), job()] }],
  ['job API rejected', { jobError: true }],
  ['wrong roster type', { rosterRead: () => ({ type: 'delta', jobs: [] }) }],
  ['equal-count inbox replacement', { projectionRead: (_id, count) => projection([{ text: count === 1 ? secret : 'other' }]) }],
  ['equal-count job replacement', { rosterRead: (_id, count) => ({ type: 'rows', jobs: [job('running', 'root', 'bash-' + count)] }) }],
  ['control resident drift', { controlRead: count => ({ projections: count === 1 ? { root: projection() } : {} }) }],
  ['legacy shape under new contract', { controlRead: () => ({ projections: { root: projection() }, queues: {}, jobs: {} }) }],
  ['no Session for a fenced job read', { roots: [], resident: {} }],
]) test('capture 0.2: ' + name + ' is explicit incomplete evidence', async t => {
  const f = await fixture(t, options), report = await captureNative(f.url, { dsh })
  assert.equal(report.status, 'incomplete'); assert.ok(report.failures.length)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, 'u'))
})

test('capture 0.2: cold roots and catalogue children are both observed without creating a Session', async t => {
  const f = await fixture(t, { roots: [{ sessionId: 'root', running: false }, { sessionId: 'cold', running: false }],
    catalog: { root: [{ kind: 'child', id: 'child', activity: 'inactive', hasChildren: false }] } })
  const report = await captureNative(f.url, { dsh })
  assert.equal(report.status, 'no-activity-observed')
  assert.deepEqual(report.observation.targets, ['child', 'cold', 'root'])
  for (const sessionId of report.observation.targets) {
    assert.equal(f.projectionReads.get(sessionId), 3); assert.equal(f.rosterReads.get(sessionId), 2)
  }
})

test('capture 0.2: per-roster, target, request and total budgets fail closed', async t => {
  for (const [options, limits] of [
    [{ jobs: [job()] }, { jobsPerSession: 0 }], [{}, { targets: 0 }],
    [{ jobSilent: true }, { requestMs: 40 }], [{ jobSilent: true }, { totalMs: 80, requestMs: 200 }],
  ]) {
    const f = await fixture(t, options), report = await captureNative(f.url, { dsh, limits })
    assert.equal(report.status, 'incomplete'); assert.ok(report.failures.length)
  }
})
