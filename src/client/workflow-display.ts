import { WORKFLOW_STAGES } from '../workflow-contract.ts'
import type { WorkflowClientState } from './workflow-source.ts'
import type { WorkflowRunView, WorkflowSnapshot } from '../workflow-view.ts'
import { PROJECT_PILOT } from '../workflow-profiles.ts'
import { stagePresentations, workflowHasPendingLearning } from './workflow-stage-display.ts'
import { RUN_BUDGET_STOP_MESSAGE, runTimeSummary } from '../workflow-run-budget.ts'
import type { StagePresentation, StageState } from './workflow-stage-display.ts'

export type StageTone = 'active' | 'gate' | 'return' | 'done'
export type AgentTone = 'active' | 'done' | 'failed' | 'waiting'
export type ManualCloseRecord = NonNullable<WorkflowRunView['manualClose']>
export interface AgentLine {
  label: string; detail: string; status: string; tone: AgentTone
  verification?: ManualCloseRecord['checks'][number]
  interruptionHistory?: readonly string[]
}
export interface LearningLine {
  id: string; statement: string; detail: string; status: string
  tone: 'active' | 'done' | 'muted' | 'warning'
}
export interface PlanMilestone {
  label: string; status: string; detail: string
  tone: 'done' | 'current' | 'waiting' | 'locked' | 'failed'
}
export interface WorkflowPlanProjection {
  modeLabel: string; summary: string; milestones: readonly PlanMilestone[]
  contract: NonNullable<WorkflowRunView['plan']>
}
export interface WorkflowProjection {
  stageIndex: number; stageName: string; stagePurpose: string
  title: string; summary: string; live: string; now?: string; nowDetail?: string; nextDetail?: string
  attentionTitle: string; attentionDetail: string; needsUser: boolean; next: string
  source: string; tone: StageTone; agents: readonly AgentLine[]
  badge?: string
  uncertain?: boolean
  emptyAgentText?: string
  stageStates?: readonly StageState[]
  stageDetails?: readonly StagePresentation[]
  completionNotice?: string
  rollback?: { fileCount: number; remainingCheckpoints: number }
  learning?: { summary: string; items: readonly LearningLine[] }
  plan?: WorkflowPlanProjection
  manualClose?: ManualCloseRecord
}

export interface PreRunConversationObservation {
  blank: boolean
  hasUserGoal: boolean
  running: boolean
  pending: 'question' | 'confirmation' | null
  interrupted: boolean
  assistantText: string
  recovery?: NonNullable<WorkflowSnapshot['preRunRecovery']>
}

const roleLabels: Record<string, string> = {
  pm: '协调', researcher: '研究', architect: '架构', engineer: '实现', test_engineer: '工程测试',
  code_engineer: '代码工程', qa: '白盒测试', acceptance_qa: '独立验收',
  code_reviewer: '代码审查', security_reviewer: '安全审查', doc_reviewer: '文档审查',
}
const outcomes: Record<string, string> = { PASS: '通过', QUALIFIED: '有条件通过', FAIL: '未通过', CANCELLED: '已取消', ABANDONED: '人工结束' }

function compact(value: string, maxLength = 180): string {
  const result = value.replace(/\s+/gu, ' ').trim()
  return result.length <= maxLength ? result : `${result.slice(0, maxLength - 1).trimEnd()}…`
}

function preRunStages(stages: readonly { name: string; purpose: string }[], state: StageState,
  label: string, reason: string, terminal = false): readonly StagePresentation[] {
  return stages.map((stage, index): StagePresentation => index === 0
    ? { state, label, reason }
    : {
      state: terminal ? 'not_run' : 'locked', label: terminal ? '未启动' : '尚未开始',
      reason: `尚未建立受控运行，因此“${stage.name}”没有执行记录。`,
    })
}

/**
 * Show the preset's pre-run state without inventing a Journal run or approval.
 * This projection may identify a native question or an idle conversation, but
 * it always keeps the Signal Gate closed until committed records exist.
 */
