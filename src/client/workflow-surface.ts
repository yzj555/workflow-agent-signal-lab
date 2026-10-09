import { createElement as h, useState } from 'react'
import {
  DisclosureRow, IconAgentPresetOutlineMedium as IconAgentPresetOutline16, IconBranchOutlineMedium as IconBranchOutline16,
  IconCheckOutlineMedium as IconCheckOutline14, IconRefreshOutlineMedium as IconRefreshOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentLine, LearningLine, ManualCloseRecord, PlanMilestone, WorkflowPlanProjection, WorkflowProjection } from './workflow-display.ts'
import { workflowStatusLabel } from './workflow-display.ts'

export interface WorkflowStageDescription { name: string; purpose: string }

function statusIcon(projection: WorkflowProjection) {
  if (projection.uncertain) return h(IconBranchOutline16)
  if (projection.badge === '有条件通过') return h(StateDot, { state: 'warning' })
  if (projection.badge === '已取消') return h(IconBranchOutline16)
  if (projection.badge === '人工结束') return h(IconBranchOutline16)
  if (projection.rollback) return h(IconRefreshOutline16, { className: 'wfr-rollback-icon' })
  if (projection.needsUser) return h(StateDot, { state: 'warning' })
  if (projection.tone === 'return') return h(StateDot, { state: 'error' })
  if (projection.tone === 'done') return h(StateDot, { state: 'done' })
  // A saved running record is not a heartbeat. Do not animate it as a live Agent.
  return h(IconBranchOutline16)
}

export function WorkflowStatus({ projection, placement = 'view' }: {
  projection: WorkflowProjection
  placement?: 'header' | 'view'
}) {
  const tone = projection.uncertain || projection.badge === '已取消' ? 'neutral'
    : projection.badge === '人工结束' ? 'manual-close'
    : projection.rollback ? 'rollback'
    : projection.badge === '有条件通过' || projection.badge === '待撤销确认' || projection.badge === '待沉淀' ? 'gate' : projection.tone
  return h('span', {
    className: 'wfr-status', 'data-tone': tone, 'data-placement': placement,
    title: `${projection.stageName} · ${projection.source}`, role: 'status',
  }, statusIcon(projection), h('span', null,
    workflowStatusLabel(projection),
  ))
}

function stagePresentation(projection: WorkflowProjection, index: number) {
  const recorded = projection.stageDetails?.[index]
  if (recorded) return recorded
  const state = projection.stageStates?.[index] ?? 'locked'
  return { state, label: state === 'done' ? '已完成' : state === 'current' ? '当前阶段' : '暂无记录', reason: '以控制层已保存记录为准；没有记录不代表已完成或获准跳过。' }
}

function stageMarker(state: string, index: number) {
  return h('span', { className: 'wfr-step-marker', 'aria-hidden': true },
    state === 'rolled_back' ? h(IconRefreshOutline16, { className: 'wfr-rollback-icon' })
      : state === 'done' ? h(IconCheckOutline14)
      : ['merged', 'not_required', 'unavailable', 'not_run'].includes(state) ? '−'
        : ['failed', 'blocked'].includes(state) ? '×' : state === 'ended' ? '•' : String(index + 1),
  )
}

