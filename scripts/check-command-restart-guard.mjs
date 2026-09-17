/** Offline guard regression using the captured, refused v2 observation. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { classifyInterruptionSafety } from './native-control-baseline.mjs'
const evidence = 'F:/dsh/workflow-agent-signal-lab/.dsh/activation/workflow-command-online-suite-20260915'
const sample = JSON.parse(await readFile(`${evidence}/restart-v2/process-observation.json`, 'utf8'))
const base = sample.native
const blockers = native => Object.values(classifyInterruptionSafety(native, sample.sessionId)).reduce((count, items) => count + items.length, 0)
assert.deepEqual(base.otherRunning, [base.childId], 'regression must reproduce the exact misclassification')
assert.equal(blockers(base), 0)
const checks = ['captured exact test child plus nonresident history is not unrelated work']
for (const [name, mutate] of [
  ['unrelated running Session', state => state.otherRunning.push('another-root')],
  ['unrelated active child', state => state.otherActiveChildren.push({ parent: 'another-root', child: 'another-child' })],
  ['resident diagnostic', state => state.resident.ids.push(state.catalogDiagnostics[0].entry.id)],
  ['unclassified resident', state => state.resident.ids.push('unknown-live-session')],
  ['unrelated queued input', state => { state.resident.queues['another-root'] = 1 }],
  ['unrelated background job', state => { state.resident.jobs['another-root'] = [{ kind: 'test', status: 'running' }] }],
]) {
  const changed = structuredClone(base)
  mutate(changed)
  assert.ok(blockers(changed) > 0, name)
  checks.push(name)
}
const report = { checkedAt: new Date().toISOString(), result: 'pass', checks,
  boundary: 'offline classifier regression only; does not count as an actual Host interruption' }
await writeFile(`${evidence}/restart-v3/guard-regression.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