export function displayPreRunConversation(observation: PreRunConversationObservation,
  nativeAgents: readonly AgentLine[], stages: readonly { name: string; purpose: string }[]): WorkflowProjection {
  const source = '原生对话观察 · 尚未建立受控运行记录'
  const base = {
    stageIndex: 0, stageName: stages[0]?.name ?? '需求确认',
    stagePurpose: stages[0]?.purpose ?? '弄清目标、边界和成功条件',
    source, uncertain: true, agents: nativeAgents,
    emptyAgentText: '尚未建立结构化 Agent 分工。',
  } as const
  const result = (input: {
    title: string; summary: string; now: string; live: string
    attentionTitle: string; attentionDetail: string; needsUser: boolean; next: string
    tone: StageTone; badge: string; stageState: StageState; stageLabel: string; stageReason: string
    terminal?: boolean
  }): WorkflowProjection => {
    const stageDetails = preRunStages(stages, input.stageState, input.stageLabel, input.stageReason, input.terminal)
    return { ...base, ...input, stageDetails, stageStates: stageDetails.map(stage => stage.state) }
  }

  if (observation.recovery) {
    const recovery = observation.recovery
    const needsAttention = recovery.status === 'needs-attention'
    return result({
      title: needsAttention ? '需求分析已停稳，等待你决定是否继续' : '需求分析超时，正在自动恢复一次',
      summary: `${recovery.reason} Signal Gate 仍关闭，没有创建任务或执行授权。`,
      now: needsAttention
        ? `根协调响应已停止自动恢复 · 第 ${String(recovery.attempt)} 次停滞`
        : `根协调响应已中止 · 正在自动恢复第 ${String(recovery.attempt)} 次`,
      live: needsAttention ? '没有自动续跑；受控运行尚未建立' : 'Host 正从已保存的需求入口恢复',
      attentionTitle: needsAttention ? '请在原生输入框决定是否继续' : '现在不需要操作',
      attentionDetail: needsAttention
        ? `请在原生输入框说明：可从“${recovery.resumeFrom}”继续，也可以结束；不会代替你批准 Signal Gate。`
        : `已保留：${recovery.preserved.join('；')}。若再次停滞会停止自动恢复。`,
      needsUser: needsAttention,
      next: needsAttention
        ? '收到你的新输入后建立一条新的限时监督链，不会重复旧回复。'
        : `从“${recovery.resumeFrom}”继续，只处理需求分析与澄清。`,
      tone: needsAttention ? 'return' : 'active',
      badge: needsAttention ? '需要处理' : '自动恢复中',
      stageState: needsAttention ? 'waiting' : 'current',
      stageLabel: needsAttention ? '等待处理' : '恢复中',
      stageReason: `需求入口恢复事件基于插件 Journal revision ${String(recovery.journalRevision)}，事件本身随后提交。`,
    })
  }

  if (observation.blank || !observation.hasUserGoal) return result({
    title: '等待你描述想完成的事',
    summary: '选择此预设后会先澄清目标、边界和验收方式，不会因为一句模糊表达直接开始修改。',
    now: '尚未收到本轮目标', live: '受控运行尚未建立',
    attentionTitle: '请在原生输入框描述目标', attentionDetail: '工作流页只查看状态，不在这里输入。', needsUser: true,
    next: '收到目标后先分析信息，再只询问真正影响结果的歧义。',
    tone: 'gate', badge: '等待目标', stageState: 'waiting', stageLabel: '等待目标',
    stageReason: '预设已选择，但本轮尚未收到用户目标。',
  })

  if (observation.pending !== null) {
    const confirmation = observation.pending === 'confirmation'
    return result({
      title: confirmation ? '需求已合并，等待明确确认' : '需求仍在澄清',
      summary: confirmation
        ? '确认门仍然关闭；确认前没有进入实现，也没有创建可执行授权。'
        : '原生对话正在等待一项关键信息；受控运行尚未建立，也没有进入实现。',
      now: confirmation ? '等待你确认或纠正合并后的需求' : '等待你补充原生对话中提出的关键信息',
      live: '暂停在 Signal Gate 前',
      attentionTitle: confirmation ? '请在原生对话中确认或纠正' : '请在原生对话中补充信息',
      attentionDetail: '这里不提供第二套输入；直接回复原生问题即可。', needsUser: true,
      next: confirmation ? '明确确认后才会建立受控运行并进入计划。' : '收到补充后合并目标、边界与验收标准，再请你确认。',
      tone: 'gate', badge: confirmation ? '待确认' : '待你回复', stageState: 'waiting',
      stageLabel: confirmation ? '待确认' : '待你回复',
      stageReason: confirmation ? '原生交互正在等待用户确认；尚无已批准的 Signal Gate 记录。' : '原生交互正在等待用户补充；尚未创建运行。',
    })
  }

  if (observation.running) return result({
    title: '正在理解需求',
    summary: '当前只允许分析与只读检查；没有 Journal 记录时不能把对话活动显示成实现或验证。',
    now: '主 Agent 正在分析需求，尚未进入实现', live: '原生会话运行中 · 受控运行尚未建立',
    attentionTitle: '现在不需要操作', attentionDetail: '需要补充信息时会通过原生对话明确提问。', needsUser: false,
    next: '合并目标、范围、排除项和验收标准，再进入用户确认。',
    tone: 'active', badge: '分析中', stageState: 'current', stageLabel: '分析中',
    stageReason: '只观察到原生会话仍在运行；没有据此推断门禁批准或执行阶段。',
  })

  if (observation.interrupted) return result({
    title: '本轮已停止，没有进入受控执行',
    summary: '原生需求轮次已中断，Signal Gate 没有形成有效批准记录。',
    now: '需求讨论已停止，未建立受控运行', live: '原生轮次已停止',
    attentionTitle: '现在不需要操作', attentionDetail: '需要继续时，仍从原生输入框重新说明目标。', needsUser: false,
    next: '没有自动下一步；重新提出后会再次核对当前边界。',
    tone: 'done', badge: '未启动执行', stageState: 'ended', stageLabel: '已停止',
    stageReason: '原生需求轮次已中断，且插件 Journal 为空。', terminal: true,
  })

  const assistant = compact(observation.assistantText, 800)
  const endedWithoutRun = /(?:本次|当前|结论|决定).{0,18}(?:不执行|不发送|不继续)|(?:没有|无)(?:后台|自动).{0,10}(?:任务|下一步)|未进入(?:受控)?执行/u.test(assistant)
  if (endedWithoutRun) return result({
    title: '本次讨论已结束，没有建立受控执行',
    summary: '插件 Journal 仍为空；界面不会把“不执行”画成失败、待授权或后台继续。',
    now: '讨论已经结束，本模式没有受控运行记录', live: '没有已记录的工作流运行',
    attentionTitle: '现在不需要操作', attentionDetail: '只有重新提出目标时才会开始新的需求确认。', needsUser: false,
    next: '没有自动下一步；条件具备后可在原生输入框重新提出。',
    tone: 'done', badge: '未启动执行', stageState: 'ended', stageLabel: '讨论结束',
    stageReason: '原生对话明确结束且 Journal 为空；没有把普通讨论伪装成运行。', terminal: true,
  })

  const hasMergedRequirements = /需求确认|确认单|验收标准|执行边界/u.test(assistant)
  if (hasMergedRequirements) return result({
    title: '需求已合并，等待明确确认',
    summary: '对话中已有需求确认内容，但插件没有已批准门禁记录，因此不会显示为已经开始。',
    now: '等待你确认或纠正合并后的需求', live: 'Signal Gate 尚未形成批准记录',
    attentionTitle: '请在原生对话中确认或纠正', attentionDetail: '普通的继续交流不会被当作执行授权。', needsUser: true,
    next: '明确确认后才建立受控运行并进入计划。',
    tone: 'gate', badge: '待确认', stageState: 'waiting', stageLabel: '待确认',
    stageReason: '需求内容已出现，但没有持久化的用户批准记录。',
  })

  const asksForUser = /[？?]|(?:请|需要你|还需|还缺少).{0,24}(?:补充|提供|确认|选择|回答|说明)/u.test(assistant)
  if (asksForUser) return result({
    title: '需求仍在澄清',
    summary: '目标已经收到，但关键范围尚未齐全；尚未建立受控运行，也没有进入实现。',
    now: '等待你补充原生对话中提出的关键信息', live: '暂停在 Signal Gate 前',
    attentionTitle: '请在原生对话中补充信息', attentionDetail: '这里不提供第二套输入；直接回复原生问题即可。', needsUser: true,
    next: '收到补充后合并目标、边界与验收标准，再请你确认。',
    tone: 'gate', badge: '待你回复', stageState: 'waiting', stageLabel: '待你回复',
    stageReason: '原生对话正在索取需求信息；没有执行记录。',
  })

  return result({
    title: '目标已收到，等待需求合并',
    summary: '本轮仍处于受控运行建立前；没有确认记录时不会进入实现。',
    now: '需求信息正在等待下一轮分析', live: '受控运行尚未建立',
    attentionTitle: '现在不需要操作', attentionDetail: '若存在关键歧义，Agent 会在原生对话中明确询问。', needsUser: false,
    next: '继续合并目标、边界和验收标准，再请你确认。',
    tone: 'active', badge: '待分析', stageState: 'current', stageLabel: '待分析',
    stageReason: '已收到目标，但没有持久化的运行或批准记录。',
  })
}

