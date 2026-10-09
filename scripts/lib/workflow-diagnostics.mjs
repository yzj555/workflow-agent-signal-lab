/** Read-only maintenance inspection. No Host, model, owner acquisition or repair. */
import { lstat, open, realpath, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WorkflowJournal, parseWorkflowJournalRecord } from '../../lib/workflow-journal.js'
import { projectContract } from '../../lib/workflow-control.js'

const MiB = 1024 * 1024
const MAX_ROWS = 1000, MAX_CHECKS = 20000, MAX_READ_BYTES = 256 * MiB
const sha = value => createHash('sha256').update(value).digest('hex')
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 512
class InspectionRefusal extends Error {
  constructor(code) { super(code); this.code = code }
}
function refuse(code) { throw new InspectionRefusal(code) }

/** Check every parent, not only the leaf. Diagnostic references must not follow junctions. */
async function regularPath(target, kind = 'file') {
  if (!isAbsolute(target)) refuse('absolute-path-required')
  const absolute = resolve(target), parts = relative(parse(absolute).root, absolute).split(/[\\/]/u).filter(Boolean)
  let cursor = parse(absolute).root
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part)
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink()) refuse('unsafe-path')
    if (index < parts.length - 1 ? !stat.isDirectory() : kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) refuse('unsafe-path')
  }
  if (!samePath(await realpath(absolute), absolute)) refuse('unsafe-path')
  return absolute
}
function inside(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.split(/[\\/]/u).some(part => part === '..') || value.includes(':')) refuse('unsafe-path')
  const target = resolve(root, value), rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) refuse('unsafe-path')
  return target
}
async function boundedRead(target, limit, budget) {
  await regularPath(target)
  const file = await open(target, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > limit) refuse('file-limit')
    if (budget.bytes + before.size + 1 > MAX_READ_BYTES) refuse('inspection-limit')
    const bytes = Buffer.alloc(Math.min(before.size + 1, limit + 1))
    let total = 0
    while (total < bytes.length) {
      const read = await file.read(bytes, total, bytes.length - total, total)
      if (!read.bytesRead) break
      total += read.bytesRead
    }
    budget.bytes += total
    const after = await file.stat()
    await regularPath(target)
    const current = await lstat(target)
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.isSymbolicLink() || current.ino !== after.ino || current.size !== after.size) refuse('changed-during-inspection')
    return bytes.subarray(0, total)
  } finally { await file.close() }
}
const fileFailure = error => error?.code === 'ENOENT' ? 'missing'
  : error instanceof InspectionRefusal ? error.code : ['EACCES', 'EPERM'].includes(error?.code) ? 'unreadable' : 'read-error'

/** Accept the existing official read-only tree capture, never raw text as a health verdict. */
function parseNative(value) {
  if (!value || value.mode !== 'read-only' || !Number.isFinite(Date.parse(value.checkedAt))
    || !Array.isArray(value.roots) || value.roots.length > 5000 || !Array.isArray(value.catalog) || value.catalog.length > 10000
    || !Array.isArray(value.failures) || !value.resident || !Array.isArray(value.resident.ids)
    || value.roots.some(item => !safeId(item.id) || typeof item.running !== 'boolean')
    || new Set(value.roots.map(item => item.id)).size !== value.roots.length
    || value.resident.ids.some(id => !safeId(id))) refuse('native-capture-invalid')
  const roots = new Map(value.roots.map(item => [item.id, item]))
  const children = new Map(), diagnostics = []
  for (const item of value.catalog) {
    const entry = item?.entry
    if (!safeId(item?.parent) || !safeId(item?.root) || !safeId(entry?.id)
      || !['child', 'diagnostic'].includes(entry.kind) || children.has(entry.id)) refuse('native-capture-invalid')
    if (entry.kind === 'diagnostic' && !['corrupt', 'unsupported', 'unavailable'].includes(entry.reason)) refuse('native-capture-invalid')
    if (entry.kind === 'child' && !['running', 'inactive'].includes(entry.activity)) refuse('native-capture-invalid')
    children.set(entry.id, item)
    if (entry.kind === 'diagnostic') diagnostics.push(item)
  }
  return { roots, children, diagnostics, failures: value.failures.length, checkedAt: Date.parse(value.checkedAt) }
}

