/** Official loopback read interfaces only. No source checkout, browser or model. */
import { request } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const MiB = 1024 * 1024
export const captureLimits = Object.freeze({ roots: 5000, catalog: 10000, residents: 15000,
  targets: 15000, jobsPerSession: 15000,
  responseBytes: 8 * MiB, totalBytes: 256 * MiB, outputBytes: 8 * MiB,
  frames: 32, requestMs: 15000, totalMs: 120000 })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512
class CaptureError extends Error {
  constructor(code) { super(code); this.code = code }
}
const refuse = code => { throw new CaptureError(code) }

export function parseLaunchUrl(value) {
  // Literal addresses only: no DNS, numeric aliases, userinfo or alternative paths.
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/\?token=[A-Za-z0-9_-]{43}$/u.test(value)) refuse('launch-url-invalid')
  let url
  try { url = new URL(value) } catch { refuse('launch-url-invalid') }
  return url
}

export function launchUrlFromLog(text) {
  const last = [...text.matchAll(/dsh web:\s+(http:\/\/\S+)/gu)].at(-1)?.[1]
  return parseLaunchUrl(last).href
}

/** Deliberately not a general RPC client: new actions require a separate design. */
export function readEndpoint(method) {
  if (!['session/list', 'subagents/list', 'session/projections'].includes(method)) refuse('endpoint-not-read-only')
  return '/api/' + method
}

export function readStreamEndpoint(method) {
  if (!['session/control', 'job/list'].includes(method)) refuse('endpoint-not-read-only')
  return method
}

export function captureHostVersion(value) {
  if (!['0.1.5-rc.1', '0.2.0-rc.2'].includes(value)) refuse('capture-host-version-unsupported')
  return value
}