function historicalInterruption(agent: WorkflowRunView['agents'][number], run: WorkflowRunView): boolean {
  // Ending a run is not exit evidence. Only an explicitly confirmed stop can
  // move its former action request into history; unknown/stopping stay current.
  return run.outcome != null && agent.runtimeIssue?.status === 'stopped'
}

function agentPresentation(agent: WorkflowRunView['agents'][number], run: WorkflowRunView): Pick<AgentLine, 'status' | 'tone'> {
  if (historicalInterruption(agent, run)) return { status: '已停止 · 本轮已结束', tone: 'waiting' }
  if (agent.runtimeIssue) return {
    status: agent.runtimeIssue.status === 'stopping' ? '正在停止' : agent.runtimeIssue.status === 'stopped' ? '已停止 · 需处理' : '未确认停止',
    tone: agent.runtimeIssue.status === 'stopping' ? 'waiting' : 'failed',
  }
  // A terminal workflow result alone cannot establish that a process stopped.
  if (agent.status === 'running') return { status: '运行记录', tone: 'active' }
  if (agent.status === 'idle' || agent.status === 'completed') {
    const task = run.tasks.find(item => item.taskId === agent.taskId)
    const currentCompleted = task?.version === agent.taskVersion && !task.stale && task.status === 'completed'
    if (run.outcome !== null) {
      return run.outcome === 'PASS' && currentCompleted
        ? { status: '已完成', tone: 'done' }
        : { status: '本轮已结束', tone: 'waiting' }
    }
    return currentCompleted
      ? { status: '本轮已完成', tone: 'done' }
      : { status: '等待下一步', tone: 'waiting' }
  }
  return {
    status: agent.status === 'failed' ? '执行失败' : agent.status === 'cancelled' ? '已取消' : '已中断',
    tone: agent.status === 'failed' ? 'failed' : 'waiting',
  }
}

