import { createElement as h } from 'react'

type ContentBlock = { type?: string; text?: string }
type AssistantBlock = { kind?: string; text?: string }

type ConversationNode = {
  kind?: string
  content?: readonly ContentBlock[]
  blocks?: readonly AssistantBlock[]
}

type ConversationSnapshot = {
  blank: boolean
  running: boolean
  nodes: readonly ConversationNode[]
}

type WorkflowViewProps = {
  useSession: <T>(selector: (snapshot: ConversationSnapshot) => T) => T
}

type StageState = 'done' | 'active' | 'locked'

interface Stage {
  key: string
  eyebrow: string
  title: string
  note: string
}

const ID = '@local/workflow-agent-signal-lab'
const STYLE_ID = 'workflow-agent-signal-lab-style'

const stages: readonly Stage[] = [
  { key: 'signal', eyebrow: '01 · SIGNAL', title: '输入信号', note: '从原生输入框进入' },
  { key: 'understand', eyebrow: '02 · ANALYZE', title: '理解与补问', note: '只解决关键歧义' },
  { key: 'merge', eyebrow: '03 · MERGE', title: '需求合并', note: '目标、边界、验收' },
  { key: 'gate', eyebrow: '04 · GATE', title: '确认门', note: '明确确认后才执行' },
  { key: 'orchestrate', eyebrow: '05 · ROUTE', title: '编排', note: '串并行与 Agent 分工' },
  { key: 'build', eyebrow: '06 · BUILD', title: '实现', note: '受控自动推进' },
  { key: 'verify', eyebrow: '07 · VERIFY', title: '验证', note: '证据不通过则返回' },
  { key: 'learn', eyebrow: '08 · LEARN', title: '交付与沉淀', note: '结果与规则分开确认' },
]

