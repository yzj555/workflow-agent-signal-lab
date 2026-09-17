/** Audit saved observations + live read-only storage; no provider calls or approval writes. */
import assert from 'node:assert/strict'
import { readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { base, root, testId, guard } from './budget-online-records.mjs'

const json = async name => JSON.parse(await readFile(join(base, name), 'utf8'))
const stages = {}
for (const name of ['draft-observed-1', 'observe-submitted', 'topup-pending', 'topup-approved', 'topup-waiting',
  'resume-submitted', 'resumed-blocked', 'end-approved', 'ended-before-restore', 'ended-after-restore']) {
  const report = stages[name] = await json(`${name}.json`)
  assert.equal(report.testId, testId)
  assert.equal(report.protectedRecords, 17)
  assert.deepEqual(report.errors, [])
  assert.equal(report.after.children.entries.length, 0)
  assert.equal(report.after.snapshot.run.agents.length, 0)
}
const snapshot = name => stages[name].after.snapshot
const budget = name => snapshot(name).run.budget
const initial = budget('draft-observed-1')
assert.deepEqual(initial.limits, { modelRequests: 1, commands: 1, activeMs: 1800000 })
assert.equal(initial.used.rootModel, 1)
assert.equal(budget('observe-submitted').blocked.resource, 'root-model')
assert.equal(budget('observe-submitted').used.rootModel, 1)
const pending = budget('topup-pending'), approved = budget('topup-approved'), waiting = budget('topup-waiting')
assert.equal(pending.recovery.requests[0].status, 'pending')
assert.equal(approved.recovery.requests[0].status, 'approved')
assert.deepEqual(approved.recovery.requests[0].add, { modelRequests: 1, commands: 0, activeMs: 0 })
assert.deepEqual(approved.used, pending.used)
assert.equal(approved.limits.modelRequests, 2)
assert.equal(approved.recovery.awaitingResume, true)
assert.deepEqual(waiting, approved)
assert.equal(stages['topup-waiting'].after.session.running, false)
const resumed = budget('resumed-blocked')
assert.equal(resumed.recovery.resumes, 1)
assert.equal(resumed.recovery.blocks, 2)
assert.equal(resumed.used.rootModel, 2)
assert.equal(resumed.blocked.resource, 'root-model')
const ended = budget('ended-after-restore')
assert.equal(ended.recovery.closed, true)
assert.deepEqual(ended.used, resumed.used)
assert.deepEqual(ended, budget('ended-before-restore'))
assert.equal(snapshot('ended-after-restore').revision, 10)
assert.equal(snapshot('ended-after-restore').run.outcome, 'CANCELLED')
assert.deepEqual(stages['ended-after-restore'].testRecord, stages['ended-before-restore'].testRecord)
assert.equal(ended.recovery.requests.length, 2)
for (const request of ended.recovery.requests) {
  assert.equal(request.status, 'approved')
  assert.deepEqual(request.decisionAudit, { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: request.id })
}
const messages = name => stages[name].after.history.records.filter(x => x.event.type === 'assistant/message')
assert.equal(messages('resumed-blocked').length, 6)
assert.equal(messages('ended-after-restore').length, 6, 'ending/restart must not generate another model response')
const attempts = stages['ended-after-restore'].after.history.records.filter(x => x.event.type === 'assistant/attempt')
assert.equal(attempts.length, 2)
assert.ok(attempts.every(x => x.event.data.stream.length === 0))
const calls = stages['ended-after-restore'].after.history.records.filter(x => x.event.type === 'tool/call').map(x => x.event.data.name)
assert.ok(calls.every(name => ['workflow_status', 'workflow_propose', 'workflow_budget'].includes(name)))
assert.ok(snapshot('ended-after-restore').run.tasks.every(x => x.status === 'cancelled'))
assert.equal(snapshot('ended-after-restore').run.ledger.pass, 0)
assert.equal(snapshot('ended-after-restore').run.ledger.fail, 0)
assert.deepEqual(await readFile(join(root, 'cordis.patch.yml')), await readFile(join(base, 'baseline/cordis.patch.yml')))
const checked = await guard()
assert.deepEqual(checked.testRecord, stages['ended-after-restore'].testRecord)
const idle = await json('final-idle.json')
for (const key of ['running', 'active', 'failures', 'residentDiagnostics', 'unclassifiedResident']) assert.deepEqual(idle[key], [])
assert.ok(Object.values(idle.resident.queues).every(n => n === 0))
assert.ok(Object.values(idle.resident.jobs).every(jobs => jobs.length === 0))
const integrity = {}
for (const path of [join(root, '.dsh/workflow-runtime/journal.sqlite'), ...['baseline', 'activation-retry-before', 'activation-retry-after', 'restore-before', 'restore-recovered-live'].map(dir => join(base, dir, 'journal.sqlite'))]) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { integrity[path] = db.prepare('PRAGMA integrity_check').all(); assert.equal(integrity[path].length, 1); assert.equal(integrity[path][0].integrity_check, 'ok') }
  finally { db.close() }
}
const restart = await json('restore/restart.json')
assert.equal(restart.serviceRestored, true)
// This is deliberately NOT an all-green infrastructure result.
assert.equal(restart.status, 'failed')
assert.equal(restart.error, 'Post-stop backup failed; restore service in finally')
const nativePath = 'C:/Users/Administrator/.dsh/sessions/--F-dsh-workflow-agent-signal-lab--/workflow-budget-online-control-20260916/session.v3.jsonl.zstd'
await cp(nativePath, join(base, 'native-session.v3.jsonl.zstd'), { force: false, errorOnExist: true })
const hash = data => createHash('sha256').update(data).digest('hex')
const result = { checkedAt: new Date().toISOString(), result: 'mechanism-pass-with-open-issues', sessionId: testId,
  runId: ended.runId, revision: 10, outcome: 'CANCELLED', protectedRecords: checked.protectedRecords,
  totalRecords: checked.currentRecords, activeNativeSessions: idle.running.length, nativeSessionCount: idle.sessionCount,
  nativeResponseMessages: 6, rejectedEmptyAttempts: 2,
  accounting: { executionModelRequests: 2, controlModelRequests: ended.recovery.controlUsed, beforeRunResponses: 2,
    commands: 0, observedMs: ended.time.observedMs, uncertainMs: ended.time.uncertainMs, reservedMs: ended.time.reservedMs },
  nativeSessionBackupSha256: hash(await readFile(nativePath)), integrity,
  configRestoredByteForByte: true, codeUnchangedFrom306TestBaseline: true,
  owner: JSON.parse(await readFile(join(root, '.dsh/workflow-runtime/writer.lock'), 'utf8')),
  openIssues: [
    '预算阻塞的正文正确，但顶部主状态被通用“待你确认”覆盖，未直显预算原因。',
    '预算结束后已无 Agent/任务运行，界面仍称“交付已结束，正在整理可复用经验”，并标“待沉淀”；应由真实活动与结束事实驱动。',
    '预算原生 plan-review 显示通用“计划待审／确认执行”，没有直接展示补额／结束动作标题；实际冻结请求和 native answer 审计正确。',
    '第二次停机后的只读备份查询报 SQLite disk I/O error（errcode=1546），该停机后备份缺失；前置备份与恢复后补充备份通过完整性及内容比对，不据此宣称停机备份路径通过。',
  ],
  limitations: ['仅验证根请求耗尽、一次精确补额、用户继续、原生结束和空闲重启后持久化。',
    '未运行子 Agent、冻结命令、时长耗尽、活动租约重启、并行竞争或性能校准。',
    '原生 55 条非驻留历史 diagnostic 未处置，不宣称所有历史 Session 健康或所有外部进程均已停止。',
    '未修改产品运行时代码、未重跑306项；原构建哈希保持，不能将本次浏览器步骤新增计入单元测试数量。'],
}
await writeFile(join(base, 'verification.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ ...result, integrity: `${Object.keys(integrity).length} databases: integrity_check ok` }, null, 2))
