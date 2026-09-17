import { z } from 'zod'
import type { WorkflowRunState } from './workflow-events.ts'
import { KEEP_UNKNOWN_LABEL, MANUAL_CLOSE_LABEL, MANUAL_CLOSE_QUESTION, MANUAL_CLOSE_HEADER } from './workflow-ui-contract.ts'
export { KEEP_UNKNOWN_LABEL, MANUAL_CLOSE_LABEL } from './workflow-ui-contract.ts'

const id = z.string().trim().min(1).max(256)
const note = z.string().trim().min(1).max(2000)
const evidence = z.array(z.strictObject({ source: note, observation: note })).min(1).max(5)
const check = z.strictObject({ assignmentId: id, incidentId: id, evidence })

/** Model-supplied statements are a proposal, never an exit receipt or approval. */
export const reconciliationSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  reason: note,
  checks: z.array(check).min(1).max(20),
})
export const manualCloseRequestSchema = z.strictObject({
  gateId: id,
  reason: note,
  checks: z.array(check.extend({
    taskVersion: z.number().int().positive(),
    commandIds: z.array(id).max(100),
  })).min(1).max(20),
})
export type ManualCloseRequest = z.infer<typeof manualCloseRequestSchema>

/** Fail closed until startup has classified every old running range. */
export function unknownRuntimeScope(state: WorkflowRunState) {
  if (state.outcome || state.manualClose) throw new Error('本轮已结束，不能重复人工处置')
  const agents = Object.values(state.assignments)
  if (agents.some(agent => agent.runtimeIssue?.status === 'stopping'
    || (agent.status === 'running' && agent.runtimeIssue?.status !== 'unknown'))
    || Object.values(state.commands).some(command => command.status === 'running')) {
    throw new Error('仍有运行或回收中的范围；先等待 Host 分类与回收，不能人工结束')
  }
  const unknown = agents.filter(agent => agent.runtimeIssue?.status === 'unknown')
  if (!unknown.length) throw new Error('本轮没有未确认停止的范围')
  if (Object.values(state.commands).some(command => command.status === 'unknown'
    && !unknown.some(agent => agent.assignmentId === command.assignmentId))) {
    throw new Error('存在未关联中断的命令，不能遗漏处置')
  }
  return unknown.map(agent => ({
    assignmentId: agent.assignmentId,
    incidentId: agent.runtimeIssue!.incidentId,
    taskVersion: agent.taskVersion,
    commandIds: Object.values(state.commands).filter(command => command.assignmentId === agent.assignmentId
      && command.status === 'unknown').map(command => command.commandId).sort(),
  })).sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))
}

/** Exact coverage, not a caller-selected subset. Historical unknowns stay intact. */
export function assertManualCloseScope(state: WorkflowRunState, request: ManualCloseRequest): void {
  const expected = unknownRuntimeScope(state)
  const actual = request.checks.map(({ evidence: _evidence, ...scope }) => ({ ...scope, commandIds: [...scope.commandIds].sort() }))
    .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))
  if (expected.length !== actual.length || expected.some((item, index) => {
    const other = actual[index]!
    return item.assignmentId !== other.assignmentId || item.incidentId !== other.incidentId
      || item.taskVersion !== other.taskVersion || JSON.stringify(item.commandIds) !== JSON.stringify(other.commandIds)
  })) throw new Error('人工处置范围不匹配：遗漏、重复或旧版本；请重新读取状态并逐项核实')
}

// User-provided evidence is rendered as text, not executable links or Markdown.
const plain = (value: string) => value.replace(/[\r\n]+/gu, ' ').replace(/[\\`*_{}\[\]()#+.!<>|~-]/gu, '\\$&')
export function manualCloseQuestion(state: WorkflowRunState, request: ManualCloseRequest) {
  return {
    id: request.gateId,
    header: MANUAL_CLOSE_HEADER,
    question: MANUAL_CLOSE_QUESTION,
    detail: [
      '本次只结束旧工作流，不执行停止命令、不恢复文件，也不续跑或重试。新任务仍需重新确认。',
      '',
      '**请核对以下核实陈述。它们由协调 Agent 整理，系统未独立验证其真实性。**',
      ...request.checks.flatMap((item, index) => {
        const agent = state.assignments[item.assignmentId]!
        const task = state.records[`task:${agent.taskId}`]
        const title = task?.kind === 'task' ? task.data.title : agent.taskId
        return ['', `**${index + 1}. ${plain(title)} · v${item.taskVersion}**`,
          `未确认停止的命令：${item.commandIds.length} 条。核实必须覆盖旧 Agent、命令及其可能产生的后台工作和外部影响。`,
          ...item.evidence.map(entry => `- 依据：${plain(entry.source)}；观察：${plain(entry.observation)}`)]
      }),
      '', `处置原因：${plain(request.reason)}`, '',
      '只有已核实旧 Agent、命令及可能的后台工作不再执行，且外部影响已明确，才选择人工结束。仅看到旧 PID 消失、空列表或停止请求被接受，不是完整范围退出证明。',
      '确认后记录为「人工结束（ABANDONED）」，不是 PASS 或已确认取消。原 unknown、exitConfirmed=false 与验收待验证记录保留；操作者身份仍未核验。',
    ].join('\n'),
    options: [
      { label: KEEP_UNKNOWN_LABEL, description: '保留未确认停止，不产生结束结论。' },
      { label: MANUAL_CLOSE_LABEL, description: '记录本次核实与处置决定，不声称 Host 已证实进程退出。' },
    ],
    multiSelect: false,
    intent: { kind: 'plan-review' as const, approve: MANUAL_CLOSE_LABEL },
  }
}