const css = `
.wfs-root{height:100%;overflow:auto;color:var(--dsw-alias-label-primary,#eef1f7);background:radial-gradient(circle at 16% 4%,color-mix(in srgb,var(--dsw-alias-brand-primary,#6f7cff) 12%,transparent),transparent 31%),var(--dsw-alias-bg-base,#0c0e12);font-family:var(--dsw-font-family,Inter,system-ui,sans-serif)}
.wfs-shell{max-width:1080px;margin:0 auto;padding:34px 32px 64px}
.wfs-kicker{display:flex;align-items:center;gap:9px;color:var(--dsw-alias-label-tertiary,#8c93a3);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.wfs-live{width:7px;height:7px;border-radius:999px;background:#74d6a0;box-shadow:0 0 0 5px rgba(116,214,160,.1)}
.wfs-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;margin:17px 0 30px}
.wfs-title{font-size:31px;line-height:1.08;letter-spacing:-.035em;margin:0;font-weight:650}
.wfs-sub{max-width:650px;margin:11px 0 0;color:var(--dsw-alias-label-secondary,#b3b8c4);font-size:14px;line-height:1.65}
.wfs-source{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border-radius:14px;padding:12px 14px;min-width:180px}
.wfs-source b{display:block;font-size:12px;font-weight:600}.wfs-source span{display:block;color:var(--dsw-alias-label-tertiary,#8c93a3);font-size:11px;margin-top:4px}
.wfs-now{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,.65fr);gap:14px;margin-bottom:18px}
.wfs-card{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#171a20) 92%,transparent);border-radius:20px;box-shadow:0 18px 50px rgba(0,0,0,.12)}
.wfs-focus{padding:22px 24px;position:relative;overflow:hidden}.wfs-focus:after{content:'';position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary,#7e8cff),#68d5bc,transparent)}
.wfs-label{color:var(--dsw-alias-label-tertiary,#8c93a3);font-size:11px;letter-spacing:.11em;text-transform:uppercase}
.wfs-focusline{display:flex;gap:12px;align-items:center;margin-top:13px}.wfs-index{width:34px;height:34px;display:grid;place-items:center;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#7886ff) 16%,transparent);color:var(--dsw-alias-brand-primary,#9aa5ff);font:600 12px var(--dsw-font-mono,monospace)}
.wfs-focus h2{font-size:18px;margin:0 0 3px;font-weight:620}.wfs-focus p{margin:0;color:var(--dsw-alias-label-secondary,#b3b8c4);font-size:13px}
.wfs-next{margin-top:18px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));display:flex;gap:8px;color:var(--dsw-alias-label-secondary,#b3b8c4);font-size:13px;line-height:1.55}.wfs-next strong{color:var(--dsw-alias-label-primary,#eef1f7);font-weight:600;white-space:nowrap}
.wfs-native{padding:22px}.wfs-native h3{font-size:14px;margin:10px 0 8px;font-weight:620}.wfs-native p{font-size:12px;line-height:1.6;margin:0;color:var(--dsw-alias-label-tertiary,#8c93a3)}
.wfs-composer{margin-top:17px;height:38px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));border-radius:13px;display:flex;align-items:center;padding:0 12px;color:var(--dsw-alias-label-dimmed,#727987);font-size:11px;background:var(--dsw-specific-input-major,rgba(0,0,0,.12))}.wfs-composer:after{content:'↵';margin-left:auto;color:var(--dsw-alias-label-tertiary,#8c93a3)}
.wfs-flow{padding:22px 20px 20px}.wfs-flowhead{display:flex;justify-content:space-between;align-items:center;padding:0 4px 17px}.wfs-flowhead h3{font-size:13px;margin:0;font-weight:620}.wfs-flowhead span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8c93a3)}
.wfs-track{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.wfs-stage{min-height:116px;padding:14px;border-radius:15px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.025));position:relative;transition:border-color .2s,transform .2s}.wfs-stage[data-state=active]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#7787ff) 60%,transparent);background:linear-gradient(145deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#7787ff) 11%,transparent),var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03)));transform:translateY(-2px)}.wfs-stage[data-state=done]{border-color:rgba(104,213,188,.28)}.wfs-stage[data-state=locked]{opacity:.47}
.wfs-dot{position:absolute;right:13px;top:13px;width:8px;height:8px;border-radius:99px;background:var(--dsw-alias-border-l3,#4b505c)}.wfs-stage[data-state=active] .wfs-dot{background:var(--dsw-alias-brand-primary,#7f8dff);box-shadow:0 0 0 5px color-mix(in srgb,var(--dsw-alias-brand-primary,#7f8dff) 13%,transparent)}.wfs-stage[data-state=done] .wfs-dot{background:#68d5bc}
.wfs-stage small{font:550 9px/1.2 var(--dsw-font-mono,monospace);letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#8c93a3)}.wfs-stage h4{font-size:14px;margin:24px 0 7px;font-weight:610}.wfs-stage p{font-size:11px;line-height:1.45;margin:0;color:var(--dsw-alias-label-tertiary,#8c93a3)}
.wfs-foot{display:flex;align-items:flex-start;gap:10px;margin:15px 4px 0;color:var(--dsw-alias-label-tertiary,#8c93a3);font-size:11px;line-height:1.55}.wfs-foot b{font-weight:600;color:var(--dsw-alias-label-secondary,#b3b8c4)}
@media(max-width:780px){.wfs-shell{padding:24px 16px 48px}.wfs-head,.wfs-now{grid-template-columns:1fr}.wfs-source{min-width:0}.wfs-track{grid-template-columns:repeat(2,minmax(0,1fr))}}
`

