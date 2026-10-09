import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { appendFile, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkflowTextArtifacts } from '../lib/workflow-control.js'

const maximum = 16 * 1024 * 1024

test('checkpoint accepts exactly 16 MiB and refuses the next byte without an object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-artifact-limits-'))
  const store = await WorkflowTextArtifacts.open(directory)
  const content = Buffer.alloc(maximum, 65)
  const saved = await store.putCheckpoint(content)
  assert.equal(saved.bytes, maximum)
  assert.deepEqual(await store.readCheckpoint(saved.digest), content)
  const before = await readdir(store.checkpointDirectory)
  await assert.rejects(store.putCheckpoint(Buffer.alloc(maximum + 1, 66)), /16 MiB/)
  assert.deepEqual(await readdir(store.checkpointDirectory), before)
})

for (const kind of ['checkpoint', 'text']) {
  test(`${kind} read is bounded even if the file grows after both stat checks`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-artifact-growth-'))
    const store = await WorkflowTextArtifacts.open(directory)
    const limit = kind === 'checkpoint' ? maximum : 128000
    const saved = kind === 'checkpoint' ? await store.putCheckpoint(Buffer.alloc(1024, 65)) : await store.put('small text')
    const target = kind === 'checkpoint' ? join(store.checkpointDirectory, saved.digest + '.bin') : saved.locator
    const originalOpen = fs.open
    let observedBytes = 0, closed = false, grew = false
    fs.open = async (path, flags, ...rest) => {
      const handle = await originalOpen(path, flags, ...rest)
      if (resolve(String(path)) !== resolve(target) || flags !== 'r') return handle
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle)
      handle.stat = async (...args) => {
        const before = await stat(...args)
        if (!grew) { grew = true; await appendFile(target, Buffer.alloc(limit + 100, 66)) }
        return before
      }
      handle.read = async (...args) => { const result = await read(...args); observedBytes += result.bytesRead; return result }
      handle.close = async () => { closed = true; return close() }
      return handle
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(kind === 'checkpoint' ? store.readCheckpoint(saved.digest) : store.read(saved.digest), /byte limit/)
      assert.equal(grew, true)
      assert.equal(closed, true)
      assert.equal(observedBytes, limit + 1, 'At most one byte beyond the cap is consumed, no unbounded readFile')
      assert.ok((await readFile(target)).length > limit, 'The changed file is preserved, not truncated or auto-repaired')
    } finally {
      fs.open = originalOpen
      syncBuiltinESMExports()
    }
  })
}
