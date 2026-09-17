import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowQuestionWaits } from '../lib/workflow-control.js'

test('native waits isolate exact Agent instances and preserve overlapping requests', () => {
  const waits = new WorkflowQuestionWaits()
  const first = { id: 'same-durable-id' }, replacement = { id: first.id }, unrelated = { id: 'other' }
  const one = new AbortController(), two = new AbortController()
  const releaseOne = waits.track(first, one.signal, () => {})
  const releaseTwo = waits.track(first, two.signal, () => {})
  const releaseNew = waits.track(replacement, undefined, () => {})
  assert.equal(waits.has(unrelated), false)
  one.abort()
  assert.equal(waits.has(first), true)
  releaseTwo()
  assert.equal(waits.has(first), false)
  releaseOne()
  assert.equal(waits.has(replacement), true, 'late old-instance cleanup cannot affect a replacement')
  releaseNew()
  waits.close()
})

test('already-aborted and late-aborted requests do not retain a waiting exemption', () => {
  const waits = new WorkflowQuestionWaits(), agent = { id: 'root' }, cancel = new AbortController()
  let changes = 0
  cancel.abort()
  waits.track(agent, cancel.signal, () => { changes++ })()
  assert.equal(waits.has(agent), false)
  assert.equal(changes, 0)
  const active = new AbortController()
  const release = waits.track(agent, active.signal, () => { changes++ })
  assert.equal(changes, 1)
  active.abort()
  assert.equal(waits.has(agent), false, 'cleanup does not wait for an unresponsive answerer')
  release()
  assert.equal(changes, 2, 'cleanup is exactly once')
  waits.close()
})

test('forget and close release every pending observer without aborting questions', () => {
  const waits = new WorkflowQuestionWaits(), agent = { id: 'root' }, other = { id: 'other' }
  const first = new AbortController(), second = new AbortController()
  const late = waits.track(agent, first.signal, () => {})
  waits.track(agent, undefined, () => {})
  waits.track(other, second.signal, () => {})
  waits.forget(agent)
  assert.equal(waits.has(agent), false)
  assert.equal(waits.has(other), true)
  waits.close()
  late()
  waits.track(agent, undefined, () => {})()
  assert.equal(waits.has(other), false)
  assert.equal(waits.has(agent), false)
  assert.equal(first.signal.aborted, false)
  assert.equal(second.signal.aborted, false)
})

test('observer failures do not change question settlement or leave waiting state behind', () => {
  const errors = [], agent = { id: 'root' }
  const waits = new WorkflowQuestionWaits(error => { errors.push(error.message); throw new Error('logger failed') })
  const release = waits.track(agent, undefined, () => { throw new Error('observer failed') })
  assert.equal(waits.has(agent), true)
  assert.doesNotThrow(release)
  assert.equal(waits.has(agent), false)
  assert.deepEqual(errors, ['observer failed', 'observer failed'])
  waits.close()
})
