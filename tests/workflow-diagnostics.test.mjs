import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectWorkflow } from '../scripts/lib/workflow-diagnostics.mjs'
import { controllerFixture, signal } from './helpers/workflow-controller-fixture.mjs'
import { WorkflowJournal } from '../lib/workflow-journal.js'
import { WorkflowTextController } from '../lib/workflow-control.js'
import { memoryTable } from './helpers/workflow-fixture.mjs'
import { backupJournal } from '../scripts/lib/journal-backup.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const run = promisify(execFile), sentinel = 'PRIVATE-sentinel-密钥-用户内容'
const codes = report => report.checks.map(item => item.code)
async function saveCapture(h, patch = {}) {
  const value = { mode: 'read-only', checkedAt: new Date().toISOString(),
    roots: [{ id: h.root.id, running: false }], resident: { ids: [] }, failures: [],
    catalog: h.snapshot().run.agents.map(agent => ({ root: h.root.id, parent: h.root.id,
      entry: { kind: 'child', id: agent.agentSessionId, activity: 'inactive', label: sentinel } })), ...patch }
  await writeFile(h.nativeCapture, JSON.stringify(value))
  return value
}
async function prepare(t, { project = false, approveWorkspace = true, running = false, fileName = 'src/app.js' } = {}) {
  const h = await controllerFixture(t, { runBudgetConfig: { runBudgetEnabled: false } })
  h.store = await mkdtemp(join(tmpdir(), 'workflow-diagnostics-snapshot-'))
  h.output = await mkdtemp(join(tmpdir(), 'workflow-diagnostics-output-'))
  h.nativeCapture = join(h.store, 'native.json'); h.journalSnapshot = join(h.store, 'journal.sqlite')
  h.workspace = join(h.directory, 'workspace')
  if (project) {
    h.driver.ask = async (_agent, questions) => ({ answers: questions.map(question => ({ id: question.id, selected: [question.options[0].label] })) })
    await mkdir(join(h.workspace, 'src'), { recursive: true })
    h.root.session = { header: { cwd: h.workspace } }
    await h.controller.propose(h.root, { expectedRevision: 0, kind: 'project-change', title: sentinel, goal: '创建测试文件',
      changeClass: 'localized', inScope: [fileName], outOfScope: ['发布'], constraints: [], assumptions: [], unresolvedQuestions: [],
      writeScopes: ['src'], engineeringChecks: [{ id: 'ENG-1', command: 'node --test', workdir: '.', purpose: '测试' }],
      acceptanceChecks: [{ id: 'ACC-1', command: 'node --test', workdir: '.', purpose: '验收' }],
      criteria: [{ statement: '测试通过', checkIds: ['ACC-1'] }] }, signal)
    await h.controller.confirm(h.root, h.revision(), signal)
    h.file = join(h.workspace, fileName)
    await writeFile(h.file, 'before\n')
    await h.advance()
    const child = h.child('implementation'), args = { file_path: fileName, content: 'after\n' }
    child.session = { header: { cwd: h.workspace } }
    const result = { isError: false, value: { path: fileName, operation: 'update', before: 'before\n', after: 'after\n' }, content: [] }
    await h.controller.executeNativeTool(child, 'write', args, async () => { await writeFile(h.file, args.content); return result })
    await h.controller.observeNativeTool(child, 'write', args, result)
    await h.controller.report(child, { role: 'engineer', summary: sentinel, changedFiles: [fileName], notes: [] }, signal)
    await h.settle(child)
  } else {
    await h.setup()
    if (running) await h.advance()
    else { await h.author(sentinel); await h.qa(true); await h.advance() }
  }
  h.saveDb = () => {
    const db = new DatabaseSync(h.journalSnapshot)
    try {
      db.exec('CREATE TABLE IF NOT EXISTS u_workflow_runtime_sessions (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      for (const [key, value] of h.table.rows) db.prepare('INSERT OR REPLACE INTO u_workflow_runtime_sessions VALUES (?,?)').run(key, JSON.stringify(value))
    } finally { db.close() }
  }
  h.saveDb(); await saveCapture(h)
  h.options = { journalSnapshot: h.journalSnapshot, dataDirectory: h.directory, nativeCapture: h.nativeCapture,
    workspaceRoots: project && approveWorkspace ? [h.workspace] : [] }
  h.inspect = patch => inspectWorkflow({ ...h.options, ...patch })
  return h
}

test('diagnostic report checks actual Journal, native bindings and objects without exporting identities or content', async t => {
  const h = await prepare(t), beforeDb = sha(await readFile(h.journalSnapshot)), before = structuredClone(h.snapshot())
  const { report, privateReferences } = await h.inspect()
  assert.equal(report.status, 'no-conflicts-observed'); assert.equal(report.checkedRows, 1)
  assert.ok(codes(report).includes('immutable-object-matches')); assert.equal(report.counts.unknown, 0)
  for (const secret of [sentinel, h.root.id, h.directory, h.snapshot().run.runId]) assert.ok(!JSON.stringify(report).includes(secret))
  assert.ok(privateReferences.some(item => item.identity === h.root.id))
  assert.equal(sha(await readFile(h.journalSnapshot)), beforeDb); assert.deepEqual(h.snapshot(), before)
  assert.deepEqual((await readdir(h.store)).sort(), ['journal.sqlite', 'native.json'])
})

test('missing native capture is incomplete, never an all-clear from only the Journal', async t => {
  const h = await prepare(t), { report } = await h.inspect({ nativeCapture: undefined })
  assert.equal(report.status, 'incomplete'); assert.equal(report.coverage.native, false)
})

test('stale and malformed native captures remain unknown and raw failure strings stay private', async t => {
  const h = await prepare(t)
  await saveCapture(h, { checkedAt: new Date(Date.now() - 3600000).toISOString() })
  assert.ok(codes((await h.inspect()).report).includes('native-capture-stale'))
  await writeFile(h.nativeCapture, JSON.stringify({ error: sentinel }))
  const { report } = await h.inspect()
  assert.equal(report.status, 'incomplete'); assert.ok(!JSON.stringify(report).includes(sentinel))
})

test('unreadable diagnostic children and unrelated catalogue warnings are distinguished', async t => {
  const h = await prepare(t), first = h.snapshot().run.agents[0]
  const value = await saveCapture(h)
  value.catalog[0].entry = { kind: 'diagnostic', id: first.agentSessionId, reason: 'corrupt' }
  value.catalog.push({ root: sentinel, parent: sentinel, entry: { kind: 'diagnostic', id: sentinel + '-child', reason: 'unavailable' } })
  await writeFile(h.nativeCapture, JSON.stringify(value))
  const { report } = await h.inspect()
  assert.equal(report.native.catalogDiagnostics, 2); assert.equal(report.native.relatedDiagnostics, 1)
  assert.deepEqual(report.native.reasons, { corrupt: 1, unsupported: 0, unavailable: 1 })
  assert.ok(codes(report).includes('native-child-unreadable')); assert.equal(report.status, 'needs-attention')
  assert.ok(!JSON.stringify(report).includes(sentinel))
})

test('native wrong parent is a binding error; absence is uncertainty, not proof of deletion', async t => {
  const h = await prepare(t), value = await saveCapture(h)
  value.catalog[0].parent = 'other-parent'; value.catalog.pop()
  await writeFile(h.nativeCapture, JSON.stringify(value))
  const { report } = await h.inspect()
  assert.ok(codes(report).includes('native-child-binding-mismatch')); assert.ok(codes(report).includes('native-child-not-observed'))
})

test('an inactive native catalogue entry cannot resolve a persisted unknown exit', async t => {
  const h = await prepare(t, { running: true }), table = memoryTable()
  table.rows.set(h.root.id, structuredClone(h.table.rows.get(h.root.id)))
  const journal = new WorkflowJournal(table)
  const controller = new WorkflowTextController(journal, h.artifacts, { ...h.driver, isRoot: () => false, isLive: () => false })
  try {
    await controller.recoverOrphanedLeases()
    assert.equal(journal.readSnapshot(h.root.id).run.agents[0].runtimeIssue.status, 'unknown')
    const db = new DatabaseSync(h.journalSnapshot)
    db.prepare('UPDATE u_workflow_runtime_sessions SET value = ? WHERE key = ?').run(JSON.stringify(table.rows.get(h.root.id)), h.root.id)
    db.close()
    const before = sha(await readFile(h.journalSnapshot)), { report } = await h.inspect()
    assert.ok(codes(report).includes('role-exit-unverified')); assert.equal(report.status, 'needs-attention')
    assert.equal(sha(await readFile(h.journalSnapshot)), before)
  } finally { await controller.close(); await journal.close() }
})

test('duplicate native identities are refused, not silently overwritten by a healthy later row', async t => {
  const h = await prepare(t), value = await saveCapture(h)
  value.catalog.push({ ...value.catalog[0], parent: 'other-parent' })
  await writeFile(h.nativeCapture, JSON.stringify(value))
  const { report } = await h.inspect()
  assert.equal(report.coverage.native, false); assert.ok(codes(report).includes('native-capture-invalid'))
})

test('root missing from the capture remains uncertainty even when its children were seen', async t => {
  const h = await prepare(t)
  await saveCapture(h, { roots: [] })
  const { report } = await h.inspect()
  assert.ok(codes(report).includes('native-root-not-observed')); assert.equal(report.status, 'incomplete')
})

test('corrupt Journal row does not stop other rows from being checked and cannot reset data', async t => {
  const h = await prepare(t), db = new DatabaseSync(h.journalSnapshot)
  db.prepare('INSERT INTO u_workflow_runtime_sessions VALUES (?,?)').run(sentinel, '{invalid:' + sentinel); db.close()
  const before = sha(await readFile(h.journalSnapshot)), { report } = await h.inspect()
  assert.equal(report.checkedRows, 1); assert.ok(codes(report).includes('journal-row-invalid'))
  assert.equal(report.status, 'needs-attention'); assert.equal(sha(await readFile(h.journalSnapshot)), before)
  assert.ok(!JSON.stringify(report).includes(sentinel))
})

test('immutable object corruption is not confused with a later workspace edit', async t => {
  const h = await prepare(t)
  const files = await readdir(join(h.directory, 'text-artifacts'))
  await writeFile(join(h.directory, 'text-artifacts', files[0]), 'different private content')
  const { report } = await h.inspect()
  assert.ok(codes(report).includes('immutable-object-mismatch')); assert.equal(report.counts.error, 1)
})

test('oversized immutable objects are bounded and reported as uninspected, not silently truncated', async t => {
  const h = await prepare(t), files = await readdir(join(h.directory, 'text-artifacts'))
  await writeFile(join(h.directory, 'text-artifacts', files[0]), Buffer.alloc(16 * 1024 * 1024 + 1))
  const { report } = await h.inspect()
  assert.ok(codes(report).includes('immutable-file-limit')); assert.equal(report.coverage.immutableObjects, false)
  assert.equal(report.status, 'incomplete')
})

test('recorded artifact locator cannot redirect content inspection outside the supplied object store', async t => {
  const h = await prepare(t)
  const record = structuredClone(h.table.rows.get(h.root.id))
  for (const event of record.events) if (event.data.name === 'record/published' && event.data.payload.record.kind === 'artifact')
    event.data.payload.record.data.locator = 'C:/private/' + sentinel
  const db = new DatabaseSync(h.journalSnapshot)
  db.prepare('UPDATE u_workflow_runtime_sessions SET value = ?').run(JSON.stringify(record)); db.close()
  const { report } = await h.inspect()
  assert.ok(codes(report).includes('immutable-object-matches')); assert.equal(report.status, 'no-conflicts-observed')
  assert.ok(!JSON.stringify(report).includes(sentinel))
})

test('project files require explicit scope and edits are divergence, not immutable corruption', async t => {
  const h = await prepare(t, { project: true })
  let report = (await h.inspect()).report
  assert.ok(codes(report).includes('workspace-matches-record')); assert.ok(codes(report).includes('immutable-object-matches'))
  await writeFile(h.file, sentinel)
  report = (await h.inspect()).report
  assert.ok(codes(report).includes('workspace-diverged')); assert.equal(report.counts.error, 0)
  report = (await h.inspect({ workspaceRoots: [] })).report
  assert.ok(codes(report).includes('workspace-not-authorized')); assert.equal(report.coverage.workspace, false)
})

test('an explicitly authorized parent covers a real nested workspace but never a sibling outside it', async t => {
  const h = await prepare(t, { project: true })
  const nested = (await h.inspect({ workspaceRoots: [h.directory] })).report
  assert.equal(nested.status, 'no-conflicts-observed'); assert.ok(codes(nested).includes('workspace-matches-record'))
  const outside = (await h.inspect({ workspaceRoots: [h.store] })).report
  assert.ok(codes(outside).includes('workspace-not-authorized')); assert.equal(outside.coverage.workspace, false)
})

test('committed file rollback changes comparison target back to the before image', async t => {
  const h = await prepare(t, { project: true })
  await h.controller.stop(h.root)
  await h.controller.rollback(h.root, h.revision(), signal)
  h.saveDb(); await saveCapture(h)
  const report = (await h.inspect()).report
  assert.equal(await readFile(h.file, 'utf8'), 'before\n')
  assert.ok(codes(report).includes('workspace-matches-record')); assert.ok(!codes(report).includes('workspace-diverged'))
})

test('mixed-case Windows rollback references use the Journal canonical key and do not abort later runs', async t => {
  const h = await prepare(t, { project: true, fileName: 'src/ReadMe.MD' })
  await h.controller.stop(h.root); await h.controller.rollback(h.root, h.revision(), signal)
  h.saveDb(); await saveCapture(h)
  const report = (await h.inspect()).report
  assert.equal(report.status, 'no-conflicts-observed'); assert.equal(report.runCount, 1)
  assert.ok(codes(report).includes('workspace-matches-record'))
  assert.ok(!codes(report).includes('run-inspection-incomplete'))
})

test('snapshot with WAL sidecars is refused rather than repaired or checkpointed in place', async t => {
  const h = await prepare(t), before = sha(await readFile(h.journalSnapshot))
  await writeFile(h.journalSnapshot + '-wal', sentinel)
  const report = (await h.inspect()).report
  assert.equal(report.status, 'incomplete'); assert.ok(codes(report).includes('snapshot-has-sidecars'))
  assert.equal(sha(await readFile(h.journalSnapshot)), before); assert.equal(await readFile(h.journalSnapshot + '-wal', 'utf8'), sentinel)
})

test('an official WAL-mode backup is inspected via a disposable copy without changing any source sidecars', async t => {
  const h = await prepare(t), active = new DatabaseSync(h.journalSnapshot)
  const backupDir = join(h.store, 'consistent-backup')
  try {
    active.exec('PRAGMA journal_mode = WAL')
    await backupJournal({ source: h.journalSnapshot, destination: backupDir, mode: 'online' })
  } finally { active.close() }
  const inventory = async () => Object.fromEntries(await Promise.all((await readdir(backupDir)).map(async name => [name, sha(await readFile(join(backupDir, name)))])))
  const before = await inventory()
  const { report } = await h.inspect({ journalSnapshot: join(backupDir, 'journal.sqlite') })
  assert.equal(report.checkedRows, 1); assert.equal(report.status, 'no-conflicts-observed')
  assert.deepEqual(await inventory(), before, 'read-only diagnosis cannot create, delete or update source SQLite sidecars')
})

test('symlinked object directory cannot redirect diagnostics to an external file', async t => {
  const h = await prepare(t), outside = await mkdtemp(join(tmpdir(), 'workflow-diagnostics-external-'))
  const linked = join(outside, 'linked')
  await symlink(h.directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const report = (await h.inspect({ dataDirectory: linked })).report
  assert.equal(report.coverage.immutableObjects, false); assert.ok(codes(report).includes('object-store-unavailable'))
})

test('CLI creates a new redacted file, keeps a private map opt-in, and refuses overwrite or source-directory output', async t => {
  const h = await prepare(t), output = join(h.output, 'report.json')
  const args = [resolve('scripts/diagnose-workflow.mjs'), '--snapshot', h.journalSnapshot, '--data', h.directory, '--native', h.nativeCapture]
  const result = await run(process.execPath, [...args, '--output', output], { windowsHide: true })
  assert.equal(JSON.parse(result.stdout).privateMapWritten, false)
  assert.ok(!result.stdout.includes(sentinel)); assert.deepEqual(await readdir(h.output), ['report.json'])
  const before = await readFile(output, 'utf8')
  await assert.rejects(run(process.execPath, [...args, '--output', output], { windowsHide: true }))
  assert.equal(await readFile(output, 'utf8'), before)
  await assert.rejects(run(process.execPath, [...args, '--output', join(h.directory, 'do-not-create.json')], { windowsHide: true }))
  const map = join(h.output, 'private.json')
  await run(process.execPath, [...args, '--output', join(h.output, 'report-2.json'), '--private-map', map], { windowsHide: true })
  assert.ok((await readFile(map, 'utf8')).includes(h.root.id))
  assert.ok(!(await readFile(join(h.output, 'report-2.json'), 'utf8')).includes(h.root.id))
})