function childRuntimeDisplay(run: WorkflowRunView, active: number): Partial<WorkflowProjection> {
  if (run.manualClose) return {
    now: '本轮已人工结束 · 退出证据仍未知', badge: '人工结束', tone: 'return',
    nowDetail: '处置原因与裁决已留档，完整记录可展开查看。',
    manualClose: run.manualClose,
    summary: '核实陈述与处置决定已留档；原 unknown 和未完成验收记录保持不变。',
    live: '这是人工处置，不是 Host 对旧执行范围退出的证明。',
    attentionTitle: '旧运行不会自动续跑',
    attentionDetail: '新目标需重新确认。原生权限门禁有效，操作者未核验；未执行停止命令或文件撤销。',
    needsUser: run.needsUser,
    next: '新目标重新确认；不复用旧运行的执行授权。',
    completionNotice: '人工结束 · 非验收通过 · Host 退出未证实',
  }
  const pendingClose = run.gates.find(gate => gate.kind === 'runtime-recovery' && gate.status === 'waiting' && !gate.stale)
  if (pendingClose) return {
    now: '等待核实旧运行的处置决定', badge: '待人工处置', tone: 'gate',
    nowDetail: pendingClose.summary,
    summary: '请核对原生确认中的每项依据；确认仅结束旧运行，不证明进程退出，也不恢复执行。',
    attentionTitle: '需要你核对并决定', attentionDetail: '范围必须包含可能的后台工作和外部影响。尚未核实时请选择保持阻塞。',
    needsUser: true, next: '在原生确认中决定，状态变化后必须重新核对。',
  }
  const affected = run.agents.filter(agent => agent.runtimeIssue && (run.outcome === null || agent.runtimeIssue.status !== 'stopped'))
  if (!affected.length) return {}
  const unknown = affected.some(agent => agent.runtimeIssue!.status === 'unknown')
  const stopping = affected.some(agent => agent.runtimeIssue!.status === 'stopping')
  const status = unknown ? '未确认停止' : stopping ? '正在停止' : '已停止 · 需要处理'
  const roles = [...new Set(affected.map(agent => roleLabels[agent.role] ?? agent.role))].join('、')
  return {
    now: `${roles} Agent 运行中断 · ${status}`, badge: status, tone: 'return',
    nowDetail: affected.length === 1 ? affected[0]!.runtimeIssue!.reason : `${String(affected.length)} 个角色存在中断记录；逐项原因见下方 Agent 列表。`,
    summary: '执行权限已撤销。运行中断不等于业务验收失败，不消耗返工次数，也不会自动派发替代 Agent。',
    live: active > 0 ? `另有 ${String(active)} 个已授权 Agent 可独立收尾；不会因本次超时一起被取消。`
      : unknown ? '存在未确认停止的记录，不能推断后台已清空。' : stopping ? '正在等待官方生命周期回收。' : '本次中断角色的官方回收已完成。',
    attentionTitle: unknown ? '需要检查未回收的 Agent' : stopping ? '正在回收，现在不需要操作' : '需要决定如何继续',
    attentionDetail: unknown ? '未得到停止凭据前保持暂停；不会把重启、空列表或迟到报告当成回收成功。'
      : stopping ? '若回收超时，状态会明确变为“未确认停止”。' : '请在原生输入框说明下一步；重新执行前需要停止本轮并重新确认需求。',
    needsUser: unknown || !stopping,
    next: unknown ? '先核实停止状态，再决定是否重新开始；禁止自动续跑。'
      : stopping ? '先确认该角色已停止；其他已授权角色的收尾不受影响。' : '停止本轮后，按重新确认的合同开启新运行；历史证据保留。',
    nextDetail: undefined, completionNotice: `子 Agent 运行中断 · ${status}`,
  }
}