/** Results are allowlisted, not regex-redacted. The private alias map is returned separately. */
export async function inspectWorkflow({ journalSnapshot, dataDirectory, nativeCapture, workspaceRoots = [], now = Date.now() }) {
  const checks = [], privateReferences = [], aliases = new Map(), budget = { bytes: 0 }
  let limitHit = false, checkedRows = 0, runCount = 0, native
  const coverage = { journal: false, native: false, immutableObjects: true, workspace: true }
  function ref(kind, identity) {
    const key = `${kind}\0${identity}`
    if (!aliases.has(key)) {
      const alias = `${kind}-${String(privateReferences.length + 1).padStart(4, '0')}`
      aliases.set(key, alias); privateReferences.push({ alias, kind, identity })
    }
    return aliases.get(key)
  }
  function note(code, status, target, scope) {
    if (checks.length >= MAX_CHECKS) { limitHit = true; return }
    checks.push({ code, status, target, ...(scope ? { scope } : {}) })
  }
  const reportRef = ref('inspection', 'current inspection')
  const approvedRoots = []
  for (const root of workspaceRoots) {
    try { approvedRoots.push(await regularPath(root, 'directory')) }
    catch { note('workspace-root-unavailable', 'unknown', ref('workspace', String(root))); coverage.workspace = false }
  }
  let store
  try { store = await regularPath(dataDirectory, 'directory') }
  catch { note('object-store-unavailable', 'unknown', reportRef); coverage.immutableObjects = false }
  let nativeSummary = { supplied: Boolean(nativeCapture), usable: false, catalogDiagnostics: 0, relatedDiagnostics: 0,
    reasons: { corrupt: 0, unsupported: 0, unavailable: 0 } }
  if (nativeCapture) {
    try {
      native = parseNative(JSON.parse((await boundedRead(nativeCapture, 8 * MiB, budget)).toString('utf8')))
      nativeSummary = { ...nativeSummary, usable: true, catalogDiagnostics: native.diagnostics.length,
        ageSeconds: Math.max(0, Math.floor((now - native.checkedAt) / 1000)), nonAtomic: true }
      coverage.native = native.failures === 0 && native.checkedAt <= now + 5000 && now - native.checkedAt <= 300000
      note(native.failures ? 'native-capture-partial' : coverage.native ? 'native-capture-present' : 'native-capture-stale',
        coverage.native ? 'pass' : 'unknown', reportRef)
      for (const item of native.diagnostics) nativeSummary.reasons[item.entry.reason]++
    } catch { native = undefined; note('native-capture-invalid', 'unknown', reportRef) }
  } else note('native-capture-not-supplied', 'unknown', reportRef)

  const objectCache = new Map()
  async function checkObject(digest, kind, target, scope, expectedBytes) {
    if (!store) return
    if (!/^[a-f0-9]{64}$/u.test(digest)) { note('object-reference-invalid', 'error', target, scope); return }
    const path = join(store, kind === 'text' ? 'text-artifacts' : 'workspace-checkpoints', digest + (kind === 'text' ? '.txt' : '.bin'))
    if (!objectCache.has(path)) {
      try {
        const bytes = await boundedRead(path, 16 * MiB, budget)
        objectCache.set(path, { matches: sha(bytes) === digest, bytes: bytes.length })
      } catch (error) { objectCache.set(path, { error: fileFailure(error) }) }
    }
    const result = objectCache.get(path)
    if (result.error) {
      const uncertain = !['missing'].includes(result.error)
      note(`immutable-${result.error}`, uncertain ? 'unknown' : 'error', target, scope)
      if (uncertain) coverage.immutableObjects = false
    } else note(result.matches && (expectedBytes === undefined || expectedBytes === result.bytes) ? 'immutable-object-matches' : 'immutable-object-mismatch',
      result.matches && (expectedBytes === undefined || expectedBytes === result.bytes) ? 'pass' : 'error', target, scope)
  }

  let db, workingDirectory
  try {
    const path = await regularPath(journalSnapshot)
    if ((await lstat(path)).size > 512 * MiB) refuse('snapshot-limit')
    async function assertCheckpointed() {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          const info = await lstat(path + suffix)
          if (!info.isFile() || info.isSymbolicLink()) refuse('unsafe-path')
          if (suffix === '-journal' || (suffix === '-wal' && info.size > 0)) refuse('snapshot-has-sidecars')
        } catch (error) { if (error?.code !== 'ENOENT') throw error }
      }
    }
    // Even readOnly SQLite can create WAL/SHM beside a checkpointed backup.
    // Read the source as bounded bytes, then open ONLY an owned temporary copy.
    // A nonempty WAL or rollback journal requires a real backup first; never
    // drop it and inspect an incomplete main file.
    await assertCheckpointed()
    const image = await boundedRead(path, 512 * MiB, budget)
    await assertCheckpointed()
    workingDirectory = await mkdtemp(join(tmpdir(), 'workflow-diagnostic-read-'))
    const workingFile = join(workingDirectory, 'journal.sqlite')
    await writeFile(workingFile, image, { flag: 'wx', mode: 0o600 })
    db = new DatabaseSync(workingFile, { readOnly: true })
    db.exec('BEGIN') // One read transaction, never a mixture of SQLite row revisions.
    if (db.prepare('PRAGMA integrity_check').all().some(row => Object.values(row)[0] !== 'ok')) refuse('sqlite-integrity-failed')
    const count = db.prepare('SELECT count(*) AS count FROM u_workflow_runtime_sessions').get().count
    if (count > MAX_ROWS) refuse('row-limit')
    const headers = db.prepare("SELECT CASE WHEN typeof(key) = 'text' AND length(key) BETWEEN 1 AND 512 THEN key ELSE NULL END AS key, length(CAST(value AS BLOB)) AS size FROM u_workflow_runtime_sessions ORDER BY key").all()
    const roots = new Set(headers.map(row => row.key))
    if (native) for (const item of native.diagnostics) if (roots.has(item.root)) {
      nativeSummary.relatedDiagnostics++
      note(`native-catalog-${item.entry.reason}`, 'warning', ref('session', item.entry.id), ref('session', item.root))
    }
    const query = db.prepare('SELECT value FROM u_workflow_runtime_sessions WHERE key = ?')
    coverage.journal = true
    for (const row of headers) {
      if (limitHit || budget.bytes >= MAX_READ_BYTES) { limitHit = true; break }
      if (row.key === null) { note('journal-key-invalid', 'error', reportRef); coverage.journal = false; continue }
      const rootRef = ref('session', row.key)
      if (row.size > 16 * MiB || row.size + budget.bytes > MAX_READ_BYTES) {
        note('journal-row-limit', 'unknown', rootRef); coverage.journal = false; continue
      }
      let journal, record
      try {
        const raw = query.get(row.key).value; budget.bytes += row.size
        record = parseWorkflowJournalRecord(JSON.parse(raw))
        if (record.rootSessionId !== row.key) refuse('journal-binding-invalid')
        journal = new WorkflowJournal({ get: id => id === row.key ? record : undefined,
          entries: function* () { yield [row.key, record] }, put: async () => { refuse('diagnostic-write-forbidden') } })
      } catch { note('journal-row-invalid', 'error', rootRef); coverage.journal = false; continue }
      checkedRows++
      try {
        note('journal-replay-valid', 'pass', rootRef)
        if (native) note(native.roots.has(row.key) ? 'native-root-present' : 'native-root-not-observed',
          native.roots.has(row.key) ? 'pass' : 'unknown', rootRef)
        for (const history of journal.readSnapshot(row.key).history) {
          const state = journal.readRunState(row.key, history.runId), runRef = ref('run', JSON.stringify([row.key, state.runId]))
          runCount++
          try {
          for (const agent of Object.values(state.assignments)) {
            const target = ref('session', agent.agentSessionId), entry = native?.children.get(agent.agentSessionId)
            if (native) {
              if (!entry) note('native-child-not-observed', 'unknown', target, runRef)
              else if (entry.parent !== row.key || entry.root !== row.key) note('native-child-binding-mismatch', 'error', target, runRef)
              else if (entry.entry.kind === 'diagnostic') note('native-child-unreadable', 'unknown', target, runRef)
              else if (agent.status === 'running' && entry.entry.activity !== 'running') note('running-record-without-native-activity', 'unknown', target, runRef)
              else if (agent.status !== 'running' && entry.entry.activity === 'running') note('native-activity-after-role-settlement', 'warning', target, runRef)
              else note('native-child-binding-present', 'pass', target, runRef)
            }
            if (agent.runtimeIssue?.status === 'unknown' || agent.runtimeIssue?.status === 'stopping') note('role-exit-unverified', 'warning', target, runRef)
          }
          for (const command of Object.values(state.commands)) {
            if (['running', 'unknown'].includes(command.status)) note('command-exit-unverified', 'warning', ref('command', JSON.stringify([row.key, state.runId, command.commandId])), runRef)
          }
          if (state.rollbackTransaction && state.rollbackTransaction.phase !== 'cleaned') note('rollback-unfinished', 'warning', runRef)
          let workspace
          try { workspace = projectContract(state).workspaceRoot } catch { /* Text and generic historic records have no project contract. */ }
          let allowed
          if (workspace && isAbsolute(workspace) && approvedRoots.some(root => {
            const part = relative(root, resolve(workspace))
            return !part || (!part.startsWith('..') && !isAbsolute(part))
          })) {
            try { allowed = await regularPath(workspace, 'directory') }
            catch { note('workspace-root-unavailable', 'unknown', ref('workspace', workspace), runRef); coverage.workspace = false }
          }
          const expected = new Map()
          const expectFile = (name, value) => expected.set(name.toLocaleLowerCase('en-US'), { name, value })
          for (const artifact of Object.values(state.records).filter(record => record.kind === 'artifact')) {
            const target = ref('artifact', JSON.stringify([row.key, state.runId, artifact.recordId, artifact.version]))
            if (artifact.data.artifactType === 'text/plain') await checkObject(artifact.data.digest, 'text', target, runRef)
            else if (artifact.data.artifactType === 'workspace-file') expectFile(artifact.data.name, { kind: 'file', digest: artifact.data.digest })
            else note('artifact-type-not-inspected', 'unknown', target, runRef)
          }
          // Replay the actual order of checkpoints and rollbacks; do not compare
          // an already-reverted delivery artifact as if it were still current.
          for (const { data: event } of record.events) {
            if (event.runId !== history.runId) continue
            if (event.name === 'checkpoint/file-observed') expectFile(event.payload.path, event.payload.after)
            if (event.name === 'rollback/applied') {
              const checkpoint = state.checkpoints[event.payload.checkpointId]
              for (const file of event.payload.files) expectFile(file.path, checkpoint.files[file.path.toLocaleLowerCase('en-US')].before)
            }
          }
          for (const checkpoint of Object.values(state.checkpoints)) for (const file of Object.values(checkpoint.files)) {
            if (file.before.kind === 'file') await checkObject(file.before.digest, 'checkpoint', ref('file', String(workspace ?? '') + '/' + file.path), runRef, file.before.bytes)
          }
          for (const { name, value: expectedState } of expected.values()) {
            const target = ref('file', String(workspace ?? '') + '/' + name)
            if (!allowed) { note('workspace-not-authorized', 'unknown', target, runRef); coverage.workspace = false; continue }
            try {
              const path = inside(allowed, name), bytes = await boundedRead(path, 16 * MiB, budget)
              const matches = expectedState.kind === 'file' && sha(bytes) === expectedState.digest
                && (expectedState.bytes === undefined || expectedState.bytes === bytes.length)
              note(matches ? 'workspace-matches-record' : 'workspace-diverged', matches ? 'pass' : 'warning', target, runRef)
            } catch (error) {
              const failure = fileFailure(error)
              if (failure === 'missing') note(expectedState.kind === 'absent' ? 'workspace-matches-record' : 'workspace-diverged', expectedState.kind === 'absent' ? 'pass' : 'warning', target, runRef)
              else { note(`workspace-${failure}`, 'unknown', target, runRef); coverage.workspace = false }
            }
          }
          } catch {
            coverage.immutableObjects = false; coverage.workspace = false
            note('run-inspection-incomplete', 'unknown', runRef)
          }
        }
      } finally { await journal.close() }
    }
  } catch (error) {
    coverage.journal = false
    note(error instanceof InspectionRefusal ? error.code : 'snapshot-unreadable', 'unknown', reportRef)
  } finally {
    try { db?.close() } catch { note('temporary-reader-close-unconfirmed', 'unknown', reportRef) }
    if (workingDirectory) {
      try {
        // Only these exact temporary files can be removed; no recursive delete,
        // no source paths, and unexpected contents keep the directory intact.
        await regularPath(workingDirectory, 'directory')
        for (const name of ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm']) {
          try { await unlink(join(workingDirectory, name)) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        }
        await rmdir(workingDirectory)
      } catch { note('temporary-copy-cleanup-unconfirmed', 'warning', ref('temporary', workingDirectory)) }
    }
  }
  if (limitHit) { checks.push({ code: 'inspection-limit', status: 'unknown', target: reportRef }); coverage.journal = false }
  const counts = { pass: 0, warning: 0, error: 0, unknown: 0 }
  for (const check of checks) counts[check.status]++
  const report = { schemaVersion: 1, mode: 'read-only-inspection', status: counts.error || counts.warning ? 'needs-attention'
    : counts.unknown || Object.values(coverage).some(value => !value) ? 'incomplete' : 'no-conflicts-observed',
    coverage, checkedRows, runCount, counts, native: nativeSummary, checks: checks.map(check => ({ ...check, message: diagnosticMessage(check.code) })),
    limitations: ['non-atomic-observations', 'not-process-exit-proof', 'workspace-drift-is-not-necessarily-corruption',
      'no-repair-or-approval', 'only-referenced-objects-checked', 'artifact-locators-not-followed-or-certified', 'shareable-report-excludes-private-reference-map'] }
  return { report, privateReferences }
}

