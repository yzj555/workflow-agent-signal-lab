import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const output = resolve(process.argv[2])
await mkdir(output)
const checks = []
for (const [name, args] of [
  ['typecheck-host', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
  ['typecheck-client', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.client.json']],
  ['build', ['node_modules/tsdown/dist/run.mjs', '--config', 'tsdown.config.ts']],
  ['tests', ['--test', 'tests/*.test.mjs']],
]) {
  const startedAt = new Date().toISOString()
  try {
    const result = await promisify(execFile)(process.execPath, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 })
    await writeFile(join(output, name + '.log'), result.stdout + result.stderr, { flag: 'wx' })
    checks.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode: 0 })
    console.log(`${name}: passed`)
  } catch (error) {
    await writeFile(join(output, name + '.log'), (error.stdout ?? '') + (error.stderr ?? '') + String(error), { flag: 'wx' })
    checks.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode: error.code ?? 1 })
    console.log(`${name}: failed (see ${join(output, name + '.log')})`)
    break
  }
}
await writeFile(join(output, 'result.json'), JSON.stringify({ checks }, null, 2) + '\n', { flag: 'wx' })
assert.equal(checks.length, 4)
assert.ok(checks.every(check => check.exitCode === 0))
