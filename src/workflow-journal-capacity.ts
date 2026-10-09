import { z } from 'zod'
import type { WorkflowEventData } from './workflow-events.ts'

// Keep the existing on-disk hard bounds. Normal execution stops earlier so
// the fixed v1 graph can record cancellation, exit facts and interrupted I/O.
export const JOURNAL_HARD_EVENTS = 10_000
export const JOURNAL_HARD_BYTES = 16 * 1024 * 1024
export const JOURNAL_EXECUTION_EVENTS = 9_000
export const JOURNAL_EXECUTION_BYTES = 14 * 1024 * 1024
export const JOURNAL_BATCH_EVENTS = 128
export const JOURNAL_BATCH_BYTES = 512 * 1024
export const JOURNAL_CAPACITY_MESSAGE = '本会话记录容量已达执行上限，新工作已封闭；保留历史并核对后台退出后，请新建原生会话重新确认需求。不要删除日志或沿用旧授权。'

export const journalCapacitySchema = z.strictObject({
  reason: z.enum(['events', 'bytes']), events: z.int().nonnegative(), bytes: z.int().nonnegative(),
  executionEvents: z.literal(JOURNAL_EXECUTION_EVENTS), executionBytes: z.literal(JOURNAL_EXECUTION_BYTES),
  hardEvents: z.literal(JOURNAL_HARD_EVENTS), hardBytes: z.literal(JOURNAL_HARD_BYTES),
}).superRefine((value, context) => {
  const reason = value.events >= JOURNAL_EXECUTION_EVENTS ? 'events'
    : value.bytes >= JOURNAL_EXECUTION_BYTES ? 'bytes' : undefined
  if (reason !== value.reason || value.events > JOURNAL_HARD_EVENTS || value.bytes > JOURNAL_HARD_BYTES) {
    context.addIssue({ code: 'custom', message: 'journal capacity does not match its durable record bounds' })
  }
})
export type JournalCapacity = z.infer<typeof journalCapacitySchema>

export function journalCapacity(events: number, bytes: number): JournalCapacity | undefined {
  const reason = events >= JOURNAL_EXECUTION_EVENTS ? 'events' : bytes >= JOURNAL_EXECUTION_BYTES ? 'bytes' : undefined
  return reason ? { reason, events, bytes, executionEvents: JOURNAL_EXECUTION_EVENTS, executionBytes: JOURNAL_EXECUTION_BYTES,
    hardEvents: JOURNAL_HARD_EVENTS, hardBytes: JOURNAL_HARD_BYTES } : undefined
}

/** Reserve is only for already-started work and narrowing authority, never new approvals. */
export function capacitySettlement(event: WorkflowEventData): boolean {
  switch (event.name) {
    case 'agent/runtime-interrupted':
    case 'agent/settled':
    case 'command/finished':
    case 'checkpoint/file-observed':
    case 'rollback/interrupted':
    case 'rollback/cleaned':
    case 'runtime/recovery-settled': return event.actor.kind === 'system'
    case 'gate/decided': return event.payload.decision !== 'approved'
    case 'task/status-changed': return event.payload.status === 'cancelled'
    case 'outcome/declared': return event.payload.outcome === 'CANCELLED'
    default: return false
  }
}
