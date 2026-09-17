/** Run via page.evaluate in an authenticated DSH page. Read-only Remote stream. */
export async function readNativeControlBaseline() {
  return new Promise((resolve, reject) => {
    const streamId = crypto.randomUUID()
    const socket = new WebSocket(`ws://${location.host}/api/remote.mux`)
    const timer = setTimeout(() => { socket.close(); reject(new Error('control baseline timeout')) }, 10000)
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      error ? reject(error) : resolve(value)
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: 'open', streamId,
      endpoint: 'session/control', payload: { args: {} } }))
    socket.onerror = () => finish(new Error('control socket failed'))
    socket.onclose = () => { if (!settled) finish(new Error('control socket closed before baseline')) }
    socket.onmessage = event => {
      let frame
      try { frame = JSON.parse(event.data) } catch (error) { finish(error); return }
      if (frame.streamId !== streamId) return
      if (frame.type === 'error') return finish(new Error(JSON.stringify(frame.error)))
      if (frame.type !== 'item' || frame.value?.type !== 'baseline') return
      const value = frame.value.value
      finish(null, { observedAt: new Date().toISOString(), ids: Object.keys(value.projections),
        queues: Object.fromEntries(Object.entries(value.queues).map(([id, items]) => [id, items.length])),
        jobs: Object.fromEntries(Object.entries(value.jobs).map(([id, jobs]) => [id,
          jobs.map(job => ({ kind: job.kind, status: job.status }))])) })
    }
  })
}

/** Pure classifier; exact native test-child identities are not unrelated work. */
export function classifyInterruptionSafety(native, sessionId) {
  const allowed = new Set([sessionId, ...native.testChildren.filter(item => item.kind === 'child').map(item => item.id)])
  const classified = new Set([...native.rootIds, ...native.knownChildren, ...allowed])
  const resident = native.resident
  return {
    otherRunning: native.otherRunning.filter(id => !allowed.has(id)),
    otherActiveChildren: native.otherActiveChildren,
    residentDiagnostics: native.catalogDiagnostics.filter(item => resident.ids.includes(item.entry.id)),
    unclassifiedResident: resident.ids.filter(id => !classified.has(id)),
    otherQueues: Object.entries(resident.queues).filter(([id, count]) => !allowed.has(id) && count > 0),
    otherJobs: Object.entries(resident.jobs).filter(([id, jobs]) => !allowed.has(id) && jobs.length > 0),
  }
}
