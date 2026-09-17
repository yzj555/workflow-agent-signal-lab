import { createElement as h, useCallback, useSyncExternalStore } from 'react'
import { WorkflowSurface, WorkflowStatus } from './workflow-surface.ts'
import { workflowCss } from './workflow-styles.ts'
import { bindWorkflowView, WORKFLOW_VIEW_ID } from './workflow-native-seats.ts'
import { classifyWorkflowOutcome, summarizeAgentFollowup } from '../workflow-policy.ts'
import { WorkflowSnapshotSource } from './workflow-source.ts'
import { displayPreRunConversation, displayWorkflowState } from './workflow-display.ts'
import type { AgentLine, AgentTone, WorkflowProjection } from './workflow-display.ts'
import { RequirementsGateComposer } from './requirements-gate-composer.ts'
import { selectRequirementsGate } from './requirements-gate-contract.ts'
import { ManualRecoveryGateComposer } from './manual-recovery-gate-composer.ts'
import { selectManualRecoveryGate } from './manual-recovery-gate-contract.ts'
import { BudgetGateComposer } from './budget-gate-composer.ts'
import { selectBudgetGate } from './budget-gate-contract.ts'

type ContentBlock = { type?: string; text?: string }
type AssistantBlock = { kind?: string; text?: string; name?: string; argsRaw?: string }

interface RunningToolCall {
  callId?: string
  name?: string
  argsRaw?: string
}

type WorkflowMemberStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

interface WorkflowRunMember {
  label?: string
  status?: WorkflowMemberStatus
}

interface WorkflowRunPhase {
  phase?: string | null
  members?: readonly WorkflowRunMember[]
}

interface ConversationNode {
  kind?: string
  seq?: number
  interrupted?: true
  content?: readonly ContentBlock[]
  blocks?: readonly AssistantBlock[]
  call?: { name?: string; argsRaw?: string } | null
  isError?: boolean
  subCalls?: readonly RunningToolCall[]
  data?: {
    name?: string
    status?: WorkflowMemberStatus
    phases?: readonly WorkflowRunPhase[]
  }
}

interface PendingQuestion {
  question?: string
  detail?: string
  header?: string
  options?: readonly { label?: string; description?: string }[]
}

interface PendingInteraction {
  kind?: string
  questions?: readonly PendingQuestion[]
}

/** Normalized workflow input assembled from DSH's split lifecycle and Chat projections. */
interface ConversationSnapshot {
  blank: boolean
  running: boolean
  nodes: readonly ConversationNode[]
  partial?: { blocks?: readonly AssistantBlock[] } | null
  runningCalls?: readonly RunningToolCall[]
  pending?: readonly PendingInteraction[]
}

interface SessionLifecycleSnapshot {
  blank: boolean
  running: boolean
}

interface ChatSnapshot {
  legacy: {
    nodes: readonly ConversationNode[]
    partial: { blocks?: readonly AssistantBlock[] } | null
    runningCalls: readonly RunningToolCall[]
  }
}

interface ConversationAssemblySnapshot {
  views: {
    get(target: 'chat'): ChatSnapshot | undefined
  }
}

interface SessionSummary {
  id?: string
  title?: string | null
  origin?: string
  parentId?: string
  running?: boolean
  projectionValues?: {
    agentPreset?: unknown
    subagent?: {
      label?: string
      mode?: string
    } | null
  }
}

interface SubagentCatalogEntry {
  kind?: string
  id?: string
  label?: string
  mode?: string
  activity?: string
}

interface SessionListState {
  byId: Record<string, SessionSummary | undefined>
  subagentsByParent?: Record<string, { entries?: readonly SubagentCatalogEntry[] } | undefined>
}

interface WorkflowHeaderActionProps {
  source: WorkflowSnapshotSource
  sessionId: string
  useSessions: <T>(selector: (state: SessionListState) => T) => T
  useSession: <T>(selector: (state: SessionLifecycleSnapshot) => T) => T
  useConversation: <T>(selector: (state: ConversationAssemblySnapshot) => T) => T
  useSessionPendingInteraction: <T>(
    selector: (state: ReadonlyMap<string, PendingInteraction>) => T,
  ) => T
}

interface StageDefinition {
  name: string
  purpose: string
}

const ID = '@local/workflow-agent-signal-lab'
const PRESET_ID = 'workflow-agent-signal-lab'
const STYLE_ID = 'workflow-agent-runtime-style'

const stages: readonly StageDefinition[] = [
  { name: '需求确认', purpose: '弄清目标、边界和成功条件' },
  { name: '计划与拆解', purpose: '安排先后、并行和责任 Agent' },
  { name: '实现', purpose: '产生实际变化并记录影响' },
  { name: '验证', purpose: '用测试和证据确认结果可用' },
  { name: '独立审查', purpose: '由不同 Agent 检查风险与遗漏' },
  { name: '交付', purpose: '汇总产物、变化和使用方式' },
  { name: '沉淀', purpose: '记录本轮规则，让下次更顺畅' },
]

const css = workflowCss