function AgentRow({ agent }: { agent: AgentLine }) {
  const [open, setOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const check = agent.verification
  return h('li', { className: 'wfr-agent', 'data-tone': agent.tone },
  h('span', { className: 'wfr-agent-icon', 'aria-hidden': true }, h(IconAgentPresetOutline16)),
  h('div', { className: 'wfr-agent-copy' },
    h('div', { className: 'wfr-agent-heading' }, h('strong', { title: agent.label }, agent.label),
      h('span', { className: 'wfr-agent-status' }, agent.status)),
    h('p', null, agent.detail),
    agent.interruptionHistory ? h(DisclosureRow, {
      icon: h(IconBranchOutline16), title: '历史中断记录', open: historyOpen,
      expandable: true, expandOnRowClick: true, onToggle: () => setHistoryOpen(value => !value),
      className: 'wfr-disclosure wfr-verification-disclosure wfr-agent-history-disclosure',
    }, h('div', { className: 'wfr-verification-detail wfr-agent-history' },
      h('p', { className: 'wfr-muted' }, '以下是中断发生时保存的记录，不是当前操作要求。'),
      ...agent.interruptionHistory.map((text, index) => h('p', { key: index }, text)),
    )) : null,
    check ? h(DisclosureRow, {
      icon: h(IconBranchOutline16),
      title: `核实依据 · ${check.evidence.length} 条`, open,
      expandable: true, expandOnRowClick: true, onToggle: () => setOpen(value => !value),
      className: 'wfr-disclosure wfr-verification-disclosure',
    }, h('div', { className: 'wfr-verification-detail' },
      h('p', { className: 'wfr-muted' }, '以下为人工核实陈述，不改变 Host 的未知退出记录。'),
      h('ol', { className: 'wfr-verification-list' }, ...check.evidence.map((entry, index) => h('li', { key: index },
        h('strong', null, entry.source), h('p', null, entry.observation)))),
      h('dl', { className: 'wfr-verification-meta' },
        ...Object.entries({ '分工': check.assignmentId, '中断': check.incidentId,
          '任务版本': `v${check.taskVersion}`, '命令': check.commandIds.join('、') || '无关联命令' })
          .map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value))),
      ),
    )) : null,
  ),
  )
}
function agentRows(agents: readonly AgentLine[], emptyText: string | undefined) {
  if (agents.length === 0) return h('p', { className: 'wfr-muted' }, emptyText ?? '当前没有子 Agent。')
  return h('ul', { className: 'wfr-agents' }, ...agents.map((agent, index) => h(AgentRow, {
    key: agent.verification ? `${agent.verification.assignmentId}:${agent.verification.incidentId}` : `${index}:${agent.label}`, agent,
  })))
}

function ManualCloseAudit({ record }: { record: ManualCloseRecord }) {
  const [open, setOpen] = useState(false)
  return h('section', { className: 'wfr-manual-record', 'aria-label': '人工处置记录' },
    h(DisclosureRow, {
      icon: h(IconBranchOutline16), title: '人工处置记录', open,
      expandable: true, expandOnRowClick: true, onToggle: () => setOpen(value => !value),
      className: 'wfr-disclosure',
    }, h('div', { className: 'wfr-verification-detail' },
      h('h4', null, '处置原因'), h('p', null, record.reason),
      h('p', { className: 'wfr-muted' }, '通过原生确认记录；操作者身份未核验。原退出证据与验收待验证记录保留，完整核实陈述见对应 Agent 的“核实依据”。'),
      h('dl', { className: 'wfr-verification-meta' },
        ...Object.entries({ '结论': '人工结束（ABANDONED），非验收通过',
          '记录时间': new Date(record.recordedAt).toLocaleString('zh-CN', { hour12: false }),
          '确认请求': record.decisionAudit.requestId, 'Host 退出': '未证实',
        }).map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value))),
      ),
    )),
  )
}

function learningRows(items: readonly LearningLine[]) {
  if (items.length === 0) return h('p', { className: 'wfr-muted wfr-learning-empty' }, '本轮没有需要长期保留的经验。')
  return h('ul', { className: 'wfr-learning-list' }, ...items.map(item => h('li', {
    className: 'wfr-learning-item', key: item.id, 'data-tone': item.tone,
  },
  h('div', { className: 'wfr-learning-heading' },
    h('strong', null, item.statement), h('span', null, item.status)),
  h('p', null, item.detail),
  )))
}

function planMarker(item: PlanMilestone, index: number) {
  return h('span', { className: 'wfr-plan-marker', 'data-tone': item.tone, 'aria-hidden': true },
    item.tone === 'done' ? h(IconCheckOutline14) : String(index + 1))
}

function planMilestones(items: readonly PlanMilestone[]) {
  return h('ol', { className: 'wfr-plan-milestones', 'aria-label': '计划授权进度' }, ...items.map((item, index) => h('li', {
    className: 'wfr-plan-milestone', 'data-tone': item.tone, key: item.label,
  }, planMarker(item, index), h('div', null,
    h('span', { className: 'wfr-plan-milestone-heading' }, h('strong', null, item.label), h('em', null, item.status)),
    h('p', null, item.detail),
  ))))
}