function textOfUser(node: ConversationNode): string {
  if (node.kind !== 'user' && node.kind !== 'steering') return ''
  return (node.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
}

function textOfAssistant(node: ConversationNode): string {
  if (node.kind !== 'assistant') return ''
  return (node.blocks ?? []).filter(block => block.kind === 'text').map(block => block.text ?? '').join(' ')
}

function isExplicitConfirmation(text: string): boolean {
  const value = text.trim()
  return /^(确认|确认无误|同意并开始|开始执行|按这个执行|可以开始)([。！!\s]|$)/u.test(value)
}

function phaseOf(snapshot: ConversationSnapshot): {
  active: number
  title: string
  detail: string
  next: string
} {
  const users = snapshot.nodes.filter(node => node.kind === 'user' || node.kind === 'steering')
  const assistants = snapshot.nodes.filter(node => node.kind === 'assistant')
  const confirmed = users.slice(1).some(node => isExplicitConfirmation(textOfUser(node)))
  const assistantText = assistants.map(textOfAssistant).join('\n')
  const hasConfirmationSheet = /需求确认|确认单|验收标准|执行边界/u.test(assistantText)

  if (snapshot.blank || users.length === 0) {
    return { active: 0, title: '等待你的目标', detail: '先在下方原生输入框描述你想完成的事。', next: '输入目标；工作流不会仅凭模糊词直接执行。' }
  }
  if (confirmed) {
    return snapshot.running
      ? { active: 4, title: '确认门已打开', detail: 'Agent 正在把已确认需求转换为依赖与推进顺序。', next: '继续在原生输入框纠偏、暂停或补充边界。' }
      : { active: 4, title: '已确认，等待编排', detail: '确认事件已出现在当前会话；后续阶段尚未由权威运行时接管。', next: '让 Agent 继续；本切片只验证 Signal Gate。' }
  }
  if (assistants.length === 0 || snapshot.running) {
    return { active: 1, title: '正在理解需求', detail: '此阶段允许分析与只读检查，不允许实现或修改。', next: '等待 Agent 合并信息并提出必要问题。' }
  }
  if (hasConfirmationSheet) {
    return { active: 3, title: '等待明确确认', detail: 'Agent 已给出需求确认内容；门禁仍然关闭。', next: '在原生输入框确认，或直接指出要改的地方。' }
  }
  return { active: 2, title: '正在合并需求', detail: '已有一次 Agent 回应，但尚未识别到完整确认内容。', next: '继续回答关键问题；不需要操作这张图。' }
}

function stateOf(index: number, active: number): StageState {
  if (index < active) return 'done'
  if (index === active) return 'active'
  return 'locked'
}

function WorkflowView({ useSession }: WorkflowViewProps) {
  const snapshot = useSession(value => value)
  const phase = phaseOf(snapshot)

  return h('div', { className: 'wfs-root' },
    h('main', { className: 'wfs-shell' },
      h('div', { className: 'wfs-kicker' },
        h('span', { className: 'wfs-live' }),
        'Workflow Agent · Session projection',
      ),
      h('header', { className: 'wfs-head' },
        h('div', null,
          h('h1', { className: 'wfs-title' }, '工作流在旁边发生，交流仍在对话里。'),
          h('p', { className: 'wfs-sub' }, '这不是第二套操作面板。它把 Agent 当前理解、门禁和后续路径投影出来；你的表达、确认、纠偏与撤销仍通过 DSH 原生输入框完成。'),
        ),
        h('div', { className: 'wfs-source' },
          h('b', null, '只读 · 当前 Session'),
          h('span', null, snapshot.running ? 'Agent 正在响应' : '等待自然语言输入'),
        ),
      ),
      h('section', { className: 'wfs-now' },
        h('article', { className: 'wfs-card wfs-focus' },
          h('div', { className: 'wfs-label' }, 'Current focus'),
          h('div', { className: 'wfs-focusline' },
            h('div', { className: 'wfs-index' }, String(phase.active + 1).padStart(2, '0')),
            h('div', null,
              h('h2', null, phase.title),
              h('p', null, phase.detail),
            ),
          ),
          h('div', { className: 'wfs-next' }, h('strong', null, '下一步'), h('span', null, phase.next)),
        ),
        h('aside', { className: 'wfs-card wfs-native' },
          h('div', { className: 'wfs-label' }, 'One input surface'),
          h('h3', null, '不用在这里点任何东西'),
          h('p', null, '看清它在做什么，然后回到页面底部直接说。自然语言就是控制面。'),
          h('div', { className: 'wfs-composer' }, '继续说、确认、暂停或撤销…'),
        ),
      ),
      h('section', { className: 'wfs-card wfs-flow' },
        h('div', { className: 'wfs-flowhead' },
          h('h3', null, '完整工作流骨架'),
          h('span', null, '本轮只验证 01–04；05–08 尚未接入权威运行时'),
        ),
        h('div', { className: 'wfs-track' },
          ...stages.map((stage, index) => h('article', {
            className: 'wfs-stage',
            'data-state': stateOf(index, phase.active),
            key: stage.key,
          },
          h('span', { className: 'wfs-dot' }),
          h('small', null, stage.eyebrow),
          h('h4', null, stage.title),
          h('p', null, stage.note),
          )),
        ),
        h('div', { className: 'wfs-foot' },
          h('span', null, '◇'),
          h('span', null, h('b', null, '状态说明：'), '当前高亮由会话事件做保守推断；它用于体验验证，不冒充最终工作流状态机。'),
        ),
      ),
    ),
  )
}

export const inject = ['slots']

export function apply(ctx: any): void {
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.dataset.plugin = ID
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'workflow-agent-signal-lab: styles')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'workflow-signal-lab',
    order: 5,
    label: () => '工作流',
  }, WorkflowView))
}
