const test = require('node:test')
const assert = require('node:assert/strict')
const { appendFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')
setTimeout(() => process.exit(99), 5000).unref()
test('public module behavior is ready', async () => {
  const value = (await import(pathToFileURL(resolve('src/native.js')).href)).nativeReady
  appendFileSync('recovery-checks.jsonl', JSON.stringify({ pid: process.pid, value, at: Date.now() }) + '\n')
  assert.equal(value, true)
})