/** Display only committed fields; native Agent observations never imply gate approval. */
export function displayWorkflowState(state: WorkflowClientState, nativeAgents: readonly AgentLine[],
  stages: readonly { name: string; purpose: string }[]): WorkflowProjection {
  const snapshot = state.snapshot
  if (state.status !== 'ready' || snapshot?.run === null || snapshot === null) {
    const absent = state.status === 'absent'
    return {
      stageIndex: -1, stageName: absent ? '尚未建立运行' : state.status === 'loading' ? '读取状态' : '状态不可用',
      stagePurpose: '只读查看工作流记录，不推测授权',
      title: absent ? '本会话还没有结构化工作流记录' : state.status === 'loading' ? '正在读取已保存的工作流' : '暂时无法确认工作流状态',
      now: absent ? '尚未建立受控运行记录' : '正在核实工作流状态',
      summary: absent ? '本会话还没有受控运行记录。需要先选择工作流 Agent 预设；旧会话不会自动补造记录，也不能据此认为旧工具已受新门禁保护。' : '不会把上一次的确认、聊天中的“完成”或网络断开当成最新运行结论。',
      live: absent ? '下方如有 Agent，仅是原生会话观察' : '不能据此判断后台 Agent 已停止',
      attentionTitle: absent ? '无需在此操作' : '等待状态读取恢复',
      attentionDetail: '继续使用原生输入框；本面板不会启动任务或批准门禁。',
      needsUser: false, next: '先确认已选择工作流 Agent 预设，再在原生输入框描述目标；此面板只用于查看。',
      source: absent ? '插件日志为空 · 原生观察仅供参考' : '插件日志读取未完成',
      tone: state.status === 'unavailable' ? 'return' : 'active', agents: absent ? nativeAgents : [],
      badge: absent ? '尚无记录' : state.status === 'loading' ? '读取中' : '未确认', uncertain: true,
      emptyAgentText: absent ? '没有结构化 Agent 分工记录。' : '状态未核实，不把空列表解释为没有后台工作。',
      stageStates: stages.map(() => 'locked'),
    }
  }
  const run = snapshot.run
  if (run.rollback?.pending) {
    const pending = run.rollback.pending
    const committed = pending.phase === 'applied'
    const badge = committed ? '已撤销 · 待清理' : '撤销未完成'
    const stageDetails = stagePresentations(run)
    return {
      stageIndex: WORKFLOW_STAGES.indexOf('delivery'), stageName: '交付', stagePurpose: '核对中断的文件撤销',
      title: run.title, badge, now: badge, nowDetail: pending.reason,
      summary: `涉及 ${String(pending.fileCount)} 个文件；原交付与验收结论仅保留为历史。`,
      live: '没有自动重复恢复文件；未完成处置前禁止本工作区继续执行。',
      attentionTitle: '需要你处理', attentionDetail: pending.reason, needsUser: true,
      next: committed ? '在原生输入框要求重试撤销备份清理；不再改动目标文件。'
        : '在原生输入框要求继续撤销。会重新核对文件并展示原生确认；有冲突时保留现场，不覆盖后续编辑。',
      source: `插件持久日志 · revision ${snapshot.revision}`, tone: 'return', uncertain: !committed,
      agents: run.agents.map(agent => ({ label: `${roleLabels[agent.role] ?? agent.role} · ${agent.agentSessionId}`,
        detail: agent.lastSummary ?? agent.taskTitle, ...agentPresentation(agent, run) })),
      stageDetails, stageStates: stageDetails.map(stage => stage.state), completionNotice: badge,
    }
  }
  const recovery = run.recovery ?? snapshot.preRunRecovery ?? null
  const recoveryNeedsAttention = recovery?.status === 'needs-attention'
  const recoveryPreserved = recovery ? recovery.preserved.join('；') : ''
  const stageIndex = WORKFLOW_STAGES.indexOf(run.stage)
  const waiting = run.gates.find(gate => gate.status === 'waiting' && !gate.stale && gate.requiredActor === 'user')
  const latestGates = new Map<string, typeof run.gates[number]>()
  for (const gate of run.gates) latestGates.set(`${gate.kind}:${[...gate.scopeTaskIds].sort().join(',')}`, gate)
  const stale = run.tasks.some(task => task.stale) || [...latestGates.values()].some(gate => gate.stale && gate.status !== 'cancelled' && gate.status !== 'rejected')
  const failed = run.tasks.some(task => task.status === 'failed' || task.status === 'invalidated')
  const completed = run.tasks.filter(task => task.status === 'completed').length
  const activeAgents = run.agents.filter(agent => agent.status === 'running' && !agent.runtimeIssue)
  const active = activeAgents.length
  const activeRoles = [...new Set(activeAgents.map(agent => roleLabels[agent.role] ?? agent.role))]
  const activeWave = active > 1
    ? `${active} 个 Agent 并行：${activeRoles.join('、')}`
    : active === 1 ? `${activeRoles[0]} Agent 正在执行` : undefined
  const projectRoute = run.executionProfile === PROJECT_PILOT
  const pendingLearning = workflowHasPendingLearning(run)
  const learningReviewed = run.learning?.reviewed ?? run.learningDecided
  const learningNotReviewed = run.outcome !== null && !learningReviewed && !pendingLearning && !run.budget?.recovery?.closed
  const budgetRequest = run.budget?.recovery?.requests.find(item => item.status === 'pending')
  const budgetVisible = !recovery && !run.manualClose && !run.gates.some(gate =>
    gate.kind === 'rollback' && gate.status === 'waiting' && !gate.stale) && !run.rollback?.latestApplied
  const acceptedLearning = run.learning?.candidates.filter(item => item.status === 'accepted').length ?? 0
  const rejectedLearning = run.learning?.candidates.filter(item => item.status === 'rejected').length ?? 0
  const revisionRequiredLearning = run.learning?.candidates.filter(item => item.status === 'revision-required').length ?? 0
  const learningAction: Readonly<Record<string, string>> = {
    'communication-preference': '沟通偏好', 'planning-hint': '规划提示', 'quality-requirement': '质量约束',
  }
  const learningScope: Readonly<Record<string, string>> = { project: '当前项目', preset: '同类工作流', run: '仅本轮' }
  const learningItems: LearningLine[] = run.learning ? [
    ...run.learning.applied.map(item => ({
      id: `applied:${item.ruleId}`,
      statement: item.statement,
      detail: `${learningAction[item.actionKind] ?? item.actionKind} · ${learningScope[item.scope] ?? item.scope} · ${compact(item.reason)}`,
      status: item.status === 'applied' ? '本轮已复用' : '本轮已覆盖',
      tone: item.status === 'applied' ? 'active' as const : 'muted' as const,
    })),
    ...run.learning.candidates.map(item => {
      const revisions = item.revisionCount ?? 0
      const revisionNote = revisions > 0 ? ` · 已修订 ${String(revisions)} 次` : ''
      return {
        id: `candidate:${item.id}`,
        statement: item.statement,
        detail: item.status === 'revision-required'
          ? `等待在原生输入框说明具体改法${revisionNote}`
          : `${item.actionKind ? learningAction[item.actionKind] ?? item.actionKind : '历史候选'} · ${learningScope[item.scope] ?? item.scope}${revisionNote} · ${compact(item.latestRevisionReason ?? item.basis)}`,
        status: item.status === 'accepted' ? '已采纳' : item.status === 'rejected' ? '未采纳' : item.status === 'revoked' ? '已停用'
          : item.status === 'revision-required' ? '待修订' : revisions > 0 ? '修订待确认' : '待决定',
        tone: item.status === 'accepted' ? 'done' as const
          : item.status === 'pending' || item.status === 'revision-required' ? 'warning' as const : 'muted' as const,
      }
    }),
  ] : []
  const stageDetails = stagePresentations(run)
  const rollbackGate = waiting?.kind === 'rollback'
  const requirementGate = waiting?.kind === 'signal' && run.plan?.confirmationMode === 'layered'
  const executionAuthorizationGate = waiting?.kind === 'execution'
  const rollbackState = run.rollback
  const latestRollback = rollbackState?.latestApplied ?? null
  const rollbackApplied = latestRollback !== null
  const latestReturn = run.latestReturn ?? null
  const returnedTask = latestReturn?.responsibleTaskId === undefined
    ? undefined : run.tasks.find(task => task.taskId === latestReturn.responsibleTaskId)
  const returnActive = latestReturn !== null && run.outcome === null && run.stage === latestReturn.toStage
  const fromStageName = latestReturn === null ? '' : stages[WORKFLOW_STAGES.indexOf(latestReturn.fromStage)]?.name ?? latestReturn.fromStage
  const toStageName = latestReturn === null ? '' : stages[WORKFLOW_STAGES.indexOf(latestReturn.toStage)]?.name ?? latestReturn.toStage
  const returnedTitle = returnedTask?.title ?? '受影响任务'
  const returnNow = latestReturn === null ? '' : `第 ${latestReturn.attempt} 次返工 · ${fromStageName}退回 → ${toStageName}`
  const returnNowDetail = latestReturn === null ? ''
    : `原因：${compact(latestReturn.reason)} · ${returnedTask?.status === 'running' ? '当前修正' : returnedTask?.status === 'completed' ? '已完成修正' : '等待修正'}：「${returnedTitle}」`
  const now = recovery ? recoveryNeedsAttention
    ? `根协调响应已停稳 · 第 ${String(recovery.attempt)} 次停滞`
    : `根协调响应已中止 · 正在自动恢复第 ${String(recovery.attempt)} 次`
    : stale ? '输入版本已变化，原授权和旧结果正在等待重新核对'
    : waiting ? rollbackGate ? '撤销预览正在等待你的明确确认'
      : requirementGate ? '需求理解等待确认；尚未允许实现'
        : executionAuthorizationGate ? '只读方案已就绪，等待执行授权' : `${stages[stageIndex]?.name ?? run.stage}等待用户门禁决定`
      : returnActive ? returnNow
        : rollbackApplied ? '已撤销'
        : learningNotReviewed ? `本轮已结束：${outcomes[run.outcome!]} · 经验尚未整理`
        : revisionRequiredLearning > 0 ? `${String(revisionRequiredLearning)} 条沉淀建议等待你说明修改`
          : pendingLearning ? '沉淀建议正在等待逐项确认'
            : run.outcome ? `本轮已结束：${outcomes[run.outcome]}`
          : activeWave ?? `${stages[stageIndex]?.name ?? run.stage}正在按已保存记录推进`
  const next = recovery ? recoveryNeedsAttention
    ? `不会继续自动重试；如需继续，请在原生输入框明确要求从“${recovery.resumeFrom}”恢复。`
    : `自动恢复只执行一次：先读取最新 Journal，再从“${recovery.resumeFrom}”继续。`
    : stale ? '重新核对受影响输入并刷新门禁；旧授权不会自动沿用。'
    : waiting ? rollbackGate ? '在原生撤销确认中选择恢复文件或保留现状；此面板不会代为决定。' : '在原生对话中处理当前门禁后，只继续已确认范围。'
      : returnActive ? projectRoute
        ? `「${returnedTitle}」完成后 → 工程测试与代码审查并行复验 → 独立黑盒验收`
        : `「${returnedTitle}」完成后 → ${fromStageName}重新验收`
        : rollbackApplied ? (rollbackState?.availableCheckpoints ?? 0) > 0
          ? '仍有更早的实现检查点；只有再次明确要求并确认，才会继续逐次撤销。'
          : '本运行记录的文件变化已经撤销；新目标会重新进入需求确认。'
        : learningNotReviewed ? '尚无经验整理记录；如需整理，可在原生对话中提出，不会据此自动启动任务。'
          : revisionRequiredLearning > 0 ? '直接在原生输入框说明被退回项应如何修改；其他候选不会重新询问。'
            : pendingLearning ? '在原生对话中决定当前单项沉淀建议；不会自动写入规则。'
          : run.outcome ? '没有自动下一步；新目标会重新进入需求确认。'
            : '当前阶段完成后按依赖关系推进；失败时返回最小责任阶段。'
  const latestGate = (kind: WorkflowRunView['gates'][number]['kind']) => [...run.gates].reverse().find(gate => gate.kind === kind)
  const gateMilestone = (label: string, detail: string, gate: WorkflowRunView['gates'][number] | undefined,
    emptyStatus: string, emptyTone: PlanMilestone['tone']): PlanMilestone => {
    if (gate?.stale) return { label, detail, status: '待重新确认', tone: 'failed' }
    if (gate?.status === 'approved') return { label, detail, status: '已确认', tone: 'done' }
    if (gate?.status === 'waiting') return { label, detail, status: '等待你确认', tone: 'waiting' }
    if (gate?.status === 'rejected') return { label, detail, status: '未获批准', tone: 'failed' }
    if (gate?.status === 'cancelled') return { label, detail, status: '已关闭', tone: 'locked' }
    return { label, detail, status: emptyStatus, tone: emptyTone }
  }
  let plan: WorkflowPlanProjection | undefined
  if (run.plan) {
    const execution = gateMilestone(
      '执行授权', '允许确认范围内的写入、冻结检查、独立验收和一次同范围返工。',
      latestGate('execution'), run.plan.confirmationMode === 'layered' ? '尚未开放' : '待发起确认',
      run.plan.confirmationMode === 'layered' ? 'locked' : 'current',
    )
    const milestones: PlanMilestone[] = run.plan.confirmationMode === 'layered'
      ? [
          gateMilestone('需求理解', '只确认目标、范围与完成口径；不授予写入或检查权限。', latestGate('signal'), '待发起确认', 'current'),
          (() => {
            const task = run.tasks.find(item => item.role === 'architect')
            if (task?.status === 'completed') return { label: '只读方案', detail: '读取工程上下文并形成设计、影响面与回滚方案；不能改文件或运行检查。', status: '已形成', tone: 'done' as const }
            if (task?.status === 'running') return { label: '只读方案', detail: '读取工程上下文并形成设计、影响面与回滚方案；不能改文件或运行检查。', status: '分析中', tone: 'current' as const }
            if (task?.status === 'failed' || task?.status === 'invalidated') return { label: '只读方案', detail: '读取工程上下文并形成设计、影响面与回滚方案；不能改文件或运行检查。', status: '未完成', tone: 'failed' as const }
            const understood = latestGate('signal')?.status === 'approved'
            return { label: '只读方案', detail: '读取工程上下文并形成设计、影响面与回滚方案；不能改文件或运行检查。', status: understood ? '待启动' : '尚未开放', tone: understood ? 'current' as const : 'locked' as const }
          })(),
          execution,
        ]
      : [execution]
    plan = {
      modeLabel: run.plan.confirmationMode === 'layered' ? '分层确认' : '单次执行确认',
      summary: `${String(run.plan.tasks.length)} 个角色任务 · ${String(run.plan.criteria.length)} 项硬标准 · ${String(run.plan.engineeringChecks.length + run.plan.acceptanceChecks.length)} 条冻结检查`,
      milestones,
      contract: run.plan,
    }
  }
  return {
    stageIndex, stageName: stages[stageIndex].name, stagePurpose: stages[stageIndex].purpose,
    title: run.title, now,
    nowDetail: returnActive ? returnNowDetail : rollbackApplied && !stale && !waiting
      ? '文件已恢复到修改前状态；原交付与验收结论仅作历史记录。'
      : undefined,
    nextDetail: returnActive ? projectRoute
      ? '当前工程闭环会重新执行完整下游波次；这是已实现的保守策略，尚未支持只选择受影响检查。'
      : '当前文本闭环会由原独立验收 Agent 重新验收当前交付版本。' : undefined,
    summary: recovery
      ? `${recovery.reason} 已保留：${recoveryPreserved}。`
      : returnActive
      ? projectRoute
        ? `${fromStageName}的当前证据没有通过，已在相同合同与写入范围内返回实现；失败证据和返工次数均已保存。`
        : '独立验收没有通过，已在相同合同范围内返回内容实现；失败证据和返工次数均已保存。'
      : rollbackApplied
        ? `已通过原生用户权限门禁恢复检查点中的 ${String(latestRollback.fileCount)} 个文件变化；实际操作者未核验，原交付与验收结论仅保留为历史。`
      : `${run.tasks.length} 个子任务，${completed} 个完成。硬性验收：${run.ledger.pass} 通过、${run.ledger.fail} 失败、${run.ledger.waived} 豁免、${run.ledger.pending} 待验证。`,
    live: recovery ? recoveryNeedsAttention ? '自动恢复已停止 · 后台不会继续循环' : '只恢复根协调轮次 · 子任务与门禁记录保持原状'
      : active > 0 ? `日志中 ${active} 个 Agent 为运行态；尚未接入进程存活核对` : returnActive ? '返工路径已保存；日志中没有运行态 Agent' : rollbackApplied ? '文件恢复记录已保存；没有 Agent 继续执行' : '日志中没有运行态 Agent',
    attentionTitle: recovery ? recoveryNeedsAttention ? '需要你决定是否继续' : '现在不需要你操作'
      : stale ? '输入版本已变化，原授权不能继续使用' : waiting?.summary ?? (returnActive ? '现在不需要你操作' : rollbackApplied ? '本次文件撤销已完成' : failed ? '存在未通过或待重新验证的任务' : revisionRequiredLearning > 0 ? '请说明被退回项的具体改法' : pendingLearning ? '沉淀建议仍待你决定' : learningNotReviewed ? '现在不需要你操作' : run.outcome ? '本轮已结束，无需操作' : '当前没有等待用户确认的记录'),
    attentionDetail: recovery ? recoveryNeedsAttention
      ? '在原生输入框说“继续”或说明新的处理方式；插件不会把沉默当成授权。'
      : 'Host 正按 Journal 恢复一次；若再次停滞会明确停下，不需要手动取消进程。'
      : waiting ? rollbackGate
      ? '请在 DSH 原生撤销确认中核对文件清单；确认前还会复核摘要，冲突时不会覆盖。'
      : requirementGate
        ? '请在 DSH 原生确认中核对需求理解；确认只会启动只读方案 Agent，不会开始实现。'
        : executionAuthorizationGate
          ? '请在 DSH 原生确认中核对方案、写入范围和检查；此处不能代为批准。'
          : '请在 DSH 原生问答中核对合并需求和执行边界；此处不能代为批准。'
      : returnActive ? '返工保持在已确认范围内；连续失败、扩大范围或改变边界时才会请求决定。'
        : rollbackApplied ? '仅工作区文件内容已恢复；外部副作用没有被声称为已撤销。'
          : failed ? '先查看原生对话中的失败证据；返工后需要对新版本重新验收。'
            : revisionRequiredLearning > 0 ? '直接使用页面原生输入框；修订后只会重开对应候选，已采纳和未采纳项保持不变。'
              : pendingLearning ? '交付结论不代表已经采纳沉淀建议；请继续在原生对话中决定当前单项。'
              : learningNotReviewed ? '没有经验整理或候选决定记录；未整理不代表正在运行，也不代表已检查后无候选。'
              : '这里展示控制层已保存的阶段、角色和验收结论；交互仍在原生输入框。',
    needsUser: recoveryNeedsAttention || waiting !== undefined || pendingLearning,
    next,
    source: `插件持久日志 · revision ${snapshot.revision}`,
    tone: recovery ? 'return' : stale || returnActive || rollbackApplied || failed || run.outcome === 'FAIL' || run.outcome === 'CANCELLED' ? 'return' : waiting || pendingLearning ? 'gate' : run.outcome ? 'done' : 'active',
    badge: recovery ? recoveryNeedsAttention ? '需要处理' : '自动恢复中'
      : waiting ? rollbackGate ? '待撤销确认' : requirementGate ? '待需求确认' : executionAuthorizationGate ? '待执行授权' : '待确认记录' : rollbackApplied ? '已撤销' : revisionRequiredLearning > 0 ? '待修订' : pendingLearning ? '待确认' : run.outcome ? outcomes[run.outcome] : returnActive ? '返工中' : '已记录',
    ...(rollbackApplied && !stale && !waiting ? { rollback: {
      fileCount: latestRollback.fileCount, remainingCheckpoints: rollbackState?.availableCheckpoints ?? 0,
    } } : {}),
    agents: run.agents.map(agent => {
      const historical = historicalInterruption(agent, run)
      return {
        label: `${roleLabels[agent.role] ?? agent.role} · ${agent.agentSessionId}`,
        detail: `${agent.taskTitle}（v${agent.taskVersion}）${historical ? ' · 中断记录已保留。' : agent.lastSummary ? ` · ${agent.lastSummary}` : ''}`,
        ...(historical ? { interruptionHistory: [...new Set([
          agent.runtimeIssue!.reason, ...(agent.lastSummary ? [agent.lastSummary] : []),
        ])] } : {}),
        verification: run.manualClose?.checks.find(item => item.assignmentId === agent.assignmentId),
        ...agentPresentation(agent, run),
      }
    }),
    ...(plan === undefined ? {} : { plan }),
    ...(run.learning && (run.learning.reviewed || run.learning.applied.length > 0 || run.learning.candidates.length > 0) ? { learning: {
      summary: run.learning.reviewed
        ? run.learning.candidates.length === 0
          ? '已检查本轮证据，没有生成长期候选。'
          : pendingLearning
            ? `${String(acceptedLearning)} 条已采纳，${String(rejectedLearning)} 条未采纳，${String(revisionRequiredLearning)} 条待修订；已完成项不会回退。`
            : `${String(acceptedLearning)} 条采纳，${String(rejectedLearning)} 条未采纳；${run.learning.decisionAudit ? '原生权限裁决，实际操作者未核验' : '兼容历史裁决，缺少新版操作者来源审计'}。`
        : `${String(run.learning.applied.filter(item => item.status === 'applied').length)} 条历史规则进入本轮待确认需求。`,
      items: learningItems,
    } } : {}),
    stageDetails, stageStates: stageDetails.map(stage => stage.state),
    completionNotice: recovery ? recoveryNeedsAttention
      ? '根协调自动恢复已停止 · 已保留本轮记录'
      : '根协调响应已中止 · 正从 Journal 自动恢复一次'
      : run.outcome === null ? undefined : rollbackGate
      ? rollbackApplied ? '上次撤销已完成 · 本次撤销仍待你确认' : '执行已结束 · 文件撤销待你确认'
      : rollbackApplied
      ? `本轮文件变化已撤销 · ${String(latestRollback.fileCount)} 个文件`
      : pendingLearning
      ? '交付已有结论 · 沉淀建议仍待你决定'
      : learningNotReviewed
      ? `本轮已结束 · ${outcomes[run.outcome!]} · 经验未整理${active > 0 ? ' · 仍有运行记录待核对' : ''}`
      : run.learning?.reviewed && run.learning.candidates.length === 0
      ? `本轮已结束 · ${outcomes[run.outcome!]} · 本轮无沉淀候选`
      : acceptedLearning > 0
      ? `本轮已结束 · ${outcomes[run.outcome!]} · 已沉淀 ${String(acceptedLearning)} 条`
      : `本轮已结束 · ${outcomes[run.outcome]}${active > 0 ? ' · 仍有运行记录待核对' : ''}`,
    ...(budgetVisible && run.budget?.recovery?.awaitingResume && !run.budget.blocked && !run.budget.recovery.closed && !run.outcome ? {
      badge: '等待继续', tone: 'gate' as const, needsUser: true,
      now: '补额已保存 · 尚未恢复执行', nowDetail: '累计用量与原任务权限保持不变。',
      attentionTitle: '等待你的下一条消息', attentionDetail: '请在原生输入框明确继续，或先调整需求；后台通知不会恢复执行。',
      next: '在原生输入框表达下一步意图。', live: '没有因补额而自动派发或恢复 Agent。',
    } : {}),
    ...(budgetVisible && run.budget?.blocked && !run.budget.recovery?.closed ? {
      badge: budgetRequest ? budgetRequest.action === 'topup' ? '待补额确认' : '待结束确认'
        : run.budget.blocked.resource === 'active-time' ? '时长预算耗尽' : '预算耗尽', tone: budgetRequest ? 'gate' as const : 'return' as const, needsUser: true,
      now: budgetRequest ? budgetRequest.action === 'topup' ? '等待你确认增加本轮额度' : '等待你确认结束本轮'
        : `本轮累计${run.budget.blocked.resource === 'active-time' ? '有效时长' : '请求'}预算耗尽 · 不再自动推进`,
      nowDetail: `模型请求 ${run.budget.used.rootModel + run.budget.used.childModel}/${run.budget.limits.modelRequests} 次（协调 ${run.budget.used.rootModel}、子角色 ${run.budget.used.childModel}）；检查命令 ${run.budget.used.commands}/${run.budget.limits.commands} 次。${runTimeSummary(run.budget)}`,
      attentionTitle: budgetRequest ? '等待预算决定' : '需要核对本轮预算', attentionDetail: RUN_BUDGET_STOP_MESSAGE,
      live: run.agents.some(agent => agent.runtimeIssue?.status === 'unknown') ? '存在未确认停止的角色，不能据此重跑。'
        : run.agents.some(agent => agent.runtimeIssue?.status === 'stopping' || (agent.status === 'running' && !agent.runtimeIssue))
          ? '新请求已封闭；正在逐项核对已派发角色的回收结果。'
          : '没有仍待回收的已登记角色；该观察不保证任意外部进程都已退出。',
      next: '在原生输入框核对、申请补额或结束；也可输入 /workflow-budget，不调用模型。中断角色不能靠补额续跑。',
      completionNotice: '执行预算用尽，原验收结论与产物保持不变；不把预算问题算作验收失败。',
    } : {}),
    // Budget is never proof of child exit and must not hide unknown/stopping or manual recovery.
    ...childRuntimeDisplay(run, active),
  }
}

/** Preserve the precise projection badge in both native header and workflow view. */
export function workflowStatusLabel(projection: Pick<WorkflowProjection, 'badge' | 'needsUser' | 'stageName'>): string {
  return projection.badge && projection.badge !== '已记录'
    ? projection.badge : projection.needsUser ? '待你确认' : projection.stageName
}
