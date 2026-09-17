import type { WorkflowRunState } from './workflow-events.ts'
import type { BudgetRequest, RunBudgetAccount } from './workflow-run-budget.ts'
import { BUDGET_END_LABEL, BUDGET_TOPUP_LABEL, MAX_RUN_TOPUPS, runTimeSummary, formatRunTime } from './workflow-run-budget.ts'
import { BUDGET_HEADER, BUDGET_KEEP_LABEL, BUDGET_TOPUP_QUESTION, BUDGET_END_QUESTION } from './workflow-ui-contract.ts'

/** Ledger facts only. The controller ALSO checks live leases before asking/settling. */
export function assertBudgetAction(state: WorkflowRunState, account: RunBudgetAccount, action: 'topup' | 'end'): void {
  if (!account.blocked || account.recovery?.closed) throw new Error('本轮没有待处置的预算阻塞')
  if (state.manualClose && action === 'end') return // Preserve ABANDONED and all unknown evidence.
  if (Object.values(state.assignments).some(item => item.runtimeIssue
    ? item.runtimeIssue.status !== 'stopped' : item.status === 'running')
    || Object.values(state.commands).some(item => item.status === 'running' || !item.observation?.exitConfirmed || !item.observation.toolSettled)) {
    throw new Error('执行范围仍在运行、回收或未确认停止；先核实，不允许补额或宣称已结束')
  }
  if (action === 'topup') {
    if (state.outcome || Object.values(state.assignments).some(item => item.runtimeIssue)) {
      throw new Error('已结束或中断的角色不能靠补额复活；确认停止后可申请结束，再重新确认新任务')
    }
    if ((account.recovery?.requests.filter(item => item.action === 'topup' && item.status === 'approved').length ?? 0) >= MAX_RUN_TOPUPS) {
      throw new Error('本轮已达到三次补额上限；可核对并结束，不能自动重置预算')
    }
  }
}

const plain = (value: string) => value.replace(/[\r\n]+/gu, ' ').replace(/[\\`*_{}\[\]()#+.!<>|~-]/gu, '\\$&')
export function budgetQuestion(account: RunBudgetAccount, request: BudgetRequest) {
  const topup = request.action === 'topup'
  const approve = topup ? BUDGET_TOPUP_LABEL : BUDGET_END_LABEL
  return {
    id: request.id, header: BUDGET_HEADER, question: topup ? BUDGET_TOPUP_QUESTION : BUDGET_END_QUESTION,
    detail: [
      '**额度明细**', '',
      '| 项目 | 已使用 / 当前上限 | 本次增加 | 确认后上限 |',
      '| --- | --- | --- | --- |',
      `| 模型请求 | ${account.used.rootModel + account.used.childModel} / ${account.limits.modelRequests} 次 | ${topup ? request.add.modelRequests : 0} 次 | ${account.limits.modelRequests + (topup ? request.add.modelRequests : 0)} 次 |`,
      `| 检查命令 | ${account.used.commands} / ${account.limits.commands} 次 | ${topup ? request.add.commands : 0} 次 | ${account.limits.commands + (topup ? request.add.commands : 0)} 次 |`, '',
      ...(account.time ? [runTimeSummary(account), ''] : []),
      topup
        ? `本次增加：模型 ${request.add.modelRequests} 次、检查命令 ${request.add.commands} 次。累计上限变为 ${account.limits.modelRequests + request.add.modelRequests} 次模型请求、${account.limits.commands + request.add.commands} 次命令。`
        : '确认后不再推进本轮，保留产物、验收和预算记录；不撤销文件，不删除数据。已有终态和人工处置结论保持原样。',
      ...(topup && account.time ? ['', `有效时长本次增加 ${formatRunTime(request.add.activeMs ?? 0)}；累计上限变为 ${formatRunTime(account.limits.activeMs! + (request.add.activeMs ?? 0))}。`] : []),
      '', '**申请原因**', '', plain(request.reason), '', '**确认后的影响**', '',
      topup ? '仅改变额度，不扩大任务或工具权限、不代替执行确认、不恢复已中断 Agent。确认后等待你在原生输入框明确继续。' : '这不是验收通过，也不补造任何进程退出证据。新任务仍需重新确认。',
      '', '次数与有效时长不是 Token 账单或金额保证；等待用户的空闲不计时，并行角色重叠区间只计一次。',
    ].join('\n'),
    options: [{ label: BUDGET_KEEP_LABEL, description: '不增加额度，不改变本轮结论。' },
      { label: approve, description: topup ? '只增加本次列明的额度，累计用量不清零。' : '记录结束决定，不继续执行。' }],
    multiSelect: false, intent: { kind: 'plan-review' as const, approve },
  }
}
