import { createElement as h, useRef, useState } from 'react'
import { Button, IconBranchOutlineMedium as IconBranchOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { decideBudget, discussBudget } from './budget-gate-contract.ts'
import type { BudgetWait } from './budget-gate-contract.ts'
import { BUDGET_KEEP_LABEL, BUDGET_TOPUP_LABEL } from '../workflow-ui-contract.ts'

type Props = { matched: BudgetWait }
const labels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '脚注' } as const

/** Official composer chain owns this card and its removal; no second chat/input. */
export function BudgetGateComposer({ matched }: Props) {
  return h(BudgetDecision, { key: JSON.stringify([matched.sessionId, matched.key, matched.questions[0].id]), matched })
}
function BudgetDecision({ matched }: Props) {
  const question = matched.questions[0]
  const topup = question.intent.approve === BUDGET_TOPUP_LABEL
  const [busy, setBusy] = useState<'keep' | 'approve' | 'discuss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const settle = (choice: 'keep' | 'approve' | 'discuss'): void => {
    if (sending.current) return
    sending.current = true
    setBusy(choice); setError(null)
    void Promise.resolve().then(() => choice === 'discuss' ? discussBudget(matched) : decideBudget(matched, choice))
      .catch((cause: unknown) => {
        sending.current = false; setBusy(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }
  return h('div', { className: 'wfr-requirements-frame wfr-recovery-frame', 'data-budget-gate-key': matched.key },
    h('section', { className: 'wfr-requirements-card wfr-budget-card', 'aria-label': question.question, 'aria-busy': busy !== null },
      h('header', { className: 'wfr-requirements-header' },
        h('div', { className: 'wfr-requirements-heading' }, h(IconBranchOutline16),
          h('span', null, h('strong', null, topup ? '增加本轮额度' : '结束本轮工作流'),
            h('small', null, topup ? '只改变额度，不会自动继续' : '保留产物和记录，不撤销文件'))),
        h('span', { className: 'wfr-recovery-state' }, topup ? '待补额确认' : '待结束确认')),
      h('div', { className: 'wfr-recovery-body wfr-budget-body' },
        h('p', { className: 'wfr-requirements-question' }, question.question),
        h('div', { className: 'wfr-budget-detail' }, h(MarkdownText, { text: question.detail, labels }))),
      h('footer', { className: 'wfr-requirements-footer wfr-recovery-footer' },
        error ? h('p', { className: 'wfr-requirements-feedback', role: 'alert' }, error) : null,
        h('div', { className: 'wfr-recovery-actions' },
          h(Button, { variant: 'ghost', disabled: busy !== null, onClick: () => settle('discuss') }, busy === 'discuss' ? '正在返回…' : '返回对话'),
          h('div', { className: 'wfr-requirements-actions' },
            h(Button, { variant: 'outline', disabled: busy !== null,
              title: question.options.find(option => option.label === BUDGET_KEEP_LABEL)?.description,
              onClick: () => settle('keep') }, busy === 'keep' ? '正在提交…' : '保持暂停'),
            h(Button, { variant: 'primary', disabled: busy !== null,
              title: question.options.find(option => option.label === question.intent.approve)?.description,
              onClick: () => settle('approve') }, busy === 'approve' ? '正在提交…' : topup ? '确认增加额度' : '确认结束本轮')))),
    ))
}
