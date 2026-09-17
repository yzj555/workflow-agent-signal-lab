import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bindWorkflowView, WORKFLOW_PRESET_ID } from '../lib/workflow-native-seats.js'

function selection(initial = { byId: {} }) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    set: next => { value = next; for (const listener of [...listeners]) listener() },
    get observers() { return listeners.size },
  }
}

function selected(preset, current = 'session-a') {
  return { current, byId: { [current]: { projectionValues: { agentPreset: preset } } } }
}

test('native workflow tab follows explicit preset selection, not text or the presence of a task', () => {
  const source = selection()
  let mounts = 0
  let releases = 0
  const dispose = bindWorkflowView(source, () => { mounts++; return () => releases++ })
  source.set(selected('standard'))
  assert.equal(mounts, 0)
  source.set(selected(WORKFLOW_PRESET_ID))
  assert.equal(mounts, 1)
  source.set(selected(WORKFLOW_PRESET_ID))
  source.set(selected(WORKFLOW_PRESET_ID, 'session-b'))
  assert.equal(mounts, 1, 'native session props switch without duplicating the global view seat')
  source.set(selected('crew'))
  assert.equal(releases, 1)
  source.set(selected(WORKFLOW_PRESET_ID))
  assert.equal(mounts, 2)
  dispose()
  assert.equal(releases, 2)
  assert.equal(source.observers, 0)
})

test('missing session metadata withdraws the optional view and teardown is idempotent', () => {
  const source = selection(selected(WORKFLOW_PRESET_ID))
  let releases = 0
  const dispose = bindWorkflowView(source, () => () => releases++)
  source.set({ current: 'session-a', byId: {} })
  assert.equal(releases, 1)
  dispose()
  dispose()
  source.set(selected(WORKFLOW_PRESET_ID))
  assert.equal(releases, 1)
  assert.equal(source.observers, 0)
})

test('a failed initial native seat registration does not leak its selection subscription', () => {
  const source = selection(selected(WORKFLOW_PRESET_ID))
  assert.throws(() => bindWorkflowView(source, () => { throw new Error('slot unavailable') }), /slot unavailable/)
  assert.equal(source.observers, 0)
})

test('client presentation uses additive native seats and no independent composer, portal, or hard-coded palette', async () => {
  const runtime = await readFile(new URL('../src/client/runtime.ts', import.meta.url), 'utf8')
  const requirements = await readFile(new URL('../src/client/requirements-gate-composer.ts', import.meta.url), 'utf8')
  const recovery = await readFile(new URL('../src/client/manual-recovery-gate-composer.ts', import.meta.url), 'utf8')
  const budget = await readFile(new URL('../src/client/budget-gate-composer.ts', import.meta.url), 'utf8')
  const surface = await readFile(new URL('../src/client/workflow-surface.ts', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../src/client/workflow-styles.ts', import.meta.url), 'utf8')
  assert.match(runtime, /ctx\.slots\.inject\('conversation\.composer'/)
  assert.match(runtime, /select: selectRequirementsGate/)
  assert.match(runtime, /select: selectManualRecoveryGate/)
  assert.match(runtime, /select: selectBudgetGate/)
  assert.match(budget, /'确认增加额度'/)
  assert.match(budget, /'确认结束本轮'/)
  assert.match(budget, /text: question.detail/)
  assert.doesNotMatch(budget, /h\('(input|textarea)'|contentEditable|createPortal|fetch\(/)
  assert.match(recovery, /'人工结束本轮'/)
  assert.match(recovery, /'保持阻塞'/)
  assert.match(recovery, /'核实陈述与处置范围'/)
  assert.doesNotMatch(recovery, /h\('(input|textarea)'|contentEditable|createPortal|fetch\(/)
  assert.match(runtime, /priority: -10/)
  assert.match(runtime, /ctx\.slots\.inject\('conversation\.view'/)
  assert.match(runtime, /bindWorkflowView\(ctx\.sessions\.list/)
  assert.match(runtime, /WorkflowStatus, \{ projection, placement: 'header' \}/)
  assert.doesNotMatch(runtime, /createPortal|name: 'conversation\.input\.dock'|name: 'details'|name: 'conversation'/)
  assert.match(surface, /@deepseek-ai\/dsh-client-ui-primitives/)
  assert.match(surface, /'data-placement': placement/)
  assert.match(surface, /wfr-orientation/)
  assert.match(surface, /'现在'/)
  assert.match(surface, /'接下来'/)
  assert.match(surface, /'需要你'/)
  assert.doesNotMatch(surface, /h\('(input|textarea)'|contentEditable|setInterval/)
  assert.match(requirements, /'需求理解'/)
  assert.match(requirements, /'只读规划'/)
  assert.match(requirements, /'确认理解并开始只读规划'/)
  assert.match(requirements, /'返回对话修改'/)
  assert.doesNotMatch(requirements, /h\('(input|textarea)'|contentEditable|createPortal/)
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|linear-gradient|radial-gradient|position:fixed|z-index:10000/i)
  assert.match(styles, /--dsh-chat-content-width/)
  assert.match(styles, /--dsw-font-family/)
  assert.match(styles, /\[data-placement=header\]\[data-tone=rollback\]/)
})

test('the built browser bundle contains no Node builtin imports', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /(?:require\(|\bfrom\s*)["']node:/u)
})
