import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { parseBenchmarkArgs } from '../scripts/benchmark-workflow.mjs'

test('benchmark accepts only bounded isolated component workloads and a new absolute output target', () => {
  const output = resolve('isolated-evidence')
  assert.deepEqual(parseBenchmarkArgs(['--output', output]), { output, mode: 'workflow', durationMs: 60000, events: 1000, roots: 2, historyBytes: 0 })
  const result = parseBenchmarkArgs(['--output', output, '--duration-ms', '1800000', '--mode', 'native', '--events', '8500', '--roots', '4'])
  assert.equal(result.durationMs, 1800000); assert.equal(result.roots, 4)
  for (const args of [[], ['--output', 'relative'], ['--output', output, '--roots', '5'], ['--output', output, '--duration-ms', '999'],
    ['--output', output, '--duration-ms', '1800001'], ['--output', output, '--events', '9000'], ['--output', output, '--events', '101'],
    ['--output', output, '--mode', 'live'], ['--output', output, '--roots', 'NaN'], ['--output', output, '--output', output],
    ['--output', output, '--data', 'live'], ['--output', output, '--history-bytes', String(14 * 1024 * 1024)]]) {
    assert.throws(() => parseBenchmarkArgs(args))
  }
})