function rootsFrom(value, limits) {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > limits.roots) refuse('roots-invalid-or-limit')
  const seen = new Set()
  return value.items.map(item => {
    if (!record(item) || !id(item.sessionId) || typeof item.running !== 'boolean' || seen.has(item.sessionId)) refuse('roots-invalid-or-limit')
    seen.add(item.sessionId)
    return { id: item.sessionId, running: item.running }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

function childFrom(entry) {
  if (!record(entry) || !id(entry.id)) refuse('catalog-invalid')
  if (entry.kind === 'diagnostic' && ['corrupt', 'unsupported', 'unavailable'].includes(entry.reason)) {
    return { entry: { kind: 'diagnostic', id: entry.id, reason: entry.reason }, descend: false }
  }
  if (entry.kind !== 'child' || !['running', 'inactive'].includes(entry.activity) || typeof entry.hasChildren !== 'boolean') refuse('catalog-invalid')
  return { entry: { kind: 'child', id: entry.id, activity: entry.activity }, descend: entry.hasChildren }
}

function residentFrom(value, limits) {
  if (!record(value) || !record(value.projections) || !record(value.queues) || !record(value.jobs)) refuse('control-baseline-incompatible')
  const ids = Object.keys(value.projections).sort(), queues = Object.create(null), jobCounts = Object.create(null)
  if (ids.length > limits.residents || ids.some(key => !id(key))
    || JSON.stringify(Object.keys(value.queues).sort()) !== JSON.stringify(ids)
    || JSON.stringify(Object.keys(value.jobs).sort()) !== JSON.stringify(ids)) refuse('control-baseline-incompatible')
  for (const key of ids) {
    if (!Array.isArray(value.queues[key]) || !Array.isArray(value.jobs[key])) refuse('control-baseline-incompatible')
    // Retain counts, never inbox messages, job labels, details or projections.
    queues[key] = value.queues[key].length
    jobCounts[key] = value.jobs[key].length
  }
  return { observedAt: new Date().toISOString(), ids, queues, jobCounts }
}

function inboxFrom(value) {
  if (!record(value) || !Number.isSafeInteger(value.asOfSeq) || value.asOfSeq < 0 || !record(value.values)
    || !record(value.values.inbox) || !Array.isArray(value.values.inbox['next-turn'])
    || !Array.isArray(value.values.inbox['next-step'])) refuse('inbox-projection-incompatible')
  const inbox = value.values.inbox
  const catalog = catalog020(value)
  // Never retain message contents. The digest detects replacement at equal counts.
  return { asOfSeq: value.asOfSeq, nextTurn: inbox['next-turn'].length, nextStep: inbox['next-step'].length,
    fingerprint: createHash('sha256').update(JSON.stringify(inbox)).digest('hex'),
    catalogFingerprint: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') }
}

function catalog020(value) {
  const catalog = value?.values?.subagentCatalog
  if (!Array.isArray(catalog)) refuse('catalog-projection-incompatible')
  return catalog.map(entry => {
    if (!record(entry) || !id(entry.id) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
      || !['one-shot', 'continuable', 'unknown'].includes(entry.mode)
      || (entry.mode === 'continuable' && typeof entry.label !== 'string')) refuse('catalog-projection-incompatible')
    return { id: entry.id, createdAt: entry.createdAt, mode: entry.mode }
  })
}

function resident020(value, limits) {
  if (!record(value) || !record(value.projections) || Object.hasOwn(value, 'queues') || Object.hasOwn(value, 'jobs')) refuse('control-baseline-incompatible')
  const ids = Object.keys(value.projections).sort(), queues = Object.create(null), inbox = Object.create(null)
  if (ids.length > limits.residents || ids.some(key => !id(key))) refuse('control-baseline-incompatible')
  for (const key of ids) {
    inbox[key] = inboxFrom(value.projections[key])
    queues[key] = inbox[key].nextTurn + inbox[key].nextStep
  }
  return { observedAt: new Date().toISOString(), ids, queues, jobCounts: Object.create(null), inbox }
}

function jobsFrom(value, sessionId, limits) {
  if (!record(value) || value.type !== 'rows' || !Array.isArray(value.jobs) || value.jobs.length > limits.jobsPerSession) refuse('job-roster-incompatible-or-limit')
  const seen = new Set(), rows = []
  let active = 0
  for (const job of value.jobs) {
    if (!record(job) || !id(job.id) || seen.has(job.id)
      || !['running', 'stopping', 'completed', 'killed', 'failed'].includes(job.status)
      || (job.owner !== undefined && job.owner !== sessionId)) refuse('job-roster-incompatible-or-limit')
    seen.add(job.id)
    if (job.status === 'running' || job.status === 'stopping') active++
    rows.push({ id: job.id, owner: job.owner ?? null, status: job.status })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return { active, total: rows.length, fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}

export async function captureNative(launchUrl, options = {}) {
  const dsh = captureHostVersion(options.dsh ?? '0.1.5-rc.1'), declarative = dsh === '0.2.0-rc.2'
  const url = parseLaunchUrl(launchUrl)
  const limits = { ...captureLimits, ...options.limits }
  const signal = AbortSignal.timeout(limits.totalMs)
  const report = { schemaVersion: 1, producer: 'workflow-native-capture-v1', mode: 'read-only',
    private: true, startedAt: new Date().toISOString(), checkedAt: null, status: 'incomplete',
    roots: [], catalog: [], failures: [], resident: { ids: [], queues: {}, jobCounts: {} } }
  if (declarative) {
    report.expectedDsh = dsh
    report.observation = { kind: 'visible-session-rosters', atomic: false, wholeHostJobsProven: false,
      processExitProven: false, hostVersionVerified: false, restartPermission: false, rounds: 2, targets: [] }
  }
  let cookie, bytes = 0
  const failures = new Set()
  const failure = (phase, error) => {
    const code = error instanceof CaptureError ? error.code : signal.aborted ? 'capture-timeout' : 'transport-failed'
    const key = phase + ':' + code
    if (!failures.has(key)) { failures.add(key); report.failures.push({ phase, code }) }
  }
  const addBytes = count => { bytes += count; if (bytes > limits.totalBytes) refuse('transport-byte-limit') }
  async function http(target, method, body) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.requestMs)])
    return new Promise((resolveResult, reject) => {
      let settled = false
      const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolveResult(value) }
      const headers = { accept: 'application/json', ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) }
      const req = request(target, { method, headers, signal: requestSignal }, res => {
        const chunks = []; let count = 0
        res.on('data', chunk => {
          try {
            count += chunk.length; addBytes(chunk.length)
            if (count > limits.responseBytes) refuse('response-byte-limit')
            chunks.push(chunk)
          } catch (error) { finish(error); res.destroy(); req.destroy() }
        })
        res.on('error', error => finish(error))
        res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', error => finish(error))
      req.end(body)
    })
  }
  async function rpc(method, args) {
    const rpcId = randomUUID()
    const result = await http(new URL(readEndpoint(method), url.origin), 'POST',
      JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }))
    if (result.status !== 200) refuse('rpc-http-rejected')
    let envelope
    try { envelope = JSON.parse(result.body) } catch { refuse('rpc-envelope-invalid') }
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) refuse('rpc-envelope-invalid')
    return envelope.result.value
  }
  async function stream(endpoint, args, consume) {
    readStreamEndpoint(endpoint)
    const phase = endpoint === 'job/list' ? 'job' : 'control'
    return new Promise((resolveResult, reject) => {
      const streamId = randomUUID()
      const socket = new WebSocket(url.origin.replace('http:', 'ws:') + '/api/remote.mux', {
        headers: { cookie, origin: url.origin }, followRedirects: false,
        maxPayload: limits.responseBytes, handshakeTimeout: limits.requestMs,
      })
      let settled = false, frames = 0
      const finish = (error, value) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort)
        // Closing this observer releases only its stream; it never cancels an Agent.
        socket.terminate()
        error ? reject(error) : resolveResult(value)
      }
      const onAbort = () => finish(new CaptureError('capture-timeout'))
      const timer = setTimeout(() => finish(new CaptureError(phase + '-timeout')), limits.requestMs)
      socket.on('error', () => finish(new CaptureError(phase + '-transport-failed')))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      socket.on('close', () => finish(new CaptureError(phase + '-closed-before-baseline')))
      socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })))
      socket.on('message', (data, binary) => {
        if (settled) return
        try {
          addBytes(data.length)
          if (binary || ++frames > limits.frames) refuse('control-frame-invalid-or-limit')
          let frame
          try { frame = JSON.parse(data.toString()) } catch { refuse('control-frame-invalid-or-limit') }
          if (!record(frame) || frame.streamId !== streamId) refuse('control-frame-invalid-or-limit')
          if (frame.type === 'opened') return
          if (frame.type !== 'item') refuse('control-baseline-missing')
          finish(null, consume(frame.value))
        } catch (error) { finish(error) }
      })
    })
  }
  const baseline = () => stream('session/control', {}, value => {
    if (value?.type !== 'baseline') refuse('control-baseline-missing')
    return declarative ? resident020(value.value, limits) : residentFrom(value.value, limits)
  })
  try {
    // Use the official GET exchange; never mint a cookie or read the signing secret.
    const auth = await http(url, 'GET')
    const name = 'dsh-auth-' + createHash('sha256').update(url.host).digest('base64url')
    const cookies = auth.headers['set-cookie']
    if (auth.status !== 303 || !['/', './'].includes(auth.headers.location)
      || !Array.isArray(cookies) || cookies.length !== 1 || cookies[0].length > 8192) refuse('authentication-rejected')
    cookie = cookies[0].split(';')[0]
    if (!cookie.startsWith(name + '=') || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(cookie.slice(name.length + 1))) refuse('authentication-rejected')
    const first = rootsFrom(await rpc('session/list', { _request: {} }), limits)
    report.roots = first
    const entries = new Set(), visited = new Set(), catalogCuts = new Map()
    let queue = first.map(item => ({ parent: item.id, root: item.id }))
    while (queue.length && !signal.aborted) {
      const batch = queue.splice(0, 8)
      await Promise.all(batch.map(async item => {
        // Official session/list may also expose a child. Query each parent once;
        // derive roots from the independently observed catalogue edges afterward.
        if (visited.has(item.parent)) return
        visited.add(item.parent)
        try {
          const value = declarative
            ? await rpc('session/projections', { request: { sessionId: item.parent } })
            : await rpc('subagents/list', { parentSessionId: item.parent })
          if (!declarative && (!record(value) || !Array.isArray(value.entries))) refuse('catalog-invalid')
          const children = declarative ? catalog020(value) : value.entries
          if (declarative) catalogCuts.set(item.parent, inboxFrom(value))
          for (const raw of children) {
            if (report.catalog.length >= limits.catalog) refuse('catalog-limit')
            const child = declarative ? { entry: raw.mode === 'unknown'
              ? { kind: 'diagnostic', id: raw.id, reason: 'unsupported' }
              : { kind: 'child', id: raw.id, activity: first.find(item => item.id === raw.id)?.running ? 'running' : 'inactive' }, descend: true }
              : childFrom(raw)
            if (item.parent === child.entry.id || entries.has(child.entry.id)) refuse('catalog-duplicate-or-cycle')
            entries.add(child.entry.id)
            report.catalog.push({ parent: item.parent, root: item.root, entry: child.entry })
            if (child.descend) queue.push({ parent: child.entry.id, root: item.root })
          }
        } catch (error) { failure('catalog', error) }
      }))
    }
    if (signal.aborted) refuse('capture-timeout')
    try { report.resident = await baseline() } catch (error) { failure('control', error) }
    if (declarative) {
      const targets = [...new Set([...first.map(item => item.id), ...report.resident.ids,
        ...entries])].sort()
      if (targets.length > limits.targets) refuse('observation-target-limit')
      report.observation.targets = targets
      // No synthetic Session id: an empty roster cannot prove the unowned job bucket empty.
      if (!targets.length) failure('jobs', new CaptureError('job-coverage-empty'))
      const previous = new Map(), inbox = Object.create(null), jobs = Object.create(null)
      for (let round = 0; round < 2; round++) {
        for (let start = 0; start < targets.length; start += 8) {
          signal.throwIfAborted()
          await Promise.all(targets.slice(start, start + 8).map(async sessionId => {
            try {
              const pending = inboxFrom(await rpc('session/projections', { request: { sessionId } }))
              if (JSON.stringify(catalogCuts.get(sessionId)) !== JSON.stringify(pending) && catalogCuts.has(sessionId)) failure('catalog', new CaptureError('catalog-changed-during-capture'))
              const roster = await stream('job/list', { request: { sessionId } }, value => jobsFrom(value, sessionId, limits))
              const current = { inbox: pending, jobs: roster }
              if (round && JSON.stringify(previous.get(sessionId)) !== JSON.stringify(current)) failure('observations', new CaptureError('session-observation-changed'))
              if (!round) previous.set(sessionId, current)
              inbox[sessionId] = pending; jobs[sessionId] = roster
              report.resident.queues[sessionId] = pending.nextTurn + pending.nextStep
              report.resident.jobCounts[sessionId] = roster.active
            } catch (error) { failure('observations', error) }
          }))
        }
      }
      try {
        const final = await baseline()
        if (JSON.stringify(final.ids) !== JSON.stringify(report.resident.ids)
          || JSON.stringify(final.inbox) !== JSON.stringify(report.resident.inbox)) failure('control', new CaptureError('control-changed-during-capture'))
        for (const sessionId of final.ids) {
          if (JSON.stringify(final.inbox[sessionId]) !== JSON.stringify(inbox[sessionId])) failure('control', new CaptureError('inbox-changed-during-capture'))
        }
      } catch (error) { failure('control', error) }
      report.resident.inbox = inbox; report.resident.jobObservations = jobs
    }
    const latest = rootsFrom(await rpc('session/list', { _request: {} }), limits)
    if (JSON.stringify(latest) !== JSON.stringify(first)) failure('roots', new CaptureError('roots-changed-during-capture'))
    report.roots = latest.filter(item => !entries.has(item.id))
    const parents = new Map(report.catalog.map(item => [item.entry.id, item.parent]))
    for (const item of report.catalog) {
      let ancestor = item.parent
      const chain = new Set([item.entry.id])
      while (parents.has(ancestor)) {
        if (chain.has(ancestor)) { failure('catalog', new CaptureError('catalog-cycle')); break }
        chain.add(ancestor); ancestor = parents.get(ancestor)
      }
      item.root = ancestor
    }
    report.catalog.sort((a, b) => a.entry.id.localeCompare(b.entry.id))
    const known = new Set([...report.roots.map(item => item.id), ...report.catalog.filter(item => item.entry.kind === 'child').map(item => item.entry.id)])
    const busy = first.some(item => item.running) || latest.some(item => item.running)
      || report.catalog.some(item => item.entry.kind === 'child' && item.entry.activity === 'running')
      || report.resident.ids.some(key => !known.has(key))
      || Object.values(report.resident.queues).some(count => count > 0)
      || Object.values(report.resident.jobCounts).some(count => count > 0)
    report.status = report.failures.length ? 'incomplete' : busy ? 'needs-attention' : 'no-activity-observed'
  } catch (error) { failure('capture', error) }
  report.checkedAt = new Date().toISOString()
  report.transportBytes = bytes
  if (Buffer.byteLength(JSON.stringify(report, null, 2) + '\n') > limits.outputBytes) refuse('capture-output-limit')
  return report
}
