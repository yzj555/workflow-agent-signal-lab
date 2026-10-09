import { WORKFLOW_SESSION_EVENT_TYPE } from './workflow-contract.ts'
import {
  WORKFLOW_INGRESS_RUN_ID,
  applyWorkflowStoredEvent,
  emptyWorkflowRunState,
  parseWorkflowEventData,
} from './workflow-events.ts'
import type {
  WorkflowEventData,
  WorkflowRunState,
  WorkflowRuntimeRecoveryState,
  WorkflowStoredEvent,
} from './workflow-events.ts'
import { workflowSnapshotSchema } from './workflow-view.ts'
import type { WorkflowSnapshot } from './workflow-view.ts'
import { projectWorkflowRun } from './workflow-run-projection.ts'
import { emptyRunBudget, runBudgetLimitsSchema, runBudgetsSchema, RunBudgetExceeded,
  mutableBudget, CONTROL_REQUESTS_PER_GRANT, CLOSED_RUN_HANDOFF_REQUESTS, budgetRecoveryInputSchema, DEFAULT_BUDGET_TOPUP,
  RUN_TIME_SLICE_MS, timeUsed } from './workflow-run-budget.ts'
import type { BudgetRequest, RunBudgetAccount, RunBudgetLimits, RunBudgetResource, RunBudgets } from './workflow-run-budget.ts'
import { assertBudgetAction } from './workflow-budget-recovery.ts'
import { capacitySettlement, journalCapacity, JOURNAL_CAPACITY_MESSAGE,
  JOURNAL_HARD_EVENTS, JOURNAL_HARD_BYTES, JOURNAL_BATCH_EVENTS, JOURNAL_BATCH_BYTES } from './workflow-journal-capacity.ts'

export { workflowSnapshotSchema } from './workflow-view.ts'
export type { WorkflowSnapshot } from './workflow-view.ts'

/** A single KV row is the atomic boundary: no separate head/index/snapshot writes. */
export interface WorkflowJournalRecord {
  readonly schemaVersion: 1
  readonly rootSessionId: string
  readonly revision: number
  readonly events: readonly WorkflowStoredEvent[]
  /** Operational accounting has its own revision; it cannot invalidate a gate. */
  readonly budgets?: RunBudgets
}

export interface WorkflowJournalTable {
  get(key: string): WorkflowJournalRecord | undefined
  entries(): IterableIterator<[string, WorkflowJournalRecord]>
  put(key: string, value: WorkflowJournalRecord): Promise<void>
}

export interface WorkflowCommit {
  readonly rootSessionId: string
  readonly expectedRevision: number
  readonly events: readonly WorkflowEventData[]
  readonly runBudgetLimits?: RunBudgetLimits
}

export class WorkflowJournalError extends Error {
  override name = 'WorkflowJournalError'
  constructor(readonly code: 'invalid' | 'conflict' | 'closed' | 'recovery-required' | 'limit' | 'capacity', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

const MAX_EVENTS = JOURNAL_HARD_EVENTS
const MAX_RECORD_BYTES = JOURNAL_HARD_BYTES

function invalid(message: string): never { throw new WorkflowJournalError('invalid', message) }

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) invalid(`${label} contains undeclared fields`)
  return result
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f]/u.test(value)) {
    invalid(`${label} must be a non-empty, unpadded id of at most 256 characters`)
  }
  return value
}