function planList(items: readonly string[], empty = '无') {
  if (items.length === 0) return h('p', { className: 'wfr-muted wfr-plan-empty' }, empty)
  return h('ul', { className: 'wfr-plan-list' }, ...items.map((item, index) => h('li', { key: `${index}:${item}` }, item)))
}

function fullPlan(plan: WorkflowPlanProjection) {
  const contract = plan.contract
  const taskTitles = new Map(contract.tasks.map(task => [task.taskId, task.title]))
  const planRoleLabels: Readonly<Record<string, string>> = {
    architect: '方案／架构', engineer: '实现', test_engineer: '工程测试',
    code_reviewer: '代码审查', acceptance_qa: '独立验收',
  }
  return h('div', { className: 'wfr-plan-detail' },
    h('section', { className: 'wfr-plan-block' },
      h('h4', null, '目标'), h('p', null, contract.goal),
      h('p', { className: 'wfr-plan-meta' }, `工作区：${contract.workspaceRoot} · 需求版本 v${String(contract.requirementVersion)}`),
    ),
    h('div', { className: 'wfr-plan-columns' },
      h('section', { className: 'wfr-plan-block' }, h('h4', null, '包含'), planList(contract.inScope)),
      h('section', { className: 'wfr-plan-block' }, h('h4', null, '明确不做'), planList(contract.outOfScope)),
    ),
    h('div', { className: 'wfr-plan-columns' },
      h('section', { className: 'wfr-plan-block' }, h('h4', null, '约束'), planList(contract.constraints)),
      h('section', { className: 'wfr-plan-block' }, h('h4', null, '当前假设'), planList(contract.assumptions)),
    ),
    contract.design ? h('section', { className: 'wfr-plan-block wfr-plan-design' },
      h('h4', null, `只读方案 · v${String(contract.design.version)}`),
      h('p', null, contract.design.summary),
      h('dl', { className: 'wfr-plan-definition' },
        h('div', null, h('dt', null, '决策'), h('dd', null, planList(contract.design.decisions.map(item => `${item.id} · ${item.decision} — ${item.rationale}`)))),
        h('div', null, h('dt', null, '影响区域'), h('dd', null, planList(contract.design.affectedAreas))),
        h('div', null, h('dt', null, '接口'), h('dd', null, planList(contract.design.interfaces))),
        h('div', null, h('dt', null, '回滚'), h('dd', null, planList(contract.design.rollback))),
      ),
    ) : null,
    h('section', { className: 'wfr-plan-block' },
      h('h4', null, '角色与依赖'),
      h('ol', { className: 'wfr-plan-tasks' }, ...contract.tasks.map(task => h('li', { key: task.taskId },
        h('div', { className: 'wfr-plan-task-heading' },
          h('strong', null, task.title), h('span', null, `${planRoleLabels[task.role] ?? task.role} · v${String(task.version)}`)),
        h('p', null, task.dependsOn.length ? `等待：${task.dependsOn.map(id => taskTitles.get(id) ?? id).join('、')}` : '无前置任务'),
        h('p', null, `允许：${task.allowedActions.join('；') || '无'}`),
        h('p', null, `禁止：${task.forbiddenActions.join('；') || '无'}`),
      ))),
    ),
    h('section', { className: 'wfr-plan-block' },
      h('h4', null, '写入与权限边界'),
      h('p', { className: 'wfr-plan-meta' }, `可写范围：${contract.writeScopes.join('、')}`),
      planList(contract.permissionBoundaries),
    ),
    h('section', { className: 'wfr-plan-block' },
      h('h4', null, `验收标准 · ${String(contract.criteria.length)} 项`),
      h('ol', { className: 'wfr-plan-checks' }, ...contract.criteria.map(item => h('li', { key: item.id },
        h('strong', null, item.id), h('span', null, item.statement), h('small', null, `证据：${item.checkIds.join('、')}`),
      ))),
    ),
    h('div', { className: 'wfr-plan-columns' },
      h('section', { className: 'wfr-plan-block' },
        h('h4', null, '工程检查'),
        h('ul', { className: 'wfr-plan-checks' }, ...contract.engineeringChecks.map(item => h('li', { key: item.id },
          h('strong', null, item.id), h('span', null, item.purpose), h('code', null, `${item.workdir} > ${item.command}`),
        ))),
      ),
      h('section', { className: 'wfr-plan-block' },
        h('h4', null, '独立黑盒检查'),
        h('ul', { className: 'wfr-plan-checks' }, ...contract.acceptanceChecks.map(item => h('li', { key: item.id },
          h('strong', null, item.id), h('span', null, item.purpose), h('code', null, `${item.workdir} > ${item.command}`),
        ))),
      ),
    ),
  )
}