function userText(node: ConversationNode): string {
  if (node.kind !== 'user' && node.kind !== 'steering') return ''
  return (node.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
}

function assistantText(node: ConversationNode): string {
  if (node.kind !== 'assistant') return ''
  return (node.blocks ?? []).filter(block => block.kind === 'text').map(block => block.text ?? '').join(' ')
}

function explicitConfirmation(text: string): boolean {
  return /^(确认|确认无误|同意并开始|开始执行|按这个执行|可以开始)([。！!\s]|$)/u.test(text.trim())
}

function allConversationNodes(snapshot: ConversationSnapshot): readonly ConversationNode[] {
  return [...snapshot.nodes]
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftSeq = left.node.seq
      const rightSeq = right.node.seq
      if (leftSeq === undefined || rightSeq === undefined) return left.index - right.index
      return leftSeq === rightSeq ? left.index - right.index : leftSeq - rightSeq
    })
    .map(item => item.node)
}

function workflowRuns(snapshot: ConversationSnapshot): readonly ConversationNode[] {
  return allConversationNodes(snapshot).filter(
    node => node.kind === 'workflow-run' && node.data?.phases !== undefined,
  )
}

function blockText(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
}

function partialAssistantText(snapshot: ConversationSnapshot): string {
  return (snapshot.partial?.blocks ?? [])
    .filter(block => block.kind === 'text' || block.kind === 'reasoning')
    .map(block => block.text ?? '')
    .join(' ')
}

function toolResultText(node: ConversationNode): string {
  return node.kind === 'tool-result' ? blockText(node.content) : ''
}

function gateConfirmedByTool(nodes: readonly ConversationNode[], afterSeq: number): boolean {
  return nodes.some(node => node.kind === 'tool-result'
    && (node.seq ?? -1) > afterSeq
    && node.isError !== true
    && (node.call?.name === 'ask_user_question' || node.call?.name === 'exit_plan_mode')
    && /确认执行|确认无误|同意并开始|开始执行|批准|approve|confirm/iu.test(toolResultText(node)))
}

function gateInterrupted(nodes: readonly ConversationNode[], afterSeq: number): boolean {
  const lastAssistant = nodes.filter(node => node.kind === 'assistant').at(-1)
  if (lastAssistant?.interrupted === true && (lastAssistant.seq ?? -1) > afterSeq) return true
  const lastQuestion = nodes.filter(node => node.kind === 'tool-result'
    && (node.seq ?? -1) > afterSeq
    && (node.call?.name === 'ask_user_question' || node.call?.name === 'exit_plan_mode')).at(-1)
  return lastQuestion?.isError === true
    && /(?:interrupt|cancel|abort|中断|取消|停止)/iu.test(toolResultText(lastQuestion))
}

function failedToolResult(nodes: readonly ConversationNode[], afterSeq: number): ConversationNode | undefined {
  return nodes.filter(node => {
    if (node.kind !== 'tool-result' || (node.seq ?? -1) <= afterSeq) return false
    const result = toolResultText(node)
    return node.isError === true
      || /(?:blocked|denied|refused|failed|error|guard|forbidden|拒绝|拦截|失败|守卫|不允许)/iu.test(result)
  }).at(-1)
}

function failureDetail(node: ConversationNode | undefined): string {
  if (node === undefined) return ''
  const name = node.call?.name?.trim() || '工具调用'
  const result = toolResultText(node).replace(/\s+/gu, ' ').trim()
  if (result.length === 0) return `${name} 未成功完成`
  return `${name}：${result.slice(0, 120)}${result.length > 120 ? '…' : ''}`
}

function pendingCopy(wait: PendingInteraction | undefined): string {
  if (wait === undefined) return ''
  return (wait.questions ?? []).flatMap(question => [
    question.header ?? '',
    question.question ?? '',
    question.detail ?? '',
    ...(question.options ?? []).flatMap(option => [option.label ?? '', option.description ?? '']),
  ]).join(' ')
}

function isConfirmationWait(wait: PendingInteraction | undefined): boolean {
  if (wait?.kind !== 'question' && wait?.kind !== 'plan-review') return false
  return /确认|批准|同意|开始执行|执行方案|按上述方案|approve|confirm/iu.test(pendingCopy(wait))
}

function stageForPhase(phase: string | null | undefined): number {
  const value = phase ?? ''
  if (/需求|分析|澄清|确认|signal|requirement/iu.test(value)) return 0
  if (/计划|编排|拆解|设计|plan|route|design/iu.test(value)) return 1
  if (/实现|开发|构建|创建|写入|修复|编码|工程|build|implement|write|edit|fix/iu.test(value)) return 2
  if (/验证|测试|质检|qa|verify|test/iu.test(value)) return 3
  if (/审查|评审|复核|review|audit/iu.test(value)) return 4
  if (/交付|打包|发布|文档|deliver|release|package/iu.test(value)) return 5
  if (/沉淀|复盘|规则|learn|retro/iu.test(value)) return 6
  return 2
}

