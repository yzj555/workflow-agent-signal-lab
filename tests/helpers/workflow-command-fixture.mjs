/** Controlled provider fixture only: no OS subprocess is created by this helper. */
export function completedCommandHandle() {
  return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {},
    terminate() {}, waitForExit: async () => true }
}

export async function executeCheck(controller, agent, args, result, overrides = {}) {
  const exec = { agent, arguments: args, name: 'pwsh', signal: new AbortController().signal }
  const native = await controller.executeNativeTool(agent, 'pwsh', args, async () => {
    controller.commands.spawn({ spawn: () => overrides.handle ?? completedCommandHandle() }, {})
    if (overrides.dispatch) return overrides.dispatch(exec)
    return result
  }, exec)
  await controller.observeNativeTool(agent, 'pwsh', args, native)
  return native
}
