/** Pin the native-history upgrade boundary separately from plugin Journal replay. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { constants, zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'

async function fixture(t, compression) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'workflow-native-compat-'))
  const contexts = []
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    const target = await realpath(root)
    assert.equal(dirname(target), parent)
    assert.ok(basename(target).startsWith('workflow-native-compat-'))
    await rm(target, { recursive: true }) // This exact fixture only, never a real Session store.
  })
  const id = SessionId('compatibility-child')
  const directory = join(root, '_no-cwd', id)
  await mkdir(directory, { recursive: true })
  return { root, directory, id,
    async mount() {
      const ctx = new Context(); contexts.push(ctx)
      await ctx.plugin(Persistence, { root, compression })
      return ctx
    },
    async store(version, descriptor) {
      const header = { type: 'session', version, id, createdAt: 1, parentSession: 'compatibility-parent',
        origin: 'subagent', delegationDepth: 1, ...(version >= 3 ? { isSeeded: false } : {}) }
      const rows = [
        { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
        { type: 'subagent/descriptor', seq: 1, time: 3, data: descriptor },
        { type: 'turn/end', seq: 2, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      const chunks = [header, ...rows].map(row => JSON.stringify(row) + '\n')
      const bytes = compression === 'none' ? Buffer.from(chunks.join(''))
        : Buffer.concat(chunks.map(chunk => zstdCompressSync(chunk, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })))
      const name = `session${version === 0 ? '' : `.v${version}`}.jsonl${compression === 'zstd' ? '.zstd' : ''}`
      await writeFile(join(directory, name), bytes, { flag: 'wx' })
      return { name, bytes, rows }
    },
  }
}

for (const compression of ['none', 'zstd']) {
  test(`native ${compression} header listing does not prove v0 descriptor-v2 history compatibility`, async t => {
    const f = await fixture(t, compression)
    const stored = await f.store(0, { version: 2, mode: 'continuable', provider: 'spawn', label: 'historical fixture' })
    const ctx = await f.mount()
    const stat = await ctx.sessionPersistence.stat(f.id)
    assert.equal(stat.header.id, f.id, 'a discoverable header must not be mistaken for a readable transcript')
    const entries = await readdir(f.directory)
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(ctx.sessionPersistence.open(f.id, 'read').then(async handle => {
        try { return await handle.read(0) } finally { await handle.close() }
      }), error => error instanceof SessionFormatUnsupportedError
        && /subagent\/descriptor 1 uses unsupported descriptor version 2/u.test(error.message))
    }
    assert.deepEqual(await readFile(join(f.directory, stored.name)), stored.bytes)
    assert.deepEqual(await readdir(f.directory), entries, 'read refusal must not publish a renamed successor or delete history')
  })

  test(`native ${compression} current continuable history is cold-readable without a model or Agent`, async t => {
    const f = await fixture(t, compression)
    assert.equal(SUBAGENT_DESCRIPTOR_VERSION, 3, 'compatibility proof is pinned to the installed DSH baseline')
    assert.equal(SESSION_FORMAT_VERSION, 4, 'the 0.2 SDK Session format is pinned separately from its subagent descriptor')
    const stored = await f.store(4, snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'current fixture' }))
    const entries = await readdir(f.directory)
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = await f.mount()
      const handle = await ctx.sessionPersistence.open(f.id, 'read')
      try {
        assert.equal(handle.header.version, 4)
        const read = await handle.read(0)
        assert.deepEqual(read.events, stored.rows)
      } finally { await handle.close(); await ctx.fiber.dispose() }
    }
    assert.deepEqual(await readFile(join(f.directory, stored.name)), stored.bytes)
    assert.deepEqual(await readdir(f.directory), entries)
  })

  test(`native ${compression} v3 current-descriptor history prepares v4 on read without publishing or changing the source`, async t => {
    const f = await fixture(t, compression)
    const stored = await f.store(3, snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'previous Session format' }))
    const entries = await readdir(f.directory)
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = await f.mount()
      const handle = await ctx.sessionPersistence.open(f.id, 'read')
      try {
        assert.equal(handle.header.version, 4)
        assert.deepEqual((await handle.read(0)).events, stored.rows)
      } finally { await handle.close(); await ctx.fiber.dispose() }
    }
    assert.deepEqual(await readFile(join(f.directory, stored.name)), stored.bytes)
    assert.deepEqual(await readdir(f.directory), entries, 'read-only preparation is not authorization to publish a successor')
  })
}
