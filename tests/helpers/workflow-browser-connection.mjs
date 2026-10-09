import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'

// Execute the published official browser bundle and its public plugin entry.
// lib/types/client/rpc.js exists in the source build but is NOT an npm export.
export async function officialBrowserRpc(doFetch) {
  const require = createRequire(import.meta.url)
  const bundle = await readFile(join(dirname(require.resolve('@deepseek-ai/dsh-client-connection')), 'client.js'), 'utf8')
  let module, connection
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) {
      assert.equal(definition.id, '@deepseek-ai/dsh-client-connection')
      module = definition.factory(name => { throw new Error('Unexpected browser external: ' + name) })
    } } },
    __DSH_TRANSPORT__: { fetch: doFetch },
    URL, URLSearchParams, AbortController, AbortSignal, DOMException, Response, Request, Headers,
    TextEncoder, TextDecoder, crypto: globalThis.crypto, fetch: doFetch, console, setTimeout, clearTimeout,
  }
  runInNewContext(bundle, sandbox, { filename: 'official-dsh-client-connection.js', timeout: 1000 })
  assert.equal(typeof module?.apply, 'function')
  module.apply({ provide(name, handle) { assert.equal(name, 'connection'); connection = handle } })
  assert.equal(typeof connection?.rpc?.call, 'function')
  return connection.rpc
}