/** A read-only occupant of conversation.view; the host owns tabs, scrolling and input. */
export function WorkflowSurface({ projection, stages }: {
  projection: WorkflowProjection; stages: readonly WorkflowStageDescription[]
}) {
  const [guideOpen, setGuideOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const hasRun = projection.stageIndex >= 0
  const absent = !hasRun && projection.badge === '尚无记录'
  const rolledBack = projection.rollback !== undefined
  return h('article', { className: 'wfr-view', 'aria-label': '工作流记录', 'data-tone': projection.tone, 'data-rollback': String(rolledBack) },
    h('header', { className: 'wfr-view-heading' },
      h('span', { className: 'wfr-section-label' }, '工作流记录'),
      rolledBack ? null : h(WorkflowStatus, { projection, placement: 'view' }),
    ),
    h('section', { className: 'wfr-overview' },
      h('h2', { className: rolledBack ? 'wfr-rollback-heading' : undefined },
        rolledBack ? h(IconRefreshOutline16, { size: 20, className: 'wfr-rollback-icon' }) : null,
        rolledBack ? '已撤销' : absent ? '还没有工作流记录' : projection.title,
      ),
      projection.rollback ? h('p', { className: 'wfr-result-summary' },
        h('strong', null, `本次已恢复 ${projection.rollback.fileCount} 个文件`),
        '；原交付与验收结论仅作历史记录。',
      ) : h('p', null, absent
          ? '在原生输入框描述目标，澄清并确认后，这里会显示阶段、分工和验收结果。'
          : projection.summary),
      rolledBack ? h('p', { className: 'wfr-task-context' }, projection.title) : null,
      absent ? h('p', { className: 'wfr-muted' }, '当前支持文本工作流；历史对话不会自动补建记录。') : null,
    ),
    !absent ? h('dl', { className: 'wfr-orientation', 'aria-label': '当前工作流判断' },
      rolledBack ? null : h('div', { className: 'wfr-orientation-row' },
        h('dt', null, '现在'), h('dd', null,
          h('strong', null, projection.now ?? projection.title),
          projection.nowDetail ? h('span', null, projection.nowDetail) : null,
        )),
      h('div', { className: 'wfr-orientation-row' },
        h('dt', null, '接下来'), h('dd', null,
          h('strong', null, projection.next),
          projection.nextDetail ? h('span', null, projection.nextDetail) : null,
        )),
      h('div', { className: 'wfr-orientation-row', 'data-needs-user': String(projection.needsUser) },
        h('dt', null, '需要你'), h('dd', null,
          h('strong', null, projection.attentionTitle),
          h('span', null, projection.attentionDetail),
        )),
    ) : null,
    projection.manualClose ? h(ManualCloseAudit, { key: projection.manualClose.gateId, record: projection.manualClose }) : null,
    projection.completionNotice ? h('p', { className: 'wfr-completion', role: 'status' }, rolledBack
      ? '阶段记录 · 下方完成标识仅代表撤销前的历史结果'
      : projection.completionNotice) : null,
    hasRun ? h('ol', { className: 'wfr-track', 'aria-label': '已记录的流程阶段' }, ...stages.map((stage, index) => {
      const presentation = stagePresentation(projection, index)
      const { state } = presentation
      return h('li', {
        className: 'wfr-step', key: stage.name, 'data-state': state,
        'aria-current': state === 'current' ? 'step' : undefined,
        title: `${stage.name} · ${presentation.label}：${presentation.reason}`,
      }, stageMarker(state, index), h('span', { className: 'wfr-step-copy' },
        h('span', { className: 'wfr-step-name' }, stage.name), h('span', { className: 'wfr-step-status' }, presentation.label)))
    })) : null,
    projection.plan ? h('section', { className: 'wfr-section wfr-plan-section', 'aria-label': '计划与授权' },
      h('div', { className: 'wfr-section-heading' },
        h('h3', null, '计划与授权'), h('span', { className: 'wfr-muted' }, projection.plan.modeLabel),
      ),
      h('p', { className: 'wfr-muted wfr-plan-summary' }, projection.plan.summary),
      planMilestones(projection.plan.milestones),
      h(DisclosureRow, {
        icon: h(IconBranchOutline16), title: '完整计划', open: planOpen,
        expandable: true, expandOnRowClick: true, onToggle: () => setPlanOpen(value => !value),
        className: 'wfr-disclosure wfr-plan-disclosure',
        collapsedContent: h('span', { className: 'wfr-source-label' }, '展开查看全部范围、角色、权限、方案和验收检查'),
      }, fullPlan(projection.plan)),
    ) : null,
    projection.agents.length > 0 || (hasRun && !projection.uncertain) ? h('section', { className: 'wfr-section' },
      h('div', { className: 'wfr-section-heading' },
        h('h3', null, hasRun ? 'Agent 分工' : '原生 Agent 观察'),
        h('span', { className: 'wfr-muted' }, `${projection.agents.length} 个 Agent`),
      ),
      h('p', { className: 'wfr-muted wfr-agent-note' }, projection.live),
      agentRows(projection.agents, projection.emptyAgentText),
    ) : null,
    projection.learning ? h('section', { className: 'wfr-section', 'aria-label': '本轮沉淀记录' },
      h('div', { className: 'wfr-section-heading' },
        h('h3', null, '本轮沉淀'),
        h('span', { className: 'wfr-muted' }, '只读记录'),
      ),
      h('p', { className: 'wfr-muted wfr-learning-note' }, projection.learning.summary),
      learningRows(projection.learning.items),
    ) : null,
    h('section', { className: 'wfr-section' },
      h(DisclosureRow, {
        icon: h(IconBranchOutline16), title: '各阶段做什么', open: guideOpen,
        expandable: true, expandOnRowClick: true, onToggle: () => setGuideOpen(value => !value),
        className: 'wfr-disclosure',
      }, h('div', { className: 'wfr-stage-guide' }, ...stages.map((stage, index) => {
        const presentation = stagePresentation(projection, index)
        return h('div', {
          className: 'wfr-stage-row', key: stage.name, 'data-state': presentation.state,
        }, stageMarker(presentation.state, index), h('div', null,
          h('strong', null, `${stage.name} · ${presentation.label}`), h('p', null, stage.purpose),
          h('p', { className: 'wfr-stage-reason' }, presentation.reason)))
      }), h('p', { className: 'wfr-muted' }, '已完成、并入其他阶段、本次无需和尚未接入含义不同；没有明确跳过记录，不把未执行写成已跳过。'))),
    ),
    h('footer', { className: 'wfr-source' },
      h(DisclosureRow, {
        icon: h(IconBranchOutline16), title: '记录说明', open: sourceOpen,
        expandable: true, expandOnRowClick: true, onToggle: () => setSourceOpen(value => !value),
        className: 'wfr-disclosure',
        collapsedContent: h('span', { className: 'wfr-source-label' }, projection.source),
      }, h('div', { className: 'wfr-source-detail' },
        h('p', null, projection.source),
        h('p', null, hasRun ? projection.next : projection.summary),
        h('p', null, '这里只查看记录。需求、确认和修改继续使用原生对话。'),
      )),
    ),
  )
}
