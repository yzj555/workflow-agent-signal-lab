/** Freeze a local verified candidate, not an installable npm package. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const base = join(root, '.dsh/activation/workflow-rollback-recovery-20260917')
const candidate = join(base, 'candidate')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
async function hashes(directory, folder) {
  const result = {}
  for (const entry of await readdir(join(directory, folder), { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'No links in frozen inputs or outputs')
    if (entry.isFile()) { const file = join(entry.parentPath, entry.name); result[file.slice(directory.length + 1).replaceAll('\\', '/')] = sha(await readFile(file)) }
  }
  return result
}
const source = await hashes(root, 'src'), tests = await hashes(root, 'tests'), build = await hashes(candidate, 'lib')
assert.deepEqual(source, await hashes(candidate, 'src'))
assert.deepEqual(tests, await hashes(candidate, 'tests'))
assert.equal(Object.keys(build).length, 24, 'Expected clean output, no stale chunks')
for (const round of ['clean-build', 'clean-regression-v1', 'clean-regression-v2']) {
  assert.equal((await json(join(base, round, 'result.json'))).exitCode, 0)
  if (round !== 'clean-build') {
    const log = await readFile(join(base, round, 'tests.log'), 'utf8')
    assert.match(log, /tests 364\r?\n/u); assert.match(log, /pass 364\r?\n/u); assert.match(log, /fail 0\r?\n/u)
  }
}
assert.equal((await json(join(base, 'compatibility-clean.json'))).status, 'passed')
assert.equal((await json(join(base, 'ui-replay-v3/report.json'))).status, 'passed')
assert.equal((await json(join(base, 'final-protection.json'))).status, 'passed')
const before = await json(join(base, 'baseline/witness.json'))
assert.deepEqual(await hashes(root, 'lib'), before.build)
assert.deepEqual(await hashes(root, 'preset'), before.preset)
assert.deepEqual(await json(join(root, '.dsh/workflow-runtime/writer.lock')), before.writer)
assert.equal(sha(await readFile(join(root, 'cordis.patch.yml'))), before.config)
const manifest = { id: 'workflow-rollback-recovery-20260917', createdAt: new Date().toISOString(),
  kind: 'local-verified-candidate', deployed: false, packageVersion: '0.0.1', dshVersion: '0.1.5-rc.1',
  upstreamCommit: '183f08e9c6dde7e36cd2318eaee70b0da08fb35e', source, tests, build,
  historicalRecords: 20, fullRegression: '364/364 twice from clean output', uiReplayChecks: 4,
  newEvents: ['rollback/prepared', 'rollback/interrupted', 'rollback/cleaned'],
  downgrade: 'Not readable by the previous build after any new-protocol intent is stored. Retain a protocol-capable reader; never roll back Journal data.',
  boundaries: ['No live restart', 'No real model tasks or approvals', 'No profile or budget change', 'Not a portable package or full production admission'],
}
await writeFile(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ id: manifest.id, sourceFiles: Object.keys(source).length, buildFiles: Object.keys(build).length, deployed: false }))
