/** Isolated, bounded performance evidence. Never boots DSH or uses live data. */
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir, cpus, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export function parseBenchmarkArgs(args) {
  const allowed = new Set(['output', 'duration-ms', 'events', 'roots', 'history-bytes', 'mode'])
  const values = new Map()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2), value = args[i + 1]
    if (!args[i]?.startsWith('--') || !allowed.has(key) || value === undefined || values.has(key)) throw new Error('Invalid benchmark options')
    values.set(key, value)
  }
  const integer = (key, fallback, min, max) => {
    const raw = values.get(key) ?? String(fallback)
    if (!/^\d+$/u.test(raw)) throw new Error('Invalid benchmark number')
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Benchmark number outside isolated limits')
    return value
  }
  const output = values.get('output'), mode = values.get('mode') ?? 'workflow'
  if (!output || !isAbsolute(output) || !['workflow', 'native'].includes(mode)) throw new Error('Absolute new output directory and supported mode required')
  const result = { output: resolve(output), mode, durationMs: integer('duration-ms', 60000, 1000, 1800000),
    events: integer('events', 1000, 100, 8800), roots: integer('roots', 2, 1, 4), historyBytes: integer('history-bytes', 0, 0, 13 * 1024 * 1024) }
  if (result.events % 2) throw new Error('Even event count required')
  return result
}

export async function benchmark(options) {
  await mkdir(options.output) // Exclusive; evidence cannot overwrite a previous run.
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'workflow-benchmark-'))
  const token = randomUUID()
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ token, ...options }), { flag: 'wx' })
  const startedAt = new Date().toISOString()
  const child = fork(fileURLToPath(new URL('../tests/helpers/workflow-performance-worker.mjs', import.meta.url)), [directory, token], { silent: true, windowsHide: true })
  let result, stdout = '', stderr = '', evidenceBytes = 0, forcedStop = false
  const bound = chunk => { evidenceBytes += Buffer.byteLength(chunk); if (evidenceBytes > 4 * 1024 * 1024) { forcedStop = true; child.kill(); return false } return true }
  child.stdout.on('data', chunk => { if (bound(chunk)) stdout += String(chunk) })
  child.stderr.on('data', chunk => { if (bound(chunk)) stderr += String(chunk) })
  child.on('message', message => {
    if (message?.kind === 'progress') console.log(JSON.stringify({ mode: options.mode, elapsedMs: message.elapsedMs, plannedMs: options.durationMs }))
    if (message?.kind === 'result') result = message.result
  })
  // Only our exact child handle may be stopped. Never select by process name or port.
  const fuse = setTimeout(() => { forcedStop = true; child.kill() }, options.durationMs + 180000)
  const exit = await new Promise(resolve => {
    child.once('error', () => resolve({ code: null, signal: null, launchFailed: true }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(fuse)
  const receipt = { schemaVersion: 1, kind: 'isolated-component-benchmark', startedAt, finishedAt: new Date().toISOString(),
    status: !forcedStop && exit.code === 0 && result?.checks?.passed === true ? 'completed' : 'failed',
    ...options, exit, forcedStop, node: process.version, platform: process.platform, arch: process.arch,
    logicalCpus: cpus().length, physicalMemoryBytes: totalmem(), fixtureDirectory: directory, result: result ?? null,
    limitations: ['No real model, browser or full Host workflow; this is component evidence.',
      'Native append is a reference, not semantically identical to Journal validation and budget accounting.',
      'Configured load is not an enforced Host concurrency limit.', 'Timing results are observations, not automatic production admission.'] }
  await writeFile(join(options.output, 'worker.stdout.log'), stdout, { flag: 'wx' })
  await writeFile(join(options.output, 'worker.stderr.log'), stderr, { flag: 'wx' })
  await writeFile(join(options.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: receipt.status, mode: options.mode, elapsedMs: result?.elapsedMs, samples: result?.samples, output: options.output }))
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const receipt = await benchmark(parseBenchmarkArgs(process.argv.slice(2))); if (receipt.status !== 'completed') process.exitCode = 1 }
  catch { console.error('Benchmark invocation or isolated evidence collection failed; inspect retained output.'); process.exitCode = 1 }
}
