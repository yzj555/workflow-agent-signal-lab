import { createElement as h, useState } from 'react'
import {
  Button, IconCheckOutlineMedium as IconCheckOutline14, IconEditOutlineMedium as IconEditOutline16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  approveRequirementsGate, requirementsGateQuestion, reviseRequirementsGate,
} from './requirements-gate-contract.ts'
import type { RequirementsGateWait } from './requirements-gate-contract.ts'

interface RequirementsGateComposerProps {
  matched: RequirementsGateWait
}

const markdownLabels = {
  code: { copyLabel: '复制代码', copiedLabel: '已复制' },
  footnotes: '脚注',
} as const

/** Native-composer decision surface for requirement understanding and read-only planning only. */
export function RequirementsGateComposer({ matched }: RequirementsGateComposerProps) {
  const question = requirementsGateQuestion(matched)
  const [busy, setBusy] = useState<'approve' | 'revise' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const settle = (kind: 'approve' | 'revise', send: () => Promise<void>): void => {
    setBusy(kind)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return h('div', { className: 'wfr-requirements-frame', 'data-requirements-gate-key': matched.key },
    h('section', {
      className: 'wfr-requirements-card',
      'aria-label': question.question,
      'aria-busy': busy !== null,
    },
    h('header', { className: 'wfr-requirements-header' },
      h('div', { className: 'wfr-requirements-heading' },
        h('span', { className: 'wfr-requirements-dot', 'aria-hidden': true }),
        h('span', null,
          h('strong', null, '需求理解'),
          h('small', null, '先确认理解，再形成方案'),
        ),
      ),
      h('span', { className: 'wfr-requirements-scope' }, '只读规划'),
    ),
    h('div', { className: 'wfr-requirements-body' },
      h('p', { className: 'wfr-requirements-question' }, question.question),
      h('div', { className: 'wfr-requirements-detail', 'data-requirements-gate-scroll': true },
        h(MarkdownText, { text: question.detail, labels: markdownLabels }),
      ),
      h('div', { className: 'wfr-requirements-boundary', 'aria-label': '本次确认的权限边界' },
        h('span', null, h(IconCheckOutline14, { size: 14 }), '只读分析'),
        h('span', null, '不写文件'),
        h('span', null, '不运行检查'),
      ),
    ),
    h('footer', { className: 'wfr-requirements-footer' },
      h('div', { className: 'wfr-requirements-feedback', role: 'status' }, error),
      h('div', { className: 'wfr-requirements-actions' },
        h(Button, {
          variant: 'ghost',
          icon: h(IconEditOutline16, { size: 14 }),
          disabled: busy !== null,
          onClick: () => { settle('revise', () => reviseRequirementsGate(matched)) },
        }, busy === 'revise' ? '正在返回…' : '返回对话修改'),
        h(Button, {
          variant: 'primary',
          title: question.options[0].description,
          disabled: busy !== null,
          onClick: () => { settle('approve', () => approveRequirementsGate(matched)) },
        }, busy === 'approve' ? '正在确认…' : '确认理解并开始只读规划'),
      ),
    ),
    ),
  )
}
