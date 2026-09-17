export function childClock() {
  let now = 0, nextId = 0
  const timers = new Map()
  return {
    now: () => now,
    set(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id },
    clear(id) { timers.delete(id) },
    advance(ms) {
      const end = now + ms
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].callback()
      }
      now = end
    },
    count: () => timers.size,
  }
}
export const childConfig = {
  childAdmissionMs: 1000, childNoProgressMs: 2000, childMaxRunMs: 5000,
  childReportGraceMs: 1000, childCancelGraceMs: 1000,
}
export async function flushChild() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
}
