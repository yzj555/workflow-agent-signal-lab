import { createElement as h, useRef, useState } from 'react'
import { Button, DisclosureRow, IconBranchOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { decideManualRecovery, discussManualRecovery } from './manual-recovery-gate-contract.ts'
import type { ManualRecoveryWait } from './manual-recovery-gate-contract.ts'
import { KEEP_UNKNOWN_LABEL, MANUAL_CLOSE_LABEL } from '../workflow-ui-contract.ts'

type Props = { matched: ManualRecoveryWait }
const labels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '脚注' } as const

/** The native chain owns placement and withdrawal. A new request gets fresh local UI state. */
export function ManualRecoveryGateComposer({ matched }: Props) {
  return h(ManualRecoveryDecision, { key: JSON.stringify([matched.sessionId, matched.key, matched.questions[0].id]), matched })
}
function ManualRecoveryDecision({ matched }: Props) {
  const question = matched.questions[0]
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<'keep' | 'close' | 'discuss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)
  const settle = (choice: 'keep' | 'close' | 'discuss'): void => {
    if (sending.current) return
    sending.current = true
    setBusy(choice)
    setError(null)
    void Promise.resolve().then(() => choice === 'discuss'
      ? discussManualRecovery(matched) : decideManualRecovery(matched, choice)).catch((cause: unknown) => {
      sending.current = false
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return h('div', { className: 'wfr-requirements-frame wfr-recovery-frame', 'data-manual-recovery-gate-key': matched.key },
    h('section', { className: 'wfr-requirements-card wfr-recovery-card', 'aria-label': question.question, 'aria-busy': busy !== null },
      h('header', { className: 'wfr-requirements-header' },
        h('div', { className: 'wfr-requirements-heading' }, h(IconBranchOutline16),
          h('span', null, h('strong', null, question.header), h('small', null, '结束旧运行，不恢复执行'))),
        h('span', { className: 'wfr-recovery-state' }, '退出未证实')),
      h('div', { className: 'wfr-recovery-body' },
        h('p', { className: 'wfr-requirements-question' }, question.question),
        h('p', { className: 'wfr-recovery-summary' }, '仅记录人工结束；不停止进程、不撤销文件、不续跑。新任务仍需重新确认。'),
        h('p', { className: 'wfr-recovery-caution' }, '请展开核对全部依据。核实陈述由 Agent 整理，系统未独立验证；未核实时保持阻塞。'),
        h(DisclosureRow, {
          icon: h(IconBranchOutline16), title: '核实陈述与处置范围', open: expanded,
          expandable: true, expandOnRowClick: true, onToggle: () => setExpanded(value => !value),
          className: 'wfr-disclosure wfr-recovery-disclosure',
        }, h('div', { className: 'wfr-recovery-evidence' }, h(MarkdownText, { text: question.detail, labels }))),
      ),
      h('footer', { className: 'wfr-requirements-footer wfr-recovery-footer' },
        error ? h('p', { className: 'wfr-requirements-feedback', role: 'alert' }, error) : null,
        h('div', { className: 'wfr-recovery-actions' },
          h(Button, { variant: 'ghost', disabled: busy !== null, onClick: () => settle('discuss') }, busy === 'discuss' ? '正在返回…' : '返回对话'),
          h('div', { className: 'wfr-requirements-actions' },
            h(Button, { variant: 'outline', disabled: busy !== null,
              title: question.options.find(option => option.label === KEEP_UNKNOWN_LABEL)?.description,
              onClick: () => settle('keep') }, busy === 'keep' ? '正在提交…' : '保持阻塞'),
            h(Button, { variant: 'primary', disabled: busy !== null,
              title: question.options.find(option => option.label === MANUAL_CLOSE_LABEL)?.description,
              onClick: () => settle('close') }, busy === 'close' ? '正在提交…' : '人工结束本轮'),
          ),
        ),
      ),
    ),
  )
}