function semanticStage(text: string): number | undefined {
  const labels = [...text.matchAll(/【(需求分析|等待确认|计划与拆解|编排|实现受阻|实现|验证|独立审查|审查|交付|沉淀)】/gu)]
  const label = labels.at(-1)?.[1]
  if (label !== undefined) return stageForPhase(label)
  return undefined
}

function toolStage(call: RunningToolCall | undefined): number | undefined {
  if (call === undefined) return undefined
  // Tool arguments are user/project data, not an operation identity. Matching
  // them made a read-only pwsh call look like implementation merely because a
  // filename contained "WRITE". Classify only the registered tool name; shell
  // intent remains with the model's explicit phase label.
  const name = call.name?.trim() ?? ''
  if (/^crew_(researcher|architect)$/iu.test(name)) return 1
  if (/^crew_(test_engineer|qa)$/iu.test(name)
    || /^(test|verify|validation|qa)(?:_|$)/iu.test(name)) return 3
  if (/^crew_(code_reviewer|security_reviewer|doc_reviewer)$/iu.test(name)
    || /^(review|audit)(?:_|$)/iu.test(name)) return 4
  if (/^crew_(engineer|code_engineer)$/iu.test(name)
    || /^(write|edit|apply_patch|str_replace_editor)$/iu.test(name)) return 2
  return undefined
}

function pendingStage(wait: PendingInteraction | undefined, liveText: string): number {
  const copy = pendingCopy(wait)
  if (/后续|如何继续|受阻|拒绝|失败|审批|守卫|拦截|中断/iu.test(copy)) return 2
  if (/验证|测试|验收|qa/iu.test(copy)) return 3
  if (/审查|评审|复核|review/iu.test(copy)) return 4
  if (/交付|发布|deliver|release/iu.test(copy)) return 5
  return semanticStage(liveText) ?? 2
}

function agentStage(agents: readonly AgentLine[]): number | undefined {
  const active = agents.filter(agent => agent.tone === 'active')
  if (active.length === 0) return undefined
  return stageForPhase(active.map(agent => `${agent.label} ${agent.detail}`).join(' '))
}

function stageActivity(stageIndex: number): string {
  switch (stageIndex) {
    case 0: return '正在分析需求'
    case 1: return '正在安排依赖与责任 Agent'
    case 2: return '正在实现已确认范围'
    case 3: return '正在验证实现结果'
    case 4: return '正在进行独立审查'
    case 5: return '正在整理交付结果'
    case 6: return '正在整理本轮可复用经验'
    default: return '正在推进工作流'
  }
}

function memberTone(status: WorkflowMemberStatus | undefined): AgentTone {
  if (status === 'running') return 'active'
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'interrupted') return 'failed'
  return 'waiting'
}

function statusText(status: WorkflowMemberStatus | undefined): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    default: return '等待中'
  }
}

function latestAgentFollowups(snapshot: ConversationSnapshot): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const node of allConversationNodes(snapshot)) {
    const calls = [
      ...(node.call === null || node.call === undefined ? [] : [node.call]),
      ...(node.blocks ?? []).filter(block => block.name !== undefined),
    ]
    for (const call of calls) {
      if (call.name !== 'send_message' || call.argsRaw === undefined) continue
      try {
        const parsed = JSON.parse(call.argsRaw) as { subagent_id?: unknown; message?: unknown }
        if (typeof parsed.subagent_id !== 'string' || typeof parsed.message !== 'string') continue
        const summary = summarizeAgentFollowup(parsed.message)
        if (summary.length > 0) result.set(parsed.subagent_id, summary)
      } catch {
        // Partial streaming arguments are not authoritative; wait for valid JSON.
      }
    }
  }
  return result
}

function subagentLines(
  state: SessionListState,
  parentSessionId: string,
  snapshot: ConversationSnapshot,
): readonly AgentLine[] {
  const followups = latestAgentFollowups(snapshot)
  const catalogEntries = state.subagentsByParent?.[parentSessionId]?.entries
    ?.filter(entry => entry.kind === 'child' && entry.id !== undefined) ?? []
  const fallbackEntries: SubagentCatalogEntry[] = Object.values(state.byId)
    .filter(summary => summary?.origin === 'subagent' && summary.parentId === parentSessionId)
    .map(summary => ({ kind: 'child', id: summary?.id }))
  const entries = catalogEntries.length > 0 ? catalogEntries : fallbackEntries
  return entries.flatMap((entry) => {
    if (entry.id === undefined) return []
    const summary = state.byId[entry.id]
    const identity = summary?.projectionValues?.subagent
    const originalLabel = entry.label?.trim() || identity?.label?.trim() || summary?.title?.trim() || '未命名子 Agent'
    const followup = followups.get(entry.id)
    const label = followup !== undefined && /^crew[-_]/iu.test(originalLabel)
      ? originalLabel.split(/\s+/u)[0] ?? originalLabel
      : originalLabel
    const running = entry.activity === 'running' || summary?.running === true
    const continuable = (entry.mode ?? identity?.mode) === 'continuable'
    return [{
      label,
      detail: followup ?? (summary?.title?.trim() || (continuable ? '可继续子 Agent' : '一次性子 Agent')),
      status: running ? '运行中' : continuable ? '空闲' : '已完成',
      tone: running ? 'active' : continuable ? 'waiting' : 'done',
    } satisfies AgentLine]
  })
}

