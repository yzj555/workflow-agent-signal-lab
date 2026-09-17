export const WORKFLOW_VIEW_ID = 'workflow-agent-runtime'
export const WORKFLOW_PRESET_ID = 'workflow-agent-signal-lab'

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

/** Add a native view only for the selected preset; never replace a shipped slot. */
export function bindWorkflowView(source: SelectionSource, register: () => () => void): () => void {
  let release: (() => void) | undefined
  let disposed = false
  const sync = () => {
    if (disposed) return
    const snapshot = source.getSnapshot()
    const preset = snapshot.current === undefined
      ? undefined
      : snapshot.byId[snapshot.current]?.projectionValues?.agentPreset
    const enabled = snapshot.current !== undefined
      && preset === WORKFLOW_PRESET_ID
    if (enabled && release === undefined) release = register()
    else if (!enabled && release !== undefined) {
      const previous = release
      release = undefined
      previous()
    }
  }
  const unsubscribe = source.subscribe(sync)
  try { sync() } catch (error) { unsubscribe(); throw error }
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    release?.()
    release = undefined
  }
}
