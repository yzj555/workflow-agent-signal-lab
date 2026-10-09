export const WORKFLOW_VIEW_ID = 'workflow-agent-runtime'
export const WORKFLOW_PRESET_ID = 'workflow-agent-signal-lab'

interface NativeSubagentState {
  running?: boolean | undefined
  activity?: string | undefined
  mode?: string | undefined
  lastTurnCompleted?: boolean | undefined
  openTurn?: boolean | undefined
}

/** Catalog discovery or absence of live activity is not completion evidence. */
export function nativeSubagentStatus(state: NativeSubagentState): {
  status: string; tone: 'active' | 'done' | 'waiting'
} {
  if (state.running === true || state.activity === 'running') return { status: '运行中', tone: 'active' }
  if (state.running !== false) return { status: '状态未确认', tone: 'waiting' }
  if (state.openTurn) return { status: '上次运行未闭合', tone: 'waiting' }
  if (state.lastTurnCompleted === false) return { status: '已停止（未正常结束）', tone: 'waiting' }
  if (state.mode === 'continuable') return { status: '空闲', tone: 'waiting' }
  if (state.mode === 'one-shot' && state.lastTurnCompleted === true) return { status: '已完成', tone: 'done' }
  return { status: '状态未确认', tone: 'waiting' }
}

interface SelectionSnapshot {
  current?: string | undefined
  byId: Readonly<Record<string, {
    projectionValues?: { agentPreset?: unknown } | undefined
  } | undefined>>
}

interface SelectionSource {
  getSnapshot(): SelectionSnapshot
  subscribe(notify: () => void): () => void
}

/** SDK2 delegates main-view selection to the public UiSession adapter. */
interface MainBindingSource {
  getSnapshot(): { readonly key: unknown }
  subscribe(notify: () => void): () => void
}

/** Add a native view only for the selected preset; never replace a shipped slot. */
export function bindWorkflowView(source: SelectionSource, register: () => () => void, main?: MainBindingSource): () => void {
  let release: (() => void) | undefined
  let disposed = false
  const sync = () => {
    if (disposed) return
    const snapshot = source.getSnapshot()
    const key = main === undefined ? snapshot.current : main.getSnapshot().key
    const current = typeof key === 'string' ? key : undefined
    const preset = current === undefined
      ? undefined
      : snapshot.byId[current]?.projectionValues?.agentPreset
    const enabled = current !== undefined
      && preset === WORKFLOW_PRESET_ID
    if (enabled && release === undefined) release = register()
    else if (!enabled && release !== undefined) {
      const previous = release
      release = undefined
      previous()
    }
  }
  const unsubscribe = source.subscribe(sync)
  let unsubscribeMain = () => {}
  try { unsubscribeMain = main?.subscribe(sync) ?? unsubscribeMain; sync() }
  catch (error) { unsubscribeMain(); unsubscribe(); throw error }
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    unsubscribeMain()
    release?.()
    release = undefined
  }
}
