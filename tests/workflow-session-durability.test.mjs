import assert from 'node:assert/strict'
import test from 'node:test'
import { RootSessionDurability } from '../lib/workflow-control.js'
import { controllerFixture, proposal, signal } from './helpers/workflow-controller-fixture.mjs'

test('first-use persistence coalesces only the exact root and caches successful durability', async () => {
  const root = {}, barrier = Promise.withResolvers()
  let calls = 0
  const guard = new RootSessionDurability(() => { calls++; return barrier.promise }, agent => agent === root)
  const first = guard.ensure(root, signal), second = guard.ensure(root, signal)
  await Promise.resolve()
  assert.equal(calls, 1)
  barrier.resolve()
  await Promise.all([first, second])
  await guard.ensure(root, signal)
  assert.equal(calls, 1)
})

test('a different or replaced root cannot inherit a prior in-flight or cached persistence barrier', async () => {
  const first = {}, next = {}, barriers = [], live = new Set([first, next])
  const guard = new RootSessionDurability(() => {
    const barrier = Promise.withResolvers(); barriers.push(barrier); return barrier.promise
  }, root => live.has(root))
  const a = guard.ensure(first, signal)
  await Promise.resolve()
  const b = guard.ensure(next, signal)
  await Promise.resolve()
  assert.equal(barriers.length, 2)
  barriers[0].resolve(); barriers[1].resolve(); await Promise.all([a, b])
  live.delete(first)
  await assert.rejects(guard.ensure(first, signal), /失效/)
})

test('failed native persistence blocks a new workflow before any Journal, gate or child side effect', async t => {
  const h = await controllerFixture(t, { ensureRootDurable: async () => { throw new Error('fixture persistence failed') } })
  await assert.rejects(h.controller.propose(h.root, proposal(0), signal), /persistence failed/)
  assert.equal(h.snapshot().run, null)
  assert.equal(h.snapshot().revision, 0)
  assert.equal(h.table.rows.size, 0)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.questions, [])
})

test('a pending barrier prevents commit; cancellation ignores its late success without caching it', async t => {
  const barrier = Promise.withResolvers(), abort = new AbortController()
  let calls = 0
  const guard = new RootSessionDurability(() => { calls++; return barrier.promise }, () => true)
  const h = await controllerFixture(t, { ensureRootDurable: (root, signal) => guard.ensure(root, signal) })
  const work = h.controller.propose(h.root, proposal(0), abort.signal)
  await Promise.resolve()
  assert.equal(h.table.rows.size, 0)
  abort.abort(new Error('fixture user cancelled'))
  await assert.rejects(work, /user cancelled/)
  barrier.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(h.table.rows.size, 0)
  await h.controller.propose(h.root, proposal(0), signal)
  assert.equal(calls, 2)
  assert.ok(h.snapshot().run)
})

test('a stuck native persistence barrier has a bounded wait and cannot publish a late Run', async t => {
  const barrier = Promise.withResolvers(), guard = new RootSessionDurability(() => barrier.promise, () => true, 25)
  const h = await controllerFixture(t, { ensureRootDurable: (root, signal) => guard.ensure(root, signal) })
  await assert.rejects(h.controller.propose(h.root, proposal(0), signal), /保存超时/)
  assert.equal(h.table.rows.size, 0)
  barrier.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(h.table.rows.size, 0)
})

test('persistence failure can be retried without hiding the original failure or caching a false success', async () => {
  let calls = 0
  const root = {}, guard = new RootSessionDurability(async () => {
    if (++calls === 1) throw new Error('disk unavailable')
  }, () => true)
  await assert.rejects(guard.ensure(root, signal), error => /保存失败/.test(error.message) && /disk unavailable/.test(error.cause.message))
  await guard.ensure(root, signal)
  assert.equal(calls, 2)
})

test('disposing a root while its persistence is pending rejects creation', async t => {
  const barrier = Promise.withResolvers()
  let live = true
  const guard = new RootSessionDurability(() => barrier.promise, () => live)
  const h = await controllerFixture(t, { ensureRootDurable: (root, signal) => guard.ensure(root, signal) })
  const work = h.controller.propose(h.root, proposal(0), signal)
  live = false; barrier.resolve()
  await assert.rejects(work, /失效/)
  assert.equal(h.table.rows.size, 0)
})