function diagnosticMessage(code) {
  const messages = {
    'journal-replay-valid': '记录通过当前协议和事件顺序校验。',
    'journal-row-invalid': '此行不能通过协议校验；保留原始记录，不能重置或补写。',
    'run-inspection-incomplete': '此运行的交叉核对未完成，不能据此判断记录损坏；其他运行仍继续检查。',
    'native-capture-present': '已取得近期原生只读观察；不是跨系统原子快照或退出证明。',
    'native-capture-partial': '原生观察有读取失败，不能声称全部已核对。',
    'native-capture-stale': '原生观察过期或时间不可信，请重新采集后比较。',
    'native-capture-invalid': '原生采集文件缺少必要字段或格式不兼容。',
    'native-capture-not-supplied': '未提供原生观察，不能判断工作流与原生会话是否对应。',
    'native-root-present': '工作流根会话在原生目录中有对应项。',
    'native-root-not-observed': '原生采集未观察到根会话；不据此判断记录丢失或后台已停。',
    'native-child-not-observed': '原生采集未观察到该角色；退出仍未核实。',
    'native-child-binding-mismatch': '原生父子关系与工作流角色绑定不一致，需要人工核对。',
    'native-child-binding-present': '原生目录中存在对应父子关系；不代表业务通过或进程已退出。',
    'native-child-unreadable': '原生目录不能读取该角色描述，不能作为健康或退出证明。',
    'native-catalog-corrupt': '原生目录报告描述不可用或格式异常；该代码不能单独定位根因。',
    'native-catalog-unsupported': '原生目录报告不兼容，需按对应版本检查。',
    'native-catalog-unavailable': '原生目录当前无法读取；可能涉及历史格式不兼容或其他读取失败，需另行核对。',
    'running-record-without-native-activity': '日志仍为运行态，但原生观察没有活动；停止状态未确认。',
    'native-activity-after-role-settlement': '角色已有结算，但采集时仍观察到活动，需要核对采集时间及作用域。',
    'role-exit-unverified': '角色退出尚无完整证据，不能因原生 inactive 或缺席改为已停。',
    'command-exit-unverified': '命令退出尚未完整结算，不能自动重跑。',
    'rollback-unfinished': '文件撤销仍需处理；检查点可读不代表事务已完成。',
    'immutable-object-matches': '已引用的不可变对象内容和摘要一致。',
    'immutable-object-mismatch': '已引用的不可变对象摘要或大小不一致，保留现场。',
    'immutable-missing': '记录引用的不可变对象缺失，无法保证后续恢复。',
    'workspace-matches-record': '当前文件与所比较的记录边界一致。',
    'workspace-diverged': '当前文件不同于历史记录；可能是后续编辑，不直接判为损坏。',
    'workspace-not-authorized': '没有显式允许读取此工作区，本项未检查。',
    'snapshot-has-sidecars': '存在非空 WAL 或回滚日志；请先制作一致性备份，不能丢弃旁文件读取主库。',
  }
  return messages[code] ?? '本项未完成可靠核对；按检查代码检查访问范围、文件格式或读取限额，不自动修复。'
}