function integer(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${label} must be a safe integer >= ${minimum}`)
  return value as number
}

/** Reject lossy JSON (undefined, functions, dates, sparse arrays, cycles) before cloning. */
function cloneJson<T>(value: T): T {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) invalid('journal JSON is too deeply nested')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object') invalid('journal values must be lossless JSON')
    if (seen.has(item)) invalid('journal JSON contains a cycle')
    seen.add(item)
    if (Object.getOwnPropertySymbols(item).length !== 0) invalid('journal JSON cannot contain symbol keys')
    if (Array.isArray(item)) {
      if (Object.getOwnPropertyNames(item).length !== item.length + 1) invalid('journal JSON cannot contain array properties or holes')
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid('journal JSON contains a sparse array or accessor')
        visit(descriptor.value, depth + 1)
      }
    } else {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) invalid('journal JSON must contain plain objects')
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !('value' in descriptor)) invalid('journal JSON cannot contain hidden fields or accessors')
        visit(descriptor.value, depth + 1)
      }
    }
    seen.delete(item)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) {
    throw new WorkflowJournalError('limit', 'journal exceeds the 16 MiB v1 record bound; no history was truncated')
  }
  return JSON.parse(encoded) as T
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}

interface Replay {
  readonly record: WorkflowJournalRecord
  readonly bytes: number
  readonly runs: Map<string, WorkflowRunState>
  readonly activeRunId: string
  readonly preRunRecovery?: WorkflowRuntimeRecoveryState
}

// The official domain validates cold rows before the Journal materializes them.
// Reuse ONLY an exact object that this module fully validated and
// deeply froze; never key by root/revision/content or trust caller-frozen data.
// Weak ownership keeps completed/replaced records collectible.
const validatedReplays = new WeakMap<WorkflowJournalRecord, Replay>()

function validatedBudgets(candidate: unknown, runs: ReadonlyMap<string, WorkflowRunState>, revision: number): RunBudgets | undefined {
  const budgets = candidate === undefined ? undefined : runBudgetsSchema.parse(candidate)
  if (budgets?.accounts.some(account => !runs.has(account.runId))) invalid('budget account belongs to an unknown run')
  for (const account of budgets?.accounts ?? []) {
    if (account.recovery?.closed && !runs.get(account.runId)?.outcome) invalid('closed budget has no terminal workflow record')
    if (account.recovery?.requests.some(item => item.workflowRevision > revision)) invalid('budget request revision is ahead of the journal')
  }
  return budgets
}

/** Operational accounting cannot replace events or change their interpreted state. */
function replayBudgetChange(base: Replay, candidate: RunBudgets): Replay {
  if (!base.record.budgets) invalid('budget change requires an existing account')
  const budgets = validatedBudgets(cloneJson(candidate), base.runs, base.record.revision)!
  // All other own fields, their order and exact immutable values are shared.
  // Derive the canonical UTF-8 byte delta, without rescanning unchanged history.
  const bytes = base.bytes - Buffer.byteLength(JSON.stringify(base.record.budgets), 'utf8')
    + Buffer.byteLength(JSON.stringify(budgets), 'utf8')
  if (bytes > MAX_RECORD_BYTES) throw new WorkflowJournalError('limit', 'journal exceeds the 16 MiB v1 bound')
  const record = freeze({ ...base.record, budgets })
  const result: Replay = { ...base, record, bytes }
  validatedReplays.set(record, result)
  return result
}

function applyPreRunRecovery(current: WorkflowRuntimeRecoveryState | undefined,
  event: WorkflowEventData, seq: number): WorkflowRuntimeRecoveryState | undefined {
  if (event.actor.kind !== 'system') invalid('pre-run root recovery may only be recorded by the Host controller')
  if (event.name === 'runtime/stall-detected') {
    if (event.payload.stage !== 'requirements') invalid('pre-run root recovery must remain in the requirements stage')
    if (event.payload.journalRevision !== seq) invalid('pre-run root stall revision must name the pre-commit Journal revision')
    if (current?.status === 'recovering') {
      if (event.payload.attempt !== current.attempt + 1) invalid('pre-run root recovery attempt is not monotonic')
    } else if (event.payload.attempt !== 1) {
      invalid('a new pre-run root recovery chain must begin at attempt 1')
    }
    if (current?.status === 'needs-attention') {
      invalid('pre-run root recovery needs user attention before another automatic attempt')
    }
    return {
      incidentId: event.payload.incidentId,
      status: event.payload.disposition === 'auto-continue' ? 'recovering' : 'needs-attention',
      attempt: event.payload.attempt,
      turn: event.payload.turn,
      stage: event.payload.stage,
      noProgressMs: event.payload.noProgressMs,
      journalRevision: event.payload.journalRevision,
      reason: event.payload.reason,
      preserved: event.payload.preserved,
      resumeFrom: event.payload.resumeFrom,
    }
  }
  if (event.name !== 'runtime/recovery-settled') invalid('the pre-run Journal lane accepts only root recovery events')
  if (!current || current.incidentId !== event.payload.incidentId) {
    invalid('pre-run root recovery settlement does not match the active incident')
  }
  return event.payload.outcome === 'resumed' ? undefined : { ...current, status: 'needs-attention' }
}

function replay(candidate: unknown): Replay {
  if (candidate !== null && typeof candidate === 'object') {
    const known = validatedReplays.get(candidate as WorkflowJournalRecord)
    if (known) return known
  }
  const raw = object(cloneJson(candidate), ['schemaVersion', 'rootSessionId', 'revision', 'events', 'budgets'], 'journal record')
  if (raw.schemaVersion !== 1) invalid('unsupported journal schemaVersion')
  const rootSessionId = identifier(raw.rootSessionId, 'rootSessionId')
  const revision = integer(raw.revision, 1, 'revision')
  if (!Array.isArray(raw.events) || raw.events.length !== revision) invalid('journal revision must equal its event count')
  if (revision > MAX_EVENTS) throw new WorkflowJournalError('limit', 'journal exceeds the 10000-event v1 bound')
  const runs = new Map<string, WorkflowRunState>()
  const events: WorkflowStoredEvent[] = []
  let activeRunId = ''
  let preRunRecovery: WorkflowRuntimeRecoveryState | undefined
  const preRunEventIds = new Set<string>()
  let lastTime = 0
  for (const [index, candidateEvent] of raw.events.entries()) {
    const event = object(candidateEvent, ['type', 'seq', 'time', 'data'], `event ${index}`)
    if (event.type !== WORKFLOW_SESSION_EVENT_TYPE || event.seq !== index) invalid('journal event type or contiguous seq is invalid')
    const time = integer(event.time, lastTime, 'event time')
    const data = parseWorkflowEventData(event.data)
    identifier(data.runId, 'runId')
    if (data.runId === WORKFLOW_INGRESS_RUN_ID) {
      if (data.name !== 'runtime/stall-detected' && data.name !== 'runtime/recovery-settled') {
        invalid('the reserved pre-run Journal lane accepts only root recovery events')
      }
      if (preRunEventIds.has(data.eventId)) invalid('pre-run root recovery event ids must be unique')
      if (data.name === 'runtime/stall-detected' && activeRunId !== '' && preRunRecovery === undefined) {
        invalid('a pre-run recovery chain cannot start after a workflow run exists')
      }
      preRunRecovery = applyPreRunRecovery(preRunRecovery, data, index)
      preRunEventIds.add(data.eventId)
      events.push({ type: WORKFLOW_SESSION_EVENT_TYPE, seq: index, time, data })
      lastTime = time
      continue
    }
    if (data.name === 'run/created') {
      if (data.payload.rootSessionId !== rootSessionId) invalid('run creation belongs to another root Session')
      if (runs.has(data.runId)) invalid('runId cannot be reused within a root Session')
      if (activeRunId !== '' && runs.get(activeRunId)?.outcome === undefined) invalid('a root Session cannot start another run while its current run is unfinished')
      const rollback = runs.get(activeRunId)?.rollbackTransaction
      if (rollback && rollback.phase !== 'cleaned') invalid('unfinished file rollback must be resolved before creating another run')
      runs.set(data.runId, emptyWorkflowRunState(data.runId))
      activeRunId = data.runId
    }
    if (data.runId !== activeRunId || !runs.has(data.runId)) invalid('events may only target the current explicitly created run')
    const stored: WorkflowStoredEvent = { type: WORKFLOW_SESSION_EVENT_TYPE, seq: index, time, data }
    runs.set(data.runId, applyWorkflowStoredEvent(runs.get(data.runId)!, stored))
    events.push(stored)
    lastTime = time
  }
  const budgets = validatedBudgets(raw.budgets, runs, revision)
  const record = freeze({ schemaVersion: 1 as const, rootSessionId, revision, events, ...(budgets ? { budgets } : {}) })
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
  if (bytes > MAX_RECORD_BYTES) throw new WorkflowJournalError('limit', 'journal exceeds the 16 MiB v1 bound')
  const result: Replay = {
    record,
    bytes,
    runs,
    activeRunId,
    ...(preRunRecovery === undefined ? {} : { preRunRecovery }),
  }
  // Register after every semantic, size and budget check has succeeded. The
  // mutable input was cloned; only our detached frozen output gains this proof.
  validatedReplays.set(record, result)
  return result
}

/** Semantic validation at the official storage-domain cold-read boundary. */
export function parseWorkflowJournalRecord(candidate: unknown): WorkflowJournalRecord {
  return replay(candidate).record
}

/** Host-internal writer; not a Remote, model tool, or chat-driven parser. */
export class WorkflowJournal {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly cache = new WeakMap<WorkflowJournalRecord, Replay>()
  private readonly listeners = new Set<(snapshot: WorkflowSnapshot) => void | Promise<void>>()
  private readonly faultListeners = new Set<() => void | Promise<void>>()
  private accepting = true
  private closed = false
  private fault: unknown
  private faultKind?: 'storage-write' | 'time-accounting'
  private disposal?: Promise<void>

  constructor(private readonly table: WorkflowJournalTable, private readonly clock: () => number = Date.now,
    private readonly reportObserverError: (error: unknown) => void = () => {}) {
    for (const [key, value] of table.entries()) {
      if (key !== value.rootSessionId) invalid('journal row key disagrees with its root Session')
      this.materialize(value)
    }
  }

  private assertReadable(): void {
    if (this.closed) throw new WorkflowJournalError('closed', 'workflow journal is closed')
    if (this.fault !== undefined) throw new WorkflowJournalError('recovery-required', 'workflow storage failed; reopen and verify before advancing', { cause: this.fault })
  }

  /** Available even when the store cannot safely be replayed; contains no raw exception. */
  readFault(): { readonly kind: 'storage-write' | 'time-accounting' } | undefined {
    return this.faultKind ? { kind: this.faultKind } : undefined
  }

  onFault(listener: () => void | Promise<void>): () => void {
    if (this.closed) throw new WorkflowJournalError('closed', 'workflow journal is closed')
    this.faultListeners.add(listener)
    if (this.faultKind) this.notifyFault(listener)
    return () => { this.faultListeners.delete(listener) }
  }

  private notifyFault(listener: () => void | Promise<void>): void {
    try { Promise.resolve(listener()).catch(error => this.observerFailed(error)) }
    catch (error) { this.observerFailed(error) }
  }

  private fail(error: unknown, kind: 'storage-write' | 'time-accounting'): void {
    if (this.faultKind) return
    // Seal BEFORE notifying: cancellation callbacks cannot sneak in a write.
    this.fault = error ?? new Error('unknown storage failure')
    this.faultKind = kind
    for (const listener of this.faultListeners) this.notifyFault(listener)
  }

  private materialize(record: WorkflowJournalRecord): Replay {
    let cached = this.cache.get(record)
    if (cached === undefined) {
      cached = replay(record)
      this.cache.set(record, cached)
    }
    return cached
  }

  /** Also applies to old/unmetered runs and requirement ingress. Reads remain available. */
  assertExecutionCapacity(rootSessionId: string): void {
    this.assertReadable()
    const record = this.table.get(identifier(rootSessionId, 'rootSessionId'))
    if (record && journalCapacity(record.revision, this.materialize(record).bytes)) {
      throw new WorkflowJournalError('capacity', JOURNAL_CAPACITY_MESSAGE)
    }
  }

  readSnapshot(rootSessionId: string): WorkflowSnapshot {
    this.assertReadable()
    identifier(rootSessionId, 'rootSessionId')
    const record = this.table.get(rootSessionId)
    if (record === undefined) return {
      schemaVersion: 1, source: 'plugin-journal', rootSessionId,
      revision: 0, availability: 'absent', run: null, history: [], preRunRecovery: null,
    }
    if (record.rootSessionId !== rootSessionId) invalid('journal row binding is invalid')
    const { runs, activeRunId, preRunRecovery, bytes } = this.materialize(record)
    const capacity = journalCapacity(record.revision, bytes)
    const history = [...runs.values()].map(run => ({
      runId: run.runId,
      title: run.created!.title,
      outcome: run.outcome?.outcome ?? null,
    }))
    if (activeRunId === '') return workflowSnapshotSchema.parse({
      schemaVersion: 1, source: 'plugin-journal', rootSessionId, revision: record.revision,
      availability: 'absent', run: null, history,
      ...(capacity ? { capacity } : {}),
      preRunRecovery: preRunRecovery ?? null,
    })
    const projected = projectWorkflowRun(runs.get(activeRunId)!)
    const budget = record.budgets?.accounts.find(account => account.runId === activeRunId)
    return workflowSnapshotSchema.parse({
      schemaVersion: 1, source: 'plugin-journal', rootSessionId, revision: record.revision,
      availability: 'ready', run: {
        ...projected,
        ...(budget ? { budget, needsUser: projected.needsUser || ((budget.blocked !== null || budget.recovery?.awaitingResume) && !budget.recovery?.closed && !projected.manualClose) } : {}),
        ...(capacity ? { needsUser: true } : {}),
      },
      ...(capacity ? { capacity } : {}),
      ...(record.budgets ? { budgetRevision: record.budgets.revision } : {}),
      history,
      preRunRecovery: preRunRecovery ?? null,
    })
  }

  /** Internal, defensive state copy for a future trusted Controller. */
  readRunState(rootSessionId: string, runId: string): WorkflowRunState {
    this.assertReadable()
    const record = this.table.get(identifier(rootSessionId, 'rootSessionId'))
    const state = record === undefined ? undefined : this.materialize(record).runs.get(runId)
    if (state === undefined) invalid('requested workflow run does not exist in this root Session')
    return structuredClone(state)
  }

  /** Trusted, read-only materialization used for scoped learning retrieval. */
  readAllRunStates(): WorkflowRunState[] {
    this.assertReadable()
    const states: WorkflowRunState[] = []
    for (const [rootSessionId, record] of this.table.entries()) {
      if (record.rootSessionId !== rootSessionId) invalid('journal row binding is invalid')
      for (const state of this.materialize(record).runs.values()) states.push(structuredClone(state))
    }
    return states
  }

  subscribe(listener: (snapshot: WorkflowSnapshot) => void | Promise<void>): () => void {
    this.assertReadable()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readRunBudget(rootSessionId: string, runId: string): RunBudgetAccount | undefined {
    this.assertReadable()
    const record = this.table.get(identifier(rootSessionId, 'rootSessionId'))
    if (!record || !this.materialize(record).runs.has(runId)) invalid('budget run does not exist')
    const account = record.budgets?.accounts.find(item => item.runId === runId)
    return account ? structuredClone(account) : undefined
  }

  /** One durable admission per call; serialized WITH commits, not alongside them. */
  consumeRunBudget(rootSessionId: string, runId: string, resource: RunBudgetResource): Promise<void> {
    try {
      this.assertReadable()
      if (!this.accepting) throw new WorkflowJournalError('closed', 'workflow journal is draining')
      identifier(rootSessionId, 'rootSessionId')
      identifier(runId, 'runId')
      if (!['root-model', 'child-model', 'command'].includes(resource)) invalid('invalid budget resource')
      const previous = this.queues.get(rootSessionId) ?? Promise.resolve()
      const result = previous.then(async () => {
        this.assertReadable()
        const current = this.table.get(rootSessionId)
        if (!current || this.materialize(current).activeRunId !== runId) invalid('budget admission requires the current run')
        this.assertExecutionCapacity(rootSessionId)
        const account = current.budgets?.accounts.find(item => item.runId === runId)
        // Historical runs are left unmodified and explicitly unmetered. No
        // invented usage or retroactive claim that an old call was protected.
        if (!account) return
        if (account.blocked || account.recovery?.awaitingResume) throw new RunBudgetExceeded()
        const exhausted = resource === 'command' ? account.used.commands >= account.limits.commands
          : account.used.rootModel + account.used.childModel >= account.limits.modelRequests
        const updated = mutableBudget(account)
        if (exhausted) { updated.blocked = { resource, recordedAt: integer(this.clock(), 0, 'clock') }; updated.recovery.blocks++ }
        else if (resource === 'command') updated.used.commands++
        else if (resource === 'root-model') updated.used.rootModel++
        else updated.used.childModel++
        const next = replayBudgetChange(this.materialize(current), {
          revision: current.budgets!.revision + 1,
          accounts: current.budgets!.accounts.map(item => item.runId === runId ? updated : item),
        })
        await this.persist(rootSessionId, next)
        if (exhausted) throw new RunBudgetExceeded()
      })
      const settled = result.then(() => {}, () => {})
      this.queues.set(rootSessionId, settled)
      void settled.then(() => { if (this.queues.get(rootSessionId) === settled) this.queues.delete(rootSessionId) })
      return result
    } catch (error) { return Promise.reject(error) }
  }

  /** Accounting and any terminal workflow events share ONE serialized durable put. */
  private changeBudget(rootSessionId: string, runId: string, expectedRevision: number | undefined,
    change: (account: ReturnType<typeof mutableBudget>, state: WorkflowRunState) => readonly WorkflowEventData[],
    settlementOnly = false): Promise<WorkflowSnapshot> {
    try {
      this.assertReadable()
      if (!this.accepting) throw new WorkflowJournalError('closed', 'workflow journal is draining')
      identifier(rootSessionId, 'rootSessionId'); identifier(runId, 'runId')
      const previous = this.queues.get(rootSessionId) ?? Promise.resolve()
      const result = previous.then(async () => {
        this.assertReadable()
        const current = this.table.get(rootSessionId)
        if (!current || this.materialize(current).activeRunId !== runId) invalid('budget change requires the current run')
        if (!settlementOnly) this.assertExecutionCapacity(rootSessionId)
        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
          throw new WorkflowJournalError('conflict', 'budget decision refers to a stale workflow revision')
        }
        const old = current.budgets?.accounts.find(item => item.runId === runId)
        if (!old) invalid('legacy unmetered run has no budget to change')
        const account = mutableBudget(old)
        const data = change(account, structuredClone(this.materialize(current).runs.get(runId)!)).map(item => parseWorkflowEventData(item))
        const time = Math.max(current.events.at(-1)!.time, integer(this.clock(), 0, 'clock'))
        const events = data.map((event, offset): WorkflowStoredEvent => ({
          type: WORKFLOW_SESSION_EVENT_TYPE, seq: current.revision + offset, time, data: event,
        }))
        const budgets = { revision: current.budgets!.revision + 1
            + account.recovery.blocks - (old.recovery?.blocks ?? (old.blocked ? 1 : 0)),
            accounts: current.budgets!.accounts.map(item => item.runId === runId ? account : item) }
        const next = events.length ? replay({ ...current, revision: current.revision + events.length,
          events: [...current.events, ...events], budgets }) : replayBudgetChange(this.materialize(current), budgets)
        return this.persist(rootSessionId, next)
      })
      const settled = result.then(() => {}, () => {})
      this.queues.set(rootSessionId, settled)
      void settled.then(() => { if (this.queues.get(rootSessionId) === settled) this.queues.delete(rootSessionId) })
      return result
    } catch (error) { return Promise.reject(error) }
  }

  /** Host-only monotonic-clock evidence. Reserve short intervals before work. */
  updateRunTime(rootSessionId: string, runId: string, ownerId: string,
    input: { elapsedMs: number; reserveMs: number; release?: boolean; overrunMs?: number }): Promise<WorkflowSnapshot> {
    identifier(ownerId, 'time owner')
    const elapsed = integer(input.elapsedMs, 0, 'elapsedMs'), reserve = integer(input.reserveMs, 0, 'reserveMs')
    const overrun = integer(input.overrunMs ?? 0, 0, 'overrunMs')
    if (reserve > RUN_TIME_SLICE_MS || (input.release && reserve)) invalid('invalid time reservation')
    return this.changeBudget(rootSessionId, runId, undefined, account => {
      const time = account.time
      if (!time || account.limits.activeMs === undefined) invalid('run has no frozen time budget')
      if (time.reservedMs && time.ownerId !== ownerId) invalid('another Host owns unaccounted time; recover before admission')
      if (elapsed > time.reservedMs) invalid('elapsed time exceeds its durable reservation')
      time.observedMs += elapsed
      time.reservedMs -= elapsed
      time.overrunMs += overrun
      if (input.release) { time.reservedMs = 0; time.ownerId = null }
      else {
        const room = account.limits.activeMs - timeUsed(time) - time.reservedMs
        const addition = account.blocked || account.recovery.awaitingResume || account.recovery.closed ? 0 : Math.min(reserve, room)
        time.reservedMs += addition
        time.ownerId = time.reservedMs ? ownerId : null
      }
      time.revision++
      if (!account.blocked && timeUsed(time) === account.limits.activeMs) {
        account.blocked = { resource: 'active-time', recordedAt: integer(this.clock(), 0, 'clock') }
        account.recovery.blocks++
      }
      return []
    }, reserve === 0)
  }

  /** Never count Host downtime. Only the previously granted unclosed slice is uncertain. */
  recoverRunTime(rootSessionId: string, runId: string, newOwner: string): Promise<WorkflowSnapshot> {
    identifier(newOwner, 'time owner')
    return this.changeBudget(rootSessionId, runId, undefined, account => {
      const time = account.time
      if (!time || !time.reservedMs || time.ownerId === newOwner) invalid('no old time reservation to recover')
      time.uncertainMs += time.reservedMs
      time.reservedMs = 0; time.ownerId = null; time.revision++
      if (!account.blocked && timeUsed(time) === account.limits.activeMs) {
        account.blocked = { resource: 'active-time', recordedAt: integer(this.clock(), 0, 'clock') }
        account.recovery.blocks++
      }
      return []
    }, true)
  }

  /** A missed durable renewal is a storage safety failure, NOT budget exhaustion. */
  sealTimeAccounting(error: Error): void { this.fail(error, 'time-accounting') }

  consumeBudgetControl(rootSessionId: string, runId: string): Promise<WorkflowSnapshot> {
    return this.changeBudget(rootSessionId, runId, undefined, account => {
      const grants = account.recovery.requests.filter(item => item.action === 'topup' && item.status === 'approved').length
      if (!account.blocked || account.recovery.controlUsed >= CONTROL_REQUESTS_PER_GRANT * (1 + grants)
        + (account.recovery.closed ? CLOSED_RUN_HANDOFF_REQUESTS : 0)) {
        throw new Error(account.recovery.closed ? '本轮已结束且交接额度已用尽；请新开原生会话并重新确认任务，历史不删除'
          : '本轮核对对话额度已用尽或已离开预算阻塞；请用原生命令 /workflow-budget，无需调用模型')
      }
      account.recovery.controlUsed++
      return []
    })
  }

  /** Called only after observing a fresh native user turn, never from model parameters. */
  resumeBudgetExecution(rootSessionId: string, runId: string): Promise<WorkflowSnapshot> {
    return this.changeBudget(rootSessionId, runId, undefined, account => {
      if (!account.recovery.awaitingResume || account.blocked || account.recovery.closed) invalid('budget is not awaiting a fresh user turn')
      account.recovery.awaitingResume = false
      account.recovery.resumes++
      return []
    })
  }

  requestBudgetRecovery(rootSessionId: string, runId: string, id: string, input: unknown): Promise<WorkflowSnapshot> {
    const parsed = budgetRecoveryInputSchema.parse(input)
    identifier(id, 'budget request id')
    return this.changeBudget(rootSessionId, runId, parsed.expectedRevision, (account, state) => {
      assertBudgetAction(state, account, parsed.action)
      if (account.recovery.requests.some(item => item.status === 'pending')) invalid('a native budget decision is already pending')
      const add = parsed.action === 'end' ? { modelRequests: 0, commands: 0 } : parsed.add
        ?? { ...DEFAULT_BUDGET_TOPUP, ...(account.time ? { activeMs: 600_000 } : {}) }
      if (parsed.action === 'topup') {
        const blockedAdded = account.blocked!.resource === 'active-time' ? add.activeMs ?? 0
          : account.blocked!.resource === 'command' ? add.commands : add.modelRequests
        if (blockedAdded <= 0) invalid('topup must increase the exhausted resource')
        if (add.activeMs !== undefined && !account.time) invalid('cannot fabricate a time account on an existing run')
        runBudgetLimitsSchema.parse({ modelRequests: account.limits.modelRequests + add.modelRequests, commands: account.limits.commands + add.commands,
          ...(account.limits.activeMs === undefined ? {} : { activeMs: account.limits.activeMs + (add.activeMs ?? 0) }) })
      }
      account.recovery.requests.push({ id, action: parsed.action, block: account.recovery.blocks,
        workflowRevision: parsed.expectedRevision, createdAt: integer(this.clock(), 0, 'clock'), reason: parsed.reason,
        before: { ...account.limits }, add, status: 'pending' })
      return []
    })
  }

  settleBudgetRecovery(rootSessionId: string, runId: string, id: string,
    decision: 'approved' | 'rejected' | 'cancelled', events: readonly WorkflowEventData[] = []): Promise<WorkflowSnapshot> {
    return this.changeBudget(rootSessionId, runId, undefined, (account, state) => {
      const request = account.recovery.requests.find(item => item.id === id)
      if (!request || request.status !== 'pending') invalid('budget answer has no matching pending request')
      if (!['approved', 'rejected', 'cancelled'].includes(decision)) invalid('invalid budget decision')
      if (decision !== 'cancelled') {
        const current = this.table.get(rootSessionId)!
        if (request.workflowRevision !== current.revision) throw new WorkflowJournalError('conflict', 'budget decision refers to a stale workflow revision')
      }
      if (decision === 'approved') {
        assertBudgetAction(state, account, request.action)
        if (request.action === 'topup') {
          account.limits.modelRequests += request.add.modelRequests
          account.limits.commands += request.add.commands
          if (account.limits.activeMs !== undefined) account.limits.activeMs += request.add.activeMs ?? 0
          account.blocked = null
          account.recovery.awaitingResume = true
        } else {
          if (!state.outcome && !events.some(item => item.name === 'outcome/declared' && item.payload.outcome === 'CANCELLED')) {
            invalid('ending budget must atomically settle the unfinished workflow')
          }
          account.recovery.closed = true
        }
      }
      if (events.length && (decision !== 'approved' || request.action !== 'end' || state.outcome)) invalid('only budget end may append terminal workflow events')
      request.status = decision
      request.settledAt = Math.max(request.createdAt, integer(this.clock(), 0, 'clock'))
      if (decision !== 'cancelled') request.decisionAudit = { authority: 'user', channel: 'native-question', operator: 'unverified', requestId: id }
      return events
    }, decision !== 'approved')
  }

  private async persist(rootSessionId: string, next: Replay): Promise<WorkflowSnapshot> {
    try { await this.table.put(rootSessionId, next.record) }
    catch (error) {
      this.fail(error, 'storage-write')
      throw new WorkflowJournalError('recovery-required', 'journal commit failed; reopen storage before retrying', { cause: error })
    }
    this.cache.set(next.record, next)
    const snapshot = this.readSnapshot(rootSessionId)
    for (const listener of this.listeners) {
      try { Promise.resolve(listener(structuredClone(snapshot))).catch(error => this.observerFailed(error)) }
      catch (error) { this.observerFailed(error) }
    }
    return snapshot
  }

  commit(candidate: WorkflowCommit): Promise<WorkflowSnapshot> {
    try {
      this.assertReadable()
      if (!this.accepting) throw new WorkflowJournalError('closed', 'workflow journal is draining')
      const raw = object(cloneJson(candidate), ['rootSessionId', 'expectedRevision', 'events', 'runBudgetLimits'], 'commit')
      const rootSessionId = identifier(raw.rootSessionId, 'rootSessionId')
      const expectedRevision = integer(raw.expectedRevision, 0, 'expectedRevision')
      if (!Array.isArray(raw.events) || raw.events.length === 0) invalid('commit requires at least one event')
      if (raw.events.length > JOURNAL_BATCH_EVENTS || Buffer.byteLength(JSON.stringify(raw), 'utf8') > JOURNAL_BATCH_BYTES) {
        throw new WorkflowJournalError('limit', '单次日志提交过大；请缩小本次操作，历史没有截断，也未放行新执行')
      }
      const data = raw.events.map(event => parseWorkflowEventData(event))
      const limits = raw.runBudgetLimits === undefined ? undefined : runBudgetLimitsSchema.parse(raw.runBudgetLimits)
      const creations = data.filter(event => event.name === 'run/created')
      if (limits && creations.length !== 1) invalid('frozen budget must be attached to exactly one new run')
      const previous = this.queues.get(rootSessionId) ?? Promise.resolve()
      const result = previous.then(async () => {
        this.assertReadable()
        const current = this.table.get(rootSessionId)
        const actual = current?.revision ?? 0
        if (actual !== expectedRevision) throw new WorkflowJournalError('conflict', `expected journal revision ${expectedRevision}, actual ${actual}`)
        if (!data.every(capacitySettlement)) this.assertExecutionCapacity(rootSessionId)
        let time = current?.events.at(-1)?.time ?? 0
        const additions = data.map((event, offset): WorkflowStoredEvent => {
          time = Math.max(time, integer(this.clock(), 0, 'clock'))
          return { type: WORKFLOW_SESSION_EVENT_TYPE, seq: actual + offset, time, data: event }
        })
        const budgets = limits ? { revision: (current?.budgets?.revision ?? 0) + 1,
          accounts: [...(current?.budgets?.accounts ?? []), emptyRunBudget(creations[0]!.runId, limits)] } : current?.budgets
        const next = replay({ schemaVersion: 1, rootSessionId, revision: actual + data.length,
          events: [...(current?.events ?? []), ...additions], ...(budgets ? { budgets } : {}) })
        return this.persist(rootSessionId, next)
      })
      const settled = result.then(() => {}, () => {})
      this.queues.set(rootSessionId, settled)
      void settled.then(() => { if (this.queues.get(rootSessionId) === settled) this.queues.delete(rootSessionId) })
      return result
    } catch (error) { return Promise.reject(error) }
  }

  private observerFailed(error: unknown): void {
    try { this.reportObserverError(error) } catch { /* Observer reporting cannot undo a committed write. */ }
  }

  close(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.accepting = false
    this.disposal = Promise.all([...this.queues.values()]).then(() => {
      this.closed = true
      this.listeners.clear()
      this.faultListeners.clear()
    })
    return this.disposal
  }
}