function agentsOf(
  run: ConversationNode | undefined,
  parentRunning: boolean,
  children: readonly AgentLine[],
  waitingForUser = false,
): readonly AgentLine[] {
  const result: AgentLine[] = []
  for (const phase of run?.data?.phases ?? []) {
    for (const member of phase.members ?? []) {
      result.push({
        label: member.label?.trim() || '未命名 Agent',
        detail: phase.phase?.trim() || '未分配阶段',
        status: statusText(member.status),
        tone: memberTone(member.status),
      })
    }
  }
  const merged = [...result]
  for (const child of children) {
    if (!merged.some(agent => agent.label === child.label)) merged.push(child)
  }
  if (!parentRunning && merged.length === 0) return []
  return [{
    label: '主 Agent',
    detail: waitingForUser ? '等待你的决定' : '负责编排、汇合与门禁',
    status: waitingForUser ? '等待中' : parentRunning ? '运行中' : '空闲',
    tone: waitingForUser ? 'waiting' : parentRunning ? 'active' : 'waiting',
  }, ...merged]
}

function project(snapshot: ConversationSnapshot, childAgents: readonly AgentLine[]): WorkflowProjection {
  const nodes = allConversationNodes(snapshot)
  const users = nodes.filter(node => node.kind === 'user')
  const assistants = nodes.filter(node => node.kind === 'assistant')
  const lastUser = users.at(-1)
  const lastUserSeq = lastUser?.seq ?? -1
  const latestUserText = lastUser === undefined ? '' : userText(lastUser)
  const lastAssistant = assistantText(assistants.at(-1) ?? {})
  const partial = partialAssistantText(snapshot)
  const liveText = [lastAssistant, partial].filter(Boolean).join('\n')
  const confirmed = explicitConfirmation(latestUserText) || gateConfirmedByTool(nodes, lastUserSeq)
  const interruptedBeforeExecution = gateInterrupted(nodes, lastUserSeq)
  const hasConfirmation = /需求确认|确认单|验收标准|执行边界/u.test(liveText)
  const runs = workflowRuns(snapshot)
  const run = runs.at(-1)
  const pending = snapshot.pending?.at(-1)
  const agents = agentsOf(run, snapshot.running, childAgents, pending !== undefined)

  if (snapshot.blank || users.length === 0) {
    return {
      stageIndex: 0, stageName: stages[0].name, stagePurpose: stages[0].purpose,
      title: '等待你描述想完成的事',
      summary: '选择这一 Agent 预设后，每个新任务都会先理解需求，不会因为一句模糊目标直接开始修改。',
      live: '尚未开始本轮工作流',
      attentionTitle: '现在需要你输入目标', attentionDetail: '直接使用下方 DSH 原生输入框。', needsUser: true,
      next: '收到目标后先分析可发现的事实，再只询问真正影响结果的歧义。',
      source: '预设状态', tone: 'gate', agents,
    }
  }

  if (!confirmed) {
    if (pending !== undefined) {
      const confirmation = isConfirmationWait(pending)
      return {
        stageIndex: 0, stageName: stages[0].name,
        stagePurpose: confirmation ? '确认合并后的需求边界' : stages[0].purpose,
        title: confirmation ? '需求已经合并，正在等待你的明确确认' : '有一个关键点需要你补充',
        summary: confirmation
          ? '确认门仍然关闭。你可以批准当前方案，也可以要求调整；在你作出选择前不会进入实现。'
          : '主 Agent 已通过 DSH 原生提问等待补充信息；回答后会继续合并需求。',
        live: '工作流已暂停在用户门禁',
        attentionTitle: confirmation ? '现在需要你确认或纠正' : '现在需要你回复',
        attentionDetail: '直接处理原生对话中的问题，不需要在这块面板里回答。',
        needsUser: true,
        next: confirmation
          ? '确认后进入计划与拆解；选择调整则返回需求合并，不会开始修改。'
          : '收到补充后继续分析，形成完整确认内容时会再次明确提醒你。',
        source: 'DSH 待处理交互', tone: 'gate', agents,
      }
    }
    if (snapshot.running) {
      const prematureStage = toolStage(snapshot.runningCalls?.at(-1)) ?? agentStage(childAgents)
      if (prematureStage !== undefined && prematureStage >= 2) {
        return {
          stageIndex: 0, stageName: stages[0].name, stagePurpose: '在执行前守住确认边界',
          title: '确认门尚未打开，但检测到执行活动',
          summary: '当前运行状态与预设约束不一致。界面不会把它伪装成正常推进；主 Agent 应立即停止变更并返回需求确认。',
          live: 'Signal Gate 约束异常',
          attentionTitle: '暂时不需要你代替系统纠错', attentionDetail: '若活动没有自动停止，请直接在原生输入框要求暂停。', needsUser: false,
          next: '停止未授权执行，保留证据，形成完整确认内容后再等待明确批准。',
          source: 'DSH 工具与子 Agent 状态', tone: 'return', agents,
        }
      }
      return {
        stageIndex: 0, stageName: stages[0].name, stagePurpose: stages[0].purpose,
        title: '正在理解需求并寻找关键歧义',
        summary: '此时允许只读检查与分析，不允许实现、修改文件或启动实现 Agent。',
        live: '主 Agent 正在分析',
        attentionTitle: '现在不需要你操作', attentionDetail: '需要补充信息时会在原生对话中明确提问。', needsUser: false,
        next: '合并目标、范围、排除项和验收标准，然后提交一份紧凑确认内容。',
        source: 'Signal Gate · 会话投影', tone: 'active', agents,
      }
    }
    if (interruptedBeforeExecution) {
      return {
        stageIndex: 0, stageName: stages[0].name, stagePurpose: '在执行前守住确认边界',
        title: '本轮已停止，没有进入执行',
        summary: '需求分析与只读检查已经结束，确认门没有打开；中断后的提问不再要求你回答。',
        live: 'Signal Gate 已安全停稳',
        attentionTitle: '现在没有强制操作', attentionDetail: '可以结束，也可以在原生输入框提出新目标重新开始。', needsUser: false,
        next: '若继续这项工作，会重新核对当前边界；新目标则从新的需求分析开始。',
        source: 'DSH 轮次中断状态', tone: 'done', agents,
      }
    }
    if (hasConfirmation) {
      return {
        stageIndex: 0, stageName: stages[0].name, stagePurpose: '确认合并后的需求边界',
        title: '需求已经合并，正在等待你的明确确认',
        summary: '确认门仍然关闭。指出需要修改的地方，或在原生输入框明确确认后再开始执行。',
        live: '后台没有继续实现',
        attentionTitle: '现在需要你确认或纠正', attentionDetail: '直接回复确认，也可以继续补充边界。', needsUser: true,
        next: '明确确认后才进入计划与拆解；普通的“嗯”“可以”不会自动打开确认门。',
        source: 'Signal Gate · 会话投影', tone: 'gate', agents,
      }
    }
    const asked = /[？?]/u.test(lastAssistant)
    return {
      stageIndex: 0, stageName: stages[0].name, stagePurpose: stages[0].purpose,
      title: asked ? '有一个关键点需要你补充' : '正在合并目前已知的需求',
      summary: asked ? 'Agent 已在原生对话中提出问题；回答后会继续合并，不需要操作这块面板。' : '当前信息还没有形成可确认的完整需求。',
      live: asked ? '等待你的自然语言回复' : '等待下一轮分析',
      attentionTitle: asked ? '现在需要你回复' : '暂时不需要操作', attentionDetail: '所有交流都使用下方原生输入框。', needsUser: asked,
      next: '补齐材料信息后形成需求确认，再等待你明确批准。',
      source: 'Signal Gate · 会话投影', tone: asked ? 'gate' : 'active', agents,
    }
  }

  if (pending !== undefined) {
    const stageIndex = pendingStage(pending, liveText)
    const activeStage = stages[stageIndex]
    const blocked = /后续|如何继续|受阻|拒绝|失败|守卫|拦截|中断/iu.test(pendingCopy(pending))
    return {
      stageIndex, stageName: activeStage.name,
      stagePurpose: blocked ? '处理执行证据并选择最小返回路径' : activeStage.purpose,
      title: blocked ? '执行遇到阻碍，正在等待你的决定' : `${activeStage.name}暂停在一个用户门禁`,
      summary: blocked
        ? '已确认的范围没有被悄悄扩大。DSH 已暂停后续动作，问题与可选路径显示在原生对话中。'
        : '这不是重新做需求确认，而是已确认工作流中的一次阶段性决定；未获得回复前不会越过门禁。',
      live: blocked ? '异常证据已保留 · 后台已停在门禁' : '工作流已暂停在阶段门禁',
      attentionTitle: '现在需要你作出决定', attentionDetail: '直接处理原生对话中的选项，也可以用自然语言提出另一条路径。', needsUser: true,
      next: blocked
        ? '选择后只返回最小责任阶段；若选择停止，则保留现状并诚实交付未完成项。'
        : '收到决定后继续当前阶段，不会重跑已经通过且未受影响的部分。',
      source: 'DSH 待处理交互', tone: blocked ? 'return' : 'gate', agents,
    }
  }

  if (run !== undefined) {
    const phases = run.data?.phases ?? []
    const phaseMembers = phases.flatMap(phase => (phase.members ?? []).map(member => ({ phase: phase.phase, member })))
    const running = phaseMembers.filter(item => item.member.status === 'running')
    const completed = phaseMembers.filter(item => item.member.status === 'completed')
    const failed = phaseMembers.find(item => item.member.status === 'failed' || item.member.status === 'interrupted')
    const runStatus = run.data?.status

    if (failed !== undefined && snapshot.running) {
      return {
        stageIndex: 2, stageName: stages[2].name, stagePurpose: '修正验证发现的问题',
        title: '执行发现问题，正在返回最小责任阶段',
        summary: `${failed.member.label?.trim() || '一个子 Agent'} 未通过；已完成部分保持不变，主 Agent 正在判断需要局部修正的位置。`,
        live: '失败证据已保留 · 自动回流处理中',
        attentionTitle: '暂时不需要你处理', attentionDetail: '连续失败、扩大范围或改变边界时才会请求决定。', needsUser: false,
        next: '修正对应实现后按当前合同重新验证；能否缩小复验范围以受控运行记录为准。',
        source: 'DSH 持久工作流事件', tone: 'return', agents,
      }
    }

    if (runStatus === 'running' || running.length > 0) {
      const activePhase = running.at(-1)?.phase ?? phases.at(-1)?.phase
      const stageIndex = stageForPhase(activePhase)
      const activeStage = stages[stageIndex]
      return {
        stageIndex, stageName: activeStage.name, stagePurpose: activeStage.purpose,
        title: running.length > 1 ? `${running.length} 个 Agent 正在并行推进` : '工作流正在执行已确认的范围',
        summary: running.length > 0
          ? running.map(item => `${item.member.label?.trim() || '未命名 Agent'}：${item.phase?.trim() || '执行'}`).join('；')
          : '工作流已启动，正在等待第一个子 Agent 发布运行状态。',
        live: `${running.length} 个运行中 · ${completed.length} 个已完成`,
        attentionTitle: '现在不需要你操作', attentionDetail: '你仍可随时在原生输入框纠偏、暂停或要求撤销。', needsUser: false,
        next: '当前成员完成后按依赖关系汇合；失败会返回相应阶段并保留证据。',
        source: 'DSH 持久工作流事件', tone: 'active', agents,
      }
    }

    if (runStatus === 'failed' || runStatus === 'interrupted' || runStatus === 'cancelled') {
      return {
        stageIndex: Math.max(2, stageForPhase(failed?.phase)), stageName: '执行中断', stagePurpose: '保留证据并等待处置',
        title: '本次工作流没有正常完成',
        summary: '终态已经由 DSH 持久记录。请先查看主 Agent 在原生对话中的说明，再决定修正、缩小范围或停止。',
        live: `工作流状态：${statusText(runStatus)}`,
        attentionTitle: '可能需要你的决定', attentionDetail: '如果主 Agent 已提出选项，请直接在原生输入框回复。', needsUser: !snapshot.running,
        next: '只有在边界明确后才会重新进入实现或验证。',
        source: 'DSH 持久工作流事件', tone: 'return', agents,
      }
    }

    if (snapshot.running) {
      return {
        stageIndex: 3, stageName: stages[3].name, stagePurpose: stages[3].purpose,
        title: '子任务已经汇合，主 Agent 正在验证整体结果',
        summary: `${completed.length} 个子 Agent 已完成。现在检查结果是否满足验收标准，而不是把“写完”当作完成。`,
        live: '正在汇总证据与验证结果',
        attentionTitle: '现在不需要你操作', attentionDetail: '发现限制或风险时会明确说明。', needsUser: false,
        next: '验证通过后进入独立审查；不通过则返回最小责任阶段。',
        source: 'DSH 持久工作流事件', tone: 'active', agents,
      }
    }
  }

  const activeChildren = childAgents.filter(agent => agent.tone === 'active')
  const activeCall = snapshot.runningCalls?.at(-1)
  const activeCallStage = toolStage(activeCall)
  const inferredStage = semanticStage(partial)
    ?? activeCallStage
    ?? agentStage(activeChildren)
    ?? semanticStage(lastAssistant)
    ?? 2
  const recentFailure = failedToolResult(nodes, lastUserSeq)

  if (activeChildren.length > 0) {
    const stageIndex = inferredStage
    const activeStage = stages[stageIndex]
    return {
      stageIndex, stageName: activeStage.name, stagePurpose: activeStage.purpose,
      title: activeChildren.length > 1
        ? `${activeChildren.length} 个 Agent 正在并行推进`
        : `${activeChildren[0].label} 正在推进已确认范围`,
      summary: activeChildren.map(agent => `${agent.label}：${agent.detail}`).join('；'),
      live: `${activeChildren.length} 个子 Agent 运行中 · 主 Agent 正在编排`,
      attentionTitle: '现在不需要你操作', attentionDetail: '你仍可随时通过原生输入框纠偏、暂停或要求撤销。', needsUser: false,
      next: '子 Agent 完成后由主 Agent汇合结果，再进入与风险相称的验证和审查。',
      source: 'DSH 子 Agent 目录', tone: 'active', agents,
    }
  }

  if (snapshot.running && activeCall !== undefined) {
    const stageIndex = inferredStage
    const activeStage = stages[stageIndex]
    return {
      stageIndex, stageName: activeStage.name, stagePurpose: activeStage.purpose,
      title: stageActivity(stageIndex),
      summary: activeCall.name === undefined
        ? '主 Agent 正在执行当前阶段的一个工具步骤。'
        : `主 Agent 正在调用 ${activeCall.name}；该动作属于已经确认的范围。`,
      live: '工具调用进行中',
      attentionTitle: '现在不需要你操作', attentionDetail: '需要批准或发生范围变化时会自动停在门禁。', needsUser: false,
      next: '工具返回后读取真实结果；失败时保留证据并返回最小责任阶段。',
      source: 'DSH 运行中工具调用', tone: 'active', agents,
    }
  }

  if (snapshot.running && recentFailure !== undefined) {
    return {
      stageIndex: 2, stageName: stages[2].name, stagePurpose: '处理工具或守卫返回的失败证据',
      title: '执行被拒绝或失败，主 Agent 正在判断返回路径',
      summary: failureDetail(recentFailure),
      live: '失败证据已保留 · 尚未宣称完成',
      attentionTitle: '暂时不需要你操作', attentionDetail: '只有替代路径需要扩大范围或改变边界时才会请求决定。', needsUser: false,
      next: '优先修正最小责任问题，再按当前执行策略完成必要复验。',
      source: 'DSH 工具结果', tone: 'return', agents,
    }
  }

  if (snapshot.running) {
    const stageIndex = inferredStage
    const activeStage = stages[stageIndex]
    return {
      stageIndex, stageName: activeStage.name, stagePurpose: activeStage.purpose,
      title: stageActivity(stageIndex),
      summary: partial.length > 0
        ? '主 Agent 正在处理当前阶段；以 DSH 的结构化运行状态和最终工具结果作为完成依据。'
        : '当前没有活跃子 Agent 或工具调用，主 Agent 正在组织下一步。',
      live: '主 Agent 运行中',
      attentionTitle: '现在不需要你操作', attentionDetail: '出现歧义、风险或审批时会明确切换为“需要你”。', needsUser: false,
      next: '继续推进当前阶段；任何失败都不会被自动等同于完成。',
      source: 'DSH 会话运行状态', tone: 'active', agents,
    }
  }

  const settled = /【沉淀】|沉淀|复盘|可复用规则/u.test(lastAssistant)
  const delivered = /【交付】|完成|交付|测试通过|验证通过|已实现|已停止/u.test(lastAssistant)
  const outcome = classifyWorkflowOutcome(lastAssistant)
  if (outcome === 'qualified') {
    return {
      stageIndex: settled ? 6 : 5,
      stageName: settled ? stages[6].name : stages[5].name,
      stagePurpose: '区分已完成工作与未满足的硬性验收',
      title: '本轮已停稳，但存在已接受的验收偏差',
      summary: '结果只能标记为有条件通过，不能显示为全绿；原生交付中应列明通过项、偏差和用户豁免。',
      live: '结论：有条件通过',
      attentionTitle: '当前没有强制操作',
      attentionDetail: '可以接受现状，或只继续处理尚未满足的验收项。',
      needsUser: false,
      next: '若继续，仅返回未满足项的最小责任阶段；已通过且未受影响的部分不重做。',
      source: '最终交付验收分级', tone: 'return', agents,
    }
  }
  if (outcome === 'failed') {
    return {
      stageIndex: settled ? 6 : 5,
      stageName: settled ? stages[6].name : stages[5].name,
      stagePurpose: '保留失败证据并阻止虚假完成',
      title: '本轮已停稳，但硬性验收未通过',
      summary: '最终说明包含未通过或未满足的硬性验收，因此不能显示为完成或全绿。',
      live: '结论：未通过',
      attentionTitle: '可以决定修正或停止',
      attentionDetail: '继续时只处理失败项；新目标仍需重新经过 Signal Gate。',
      needsUser: false,
      next: '返回失败项对应的责任阶段；复验范围以当前受控合同为准。',
      source: '最终交付验收分级', tone: 'return', agents,
    }
  }
  if (!settled && !delivered && recentFailure !== undefined) {
    return {
      stageIndex: 2, stageName: '执行中断', stagePurpose: '保留失败证据并等待处置',
      title: '本次执行没有形成正常交付',
      summary: failureDetail(recentFailure),
      live: '当前没有后台 Agent 在运行',
      attentionTitle: '可以决定修正或停止', attentionDetail: '直接在原生输入框说明，不需要操作状态面板。', needsUser: false,
      next: '继续时会回到最小责任阶段；提出新目标则重新经过 Signal Gate。',
      source: 'DSH 工具结果', tone: 'return', agents,
    }
  }
  const stageIndex = settled ? 6 : delivered ? 5 : 4
  const activeStage = stages[stageIndex]
  return {
    stageIndex, stageName: activeStage.name, stagePurpose: activeStage.purpose,
    title: settled ? '本轮已经停稳，并整理了可复用经验' : delivered ? '结果已经交付，变化仍可检查' : '等待独立审查或下一步说明',
    summary: lastAssistant.length > 0 ? '执行已经停止；以原生对话中的最终交付内容为准。面板不会替代结果说明。' : '当前没有正在运行的工作流。',
    live: '本轮没有后台 Agent 在运行',
    attentionTitle: '现在没有强制操作', attentionDetail: '可以结束、继续提出想法，或要求检查和撤销变化。', needsUser: false,
    next: '新想法会重新进入需求确认，不会绕过本预设的工作流。',
    source: run === undefined ? '会话状态投影' : 'DSH 持久工作流事件', tone: 'done', agents,
  }
}

