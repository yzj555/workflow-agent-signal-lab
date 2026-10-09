import { WORKFLOW_SESSION_EVENT_TYPE } from '../../lib/index.js'
import { parseWorkflowJournalRecord } from '../../lib/workflow-journal.js'

// Valid legacy history without fabricating thousands of Agents or file writes.
// Each pair completes one root-recovery observation before any workflow exists.
export function ingressHistory(rootSessionId, count, reason = 'isolated capacity boundary') {
  if (count % 2) throw new Error('fixture requires complete recovery pairs')
  const events = []
  for (let seq = 0; seq < count; seq += 2) {
    const incidentId = `capacity-incident-${seq}`
    for (const [name, payload] of [
      ['runtime/stall-detected', { incidentId, turn: 1, stage: 'requirements', noProgressMs: 180000,
        journalRevision: seq, attempt: 1, disposition: 'auto-continue', reason, preserved: ['original request'], resumeFrom: 'requirements' }],
      ['runtime/recovery-settled', { incidentId, outcome: 'resumed', summary: 'settled' }],
    ]) events.push({ type: WORKFLOW_SESSION_EVENT_TYPE, seq: events.length, time: 1,
      data: { version: 1, runId: '@workflow-ingress', eventId: `capacity-event-${events.length}`, name,
        actor: { kind: 'system', id: 'fixture-host' }, payload } })
  }
  return { schemaVersion: 1, rootSessionId, revision: events.length, events }
}

// Test-only legacy seeding, never a production mutation API. Real commits are
// used for the transition under test; old records remain complete and ordered.
export function padHistory(table, rootId, minimumEvents) {
  const current = table.get(rootId)
  const count = Math.max(0, Math.ceil((minimumEvents - current.revision) / 2) * 2)
  const prefix = ingressHistory(rootId, count)
  const record = { ...current, revision: current.revision + count,
    events: [...prefix.events, ...current.events.map(item => ({ ...item, seq: item.seq + count }))] }
  table.rows.set(rootId, parseWorkflowJournalRecord(record))
  return record.revision
}

export function recoveryPair(snapshot) {
  const incidentId = `capacity-crossing-${snapshot.revision}`
  const event = (name, payload, suffix) => ({ version: 1, runId: snapshot.run?.runId ?? '@workflow-ingress',
    eventId: `${incidentId}-${suffix}`, name, actor: { kind: 'system', id: 'fixture-host' }, payload })
  return [event('runtime/stall-detected', { incidentId, turn: 1, stage: snapshot.run?.stage ?? 'requirements',
    noProgressMs: 180000, journalRevision: snapshot.revision, attempt: 1, disposition: 'auto-continue',
    reason: 'isolated threshold transition', preserved: ['original request'], resumeFrom: 'same stage' }, 'start'),
  event('runtime/recovery-settled', { incidentId, outcome: 'resumed', summary: 'settled' }, 'settle')]
}

export async function fillJournalBytes(journal, rootId, target = 14 * 1024 * 1024 - 65536) {
  // Inspect the private table only for exact fixture sizing. ALL changes below
  // use the normal durable Journal path; no policy override or production row.
  const size = () => Buffer.byteLength(JSON.stringify(journal.table.get(rootId) ?? {}), 'utf8')
  while (size() < target - 2048) {
    const snapshot = journal.readSnapshot(rootId), events = recoveryPair(snapshot)
    events[0].payload.reason = 'x'.repeat(Math.min(380 * 1024, target - size() - 2048))
    await journal.commit({ rootSessionId: rootId, expectedRevision: snapshot.revision, events })
  }
  return size()
}
