import { WORKFLOW_STAGES } from '../workflow-contract.ts'
import type { WorkflowStage } from '../workflow-contract.ts'
import { PROJECT_PILOT, TEXT_PILOT } from '../workflow-profiles.ts'
import type { WorkflowRunView } from '../workflow-view.ts'

export type StageState = 'done' | 'current' | 'locked' | 'waiting' | 'blocked' | 'failed'
  | 'ended' | 'rolled_back' | 'not_run' | 'merged' | 'not_required' | 'unavailable' | 'unconfirmed'
export interface StagePresentation { state: StageState; label: string; reason: string }

export function workflowHasPendingLearning(run: WorkflowRunView): boolean {
  return (run.learning?.candidates.some(item => item.status === 'pending' || item.status === 'revision-required')
      && !run.learning.decisionRecorded)
    || (run.proposedLearningCount > 0 && !run.learningDecided)
}

/** A missing event is not evidence of an approved skip or a completed stage. */
export function stagePresentations(run: WorkflowRunView): readonly StagePresentation[] {
  const terminal = run.outcome !== null
  const textRoute = run.executionProfile === TEXT_PILOT
  const projectRoute = run.executionProfile === PROJECT_PILOT
  const stage = (key: WorkflowStage): StagePresentation => {
    if (key === 'delivery' && run.rollback?.pending) return {
      state: 'unconfirmed', label: run.rollback.pending.phase === 'applied' ? '已撤销 · 待清理' : '撤销未完成',
      reason: '原交付结论只作历史。' + run.rollback.pending.reason,
    }
    const tasks = run.tasks.filter(task => task.stage === key)
    if (run.manualClose) {
      if (key === 'delivery') return { state: 'ended', label: '人工结束', reason: '原生门禁记录了核实后的人工处置；不是验收通过或 Host 确认取消。' }
      if (key === 'learning' && !run.learning?.reviewed) return { state: 'not_run', label: '未整理', reason: '人工结束不会自动整理或采纳长期规则。' }
      if (tasks.some(task => task.status !== 'completed')) return { state: 'ended', label: '未完成 · 已结束', reason: '本轮已人工结束；原任务与退出证据保留，未被改为成功、已停止或已跳过。' }
    }
    const latest = new Map<string, WorkflowRunView['gates'][number]>()
    for (const gate of run.gates.filter(gate => gate.stage === key)) {
      latest.set(`${gate.kind}:${[...gate.scopeTaskIds].sort().join(',')}`, gate)
    }
    const gates = [...latest.values()].filter(gate => gate.status !== 'cancelled')
    const rollbackApplied = run.rollback?.latestApplied ?? null
    const stale = tasks.some(task => task.stale || task.status === 'invalidated')
      || gates.some(gate => gate.stale && gate.status !== 'rejected')
    if (stale) return { state: 'unconfirmed', label: terminal ? '记录已失效' : '待重新验证', reason: '本阶段使用的输入版本已变化；旧完成或批准记录不能继续视为有效。' }
    if (tasks.some(task => task.status === 'failed')) return { state: 'failed', label: terminal ? '未通过' : '待返工', reason: '本阶段存在未通过的任务；未记为完成，也没有把它当成跳过。' }
    if (tasks.some(task => task.status === 'running')) return { state: terminal ? 'unconfirmed' : 'current', label: '运行记录', reason: terminal ? '本轮已有结束结论，但仍留有运行态记录；不能据此推断进程已停止。' : '日志记录本阶段有任务运行；这不是进程实时心跳。' }
    const waitingGate = gates.find(gate => gate.status === 'waiting' && !gate.stale)
    if (waitingGate) return waitingGate.kind === 'rollback'
      ? { state: 'waiting', label: '待撤销确认', reason: '工作流已停止或结束；文件仍保持现状，等待用户在原生撤销预览中明确决定。' }
      : {
        state: terminal ? 'unconfirmed' : 'waiting', label: terminal ? '尚未确认' : '待确认',
        reason: terminal ? '结束结论没有代替此门禁的确认；请核对原生记录。' : '本阶段还有有效门禁等待确认；请在原生问答中处理。',
      }
    if (key === 'delivery' && rollbackApplied !== null) return {
      state: 'rolled_back',
      label: '已撤销',
      reason: `检查点 ${rollbackApplied.checkpointId} 的 ${String(rollbackApplied.fileCount)} 个文件变化已通过原生用户权限门禁恢复；实际操作者未核验，原交付结论仅作历史记录。`,
    }
    if (tasks.some(task => task.status === 'blocked') || gates.some(gate => gate.status === 'rejected')) return {
      state: 'blocked', label: terminal ? '未执行' : '已阻止', reason: '本阶段有被阻止的任务或未获批准的门禁；不是已完成或获准跳过。',
    }
    if (key === 'learning') {
      if (run.learning?.reviewed) {
        if (run.learning.candidates.length === 0) return {
          state: 'not_required', label: '本轮无候选', reason: 'Agent 已检查本轮证据，没有发现值得长期复用的经验，因此没有打扰用户。',
        }
        if (!run.learning.decisionRecorded) {
          const returned = run.learning.candidates.filter(item => item.status === 'revision-required').length
          return returned > 0
            ? { state: 'waiting', label: `待修订 ${String(returned)} 条`, reason: '其他候选决定已保存；请在原生输入框说明被退回项的具体改法，只会重新确认对应候选。' }
            : { state: 'waiting', label: '待你决定', reason: '交付已有结论，但仍有单项候选等待原生决定；已经完成的其他决定保持不变。' }
        }
        const accepted = run.learning.candidates.filter(item => item.status === 'accepted').length
        const revoked = run.learning.candidates.filter(item => item.status === 'revoked').length
        if (accepted > 0) return {
          state: 'done', label: `已沉淀 ${String(accepted)} 条`, reason: run.learning.decisionAudit
            ? '原生用户权限门禁已逐项记录裁决，实际操作者未核验；规则带作用域、来源与版本，只在后续确定性匹配时进入待确认需求。'
            : '兼容历史记录显示候选已被逐项采纳，但没有新版操作者来源审计；规则只在后续确定性匹配时进入待确认需求。',
        }
        if (revoked > 0) return { state: 'ended', label: '已停用', reason: '本轮采纳的规则已有原生用户权限门禁停用记录；不据此推断实际操作者，原候选、采纳和停用记录仍保留。' }
        return { state: 'ended', label: '未采纳', reason: run.learning.decisionAudit
          ? '原生用户权限门禁已记录取舍，实际操作者未核验；本轮候选只保留为历史，不影响后续任务。'
          : '兼容历史记录显示取舍已完成，但没有新版操作者来源审计；本轮候选只保留为历史。' }
      }
      if (run.learningDecided) return { state: 'ended', label: '已作决定', reason: '旧版记录显示用户已作沉淀取舍，但没有新版作用域与生效明细；不额外声称规则已经永久存储或生效。' }
      if (workflowHasPendingLearning(run)) return { state: 'waiting', label: '待你决定', reason: '交付已有结论，但还有沉淀建议等待用户决定；没有自动采纳。' }
      if (terminal) return { state: 'not_run', label: '未整理', reason: run.budget?.recovery?.closed
        ? '本轮已通过预算处置结束；没有经验整理记录，不会自动整理或采纳规则。'
        : '本轮已经结束，尚无经验整理记录；不能据此声称正在运行或已检查后无候选。' }
      return { state: 'locked', label: '交付后整理', reason: '本阶段在本轮结束后检查证据；在交付前不会提前生成长期规则。' }
    }
    if (key === 'delivery' && terminal) {
      if (run.outcome === 'FAIL' || run.outcome === 'CANCELLED') return { state: 'not_run', label: '未交付', reason: `本轮${run.outcome === 'FAIL' ? '未通过' : '已取消'}；有结束结论不等于成功交付。` }
      if (run.tasks.some(task => task.stale || task.status !== 'completed') || run.ledger.pending > 0 || run.ledger.fail > 0) {
        return { state: 'unconfirmed', label: '待核对', reason: '交付结论与当前任务／验收记录不一致，不能标为完成。' }
      }
      return run.outcome === 'PASS'
        ? { state: 'done', label: '已交付', reason: '控制层已保存本轮通过结论，交付阶段已结束。' }
        : { state: 'ended', label: '有条件交付', reason: '控制层已保存有条件通过结论；交付已结束，但不是全部标准通过。' }
    }
    if (tasks.length > 0 && tasks.every(task => task.status === 'completed')
      && gates.every(gate => gate.status === 'approved' && !gate.stale)) {
      return { state: 'done', label: '已完成', reason: '本阶段的当前任务均已完成，且没有未解决或失效的门禁。' }
    }
    if (tasks.length === 0 && gates.length > 0 && gates.every(gate => gate.status === 'approved' && !gate.stale)) {
      return {
        state: 'done',
        label: '已确认',
        reason: gates.every(gate => gate.decisionAudit !== undefined)
          ? '本阶段的当前门禁已有有效批准记录；原生用户权限有效，实际操作者未核验。'
          : '本阶段的当前门禁已有有效批准记录；兼容历史记录没有新版操作者来源审计。',
      }
    }
    // Only the Host-identified, versioned text contract defines these route
    // omissions. Actual tasks/gates above always take precedence over a hint.
    if (textRoute && tasks.length === 0 && gates.length === 0) {
      if (key === 'planning') return { state: 'merged', label: '并入需求确认', reason: '本版在需求阶段形成内容与验收的串行计划，并随合同一起确认；不另设独立规划执行阶段。' }
      if (key === 'review') return { state: 'not_required', label: '本次无需', reason: '本次文本合同没有额外审查步骤；独立验收在“验证”阶段执行，并未跳过验收。' }
    }
    if (projectRoute && tasks.length === 0 && gates.length === 0) {
      if (key === 'planning') return { state: 'not_required', label: '本次无需', reason: '当前合同是局部变更，不需要独立只读方案阶段；跨模块或架构变更会在此阶段安排方案 Agent。' }
    }
    if (terminal && tasks.some(task => task.status === 'cancelled')) return { state: 'ended', label: '已取消', reason: '本阶段仍有被取消的任务；不会因为整个运行结束而标成完成或获准跳过。' }
    if (terminal && tasks.some(task => task.status === 'completed')) return { state: 'ended', label: '未全部完成', reason: '本阶段只完成了部分任务；本轮结束不等于这一阶段全部完成。' }
    if (terminal) return { state: 'not_run', label: '未执行', reason: '本轮已结束，本阶段没有有效完成记录；没有明确跳过记录时，不推断它已获准跳过或本次无需。' }
    if (key === run.stage) return { state: 'current', label: '当前阶段', reason: '控制层当前定位在此阶段；只有具体完成或批准记录才能标记结束。' }
    return { state: 'locked', label: tasks.length > 0 ? '待执行' : '暂无记录', reason: tasks.length > 0 ? '本阶段已安排任务，尚未记录执行完成。' : '还没有本阶段的独立任务或门禁记录；不据此推断跳过。' }
  }
  return WORKFLOW_STAGES.map(stage)
}