function useWorkflowState(source: WorkflowSnapshotSource, sessionId: string, enabled: boolean) {
  const subscribe = useCallback((notify: () => void) => enabled ? source.subscribe(sessionId, notify) : () => {}, [source, sessionId, enabled])
  const getSnapshot = useCallback(() => source.getSnapshot(sessionId), [source, sessionId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function useWorkflowProjection({
  sessionId, useSessions, useSession, useConversation, useSessionPendingInteraction, source,
}: WorkflowHeaderActionProps) {
  const preset = useSessions(state => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const authoritativeRunning = useSessions(state => state.byId[sessionId]?.running)
  const sessionSummaries = useSessions(state => state.byId)
  const subagentCatalogs = useSessions(state => state.subagentsByParent)
  const session = useSession(state => state)
  const conversation = useConversation(state => state)
  const pending = useSessionPendingInteraction(state => state.get(sessionId))
  const chat = conversation.views.get('chat')
  const state = useWorkflowState(source, sessionId, preset === PRESET_ID)
  const effectiveSession: ConversationSnapshot = {
    blank: session.blank,
    running: authoritativeRunning ?? session.running,
    nodes: chat?.legacy.nodes ?? [],
    partial: chat?.legacy.partial ?? null,
    runningCalls: chat?.legacy.runningCalls ?? [],
    pending: pending === undefined ? [] : [pending],
  }
  const nativeAgents = subagentLines(
    { byId: sessionSummaries, subagentsByParent: subagentCatalogs }, sessionId, effectiveSession,
  )
  const nodes = allConversationNodes(effectiveSession)
  const users = nodes.filter(node => node.kind === 'user')
  const lastUserSeq = users.at(-1)?.seq ?? -1
  const assistant = assistantText(nodes.filter(node => node.kind === 'assistant').at(-1) ?? {})
  const partial = partialAssistantText(effectiveSession)
  const projection = state.status === 'absent'
    ? displayPreRunConversation({
      blank: effectiveSession.blank,
      hasUserGoal: users.length > 0,
      running: effectiveSession.running,
      pending: pending === undefined ? null : pending.kind === 'approval' || isConfirmationWait(pending) ? 'confirmation' : 'question',
      interrupted: gateInterrupted(nodes, lastUserSeq),
      assistantText: [assistant, partial].filter(Boolean).join('\n'),
      recovery: state.snapshot?.preRunRecovery ?? undefined,
    }, nativeAgents, stages)
    : displayWorkflowState(state, nativeAgents, stages)
  return { enabled: preset === PRESET_ID, state, projection }
}

function WorkflowView(props: WorkflowHeaderActionProps) {
  const { enabled, projection } = useWorkflowProjection(props)
  return enabled ? h(WorkflowSurface, { projection, stages }) : null
}

function WorkflowHeaderStatus(props: WorkflowHeaderActionProps) {
  const { enabled, state, projection } = useWorkflowProjection(props)
  // An empty/loading run must not create a permanent extra badge or composer card.
  if (!enabled || state.status === 'loading'
    || (state.status === 'absent' && state.snapshot.preRunRecovery == null)) return null
  return h(WorkflowStatus, { projection, placement: 'header' })
}

export const inject = ['slots', 'connection', 'sessions']

export function apply(ctx: any): void {
  const source = new WorkflowSnapshotSource(ctx.connection.rpc)
  ctx.effect(() => {
    const generation = ctx.connection.generation
    const changed = () => source.connectionChanged(generation.getSnapshot() !== undefined)
    const unsubscribe = generation.subscribe(changed)
    changed()
    return () => { unsubscribe(); source.dispose() }
  }, 'workflow-agent-runtime: committed snapshot source')
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.dataset.plugin = ID
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'workflow-agent-runtime: styles')

  // Priority precedes DSH's generic question entry (0). The exact Host label
  // keeps this takeover limited to the layered workflow's first, read-only gate.
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    select: selectRequirementsGate,
    priority: -10,
  }, RequirementsGateComposer))

  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    select: selectManualRecoveryGate,
    priority: -10,
  }, ManualRecoveryGateComposer))

  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    select: selectBudgetGate,
    priority: -10,
  }, BudgetGateComposer))

  ctx.slots.inject('conversation.view', () => bindWorkflowView(ctx.sessions.list, () => ctx.slots.register({
    name: 'conversation.view',
    id: WORKFLOW_VIEW_ID,
    order: 20,
    label: '工作流',
  }, (props: Omit<WorkflowHeaderActionProps, 'source'>) => h(WorkflowView, { ...props, source }))))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'workflow-agent-runtime',
    order: 10,
    label: '工作流状态',
  }, (props: Omit<WorkflowHeaderActionProps, 'source'>) => h(WorkflowHeaderStatus, { ...props, source })))
}
