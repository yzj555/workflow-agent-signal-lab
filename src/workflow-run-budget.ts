import { z } from 'zod'

// Request admission counts plus optional active wall time, not provider billing.
// Request attempts are never refunded. Time reservations settle separately into
// observed work, released idle allowance, or conservative restart uncertainty.
export const runBudgetLimitsSchema = z.strictObject({
  modelRequests: z.int().min(1).max(100_000),
  commands: z.int().min(1).max(10_000),
  activeMs: z.int().min(1).max(86_400_000).optional(),
})
export type RunBudgetLimits = z.infer<typeof runBudgetLimitsSchema>
export type RunBudgetResource = 'root-model' | 'child-model' | 'command'
export const DEFAULT_RUN_BUDGET_LIMITS: Readonly<RunBudgetLimits> = Object.freeze({ modelRequests: 240, commands: 40 })
export const DEFAULT_RUN_ACTIVE_MS = 1_800_000
export const RUN_TIME_SLICE_MS = 5_000
/** Host configuration only. Arrays contain exact native ROOT Session IDs. */
export type RunBudgetScope = 'all' | readonly string[]
export interface RunBudgetConfig {
  /** Opt-in until native budget-recovery and full-duration policy are ready. */
  runBudgetEnabled: boolean
  /** Missing/empty scope enrolls no NEW run. Host-wide enrollment requires explicit 'all'. */
  runBudgetScope: RunBudgetScope
  runModelRequests: number
  runCommands: number
  runTimeBudgetEnabled: boolean
  runActiveMs: number
}
export function resolveRunBudgetEnabled(config: Partial<RunBudgetConfig> = {}): boolean {
  return z.boolean().parse(config.runBudgetEnabled ?? false)
}
export function resolveRunBudgetScope(config: Partial<RunBudgetConfig> = {}): RunBudgetScope {
  // Null/malformed values fail startup even when the feature is disabled;
  // never interpret invalid or missing scope as a global enablement.
  // Keep Host-only validation out of the client account-reader bundle.
  const runBudgetScopeSchema = z.union([
    z.literal('all'),
    z.array(z.string().min(1).max(256).refine(id => id === id.trim() && !/[\u0000-\u001f\u007f*?\[\]]/u.test(id),
      'budget scope requires exact, unpadded root Session IDs; patterns are not supported'))
      .max(128).refine(ids => new Set(ids).size === ids.length, 'duplicate root Session IDs in budget scope'),
  ])
  const scope = runBudgetScopeSchema.parse(config.runBudgetScope === undefined ? [] : config.runBudgetScope)
  return scope === 'all' ? scope : Object.freeze(scope)
}
export function resolveRunBudgetLimits(config: Partial<RunBudgetConfig> = {}): RunBudgetLimits {
  const timed = z.boolean().parse(config.runTimeBudgetEnabled ?? false)
  const activeMs = z.int().min(1).max(86_400_000).parse(config.runActiveMs ?? DEFAULT_RUN_ACTIVE_MS)
  return runBudgetLimitsSchema.parse({
    modelRequests: config.runModelRequests ?? DEFAULT_RUN_BUDGET_LIMITS.modelRequests,
    commands: config.runCommands ?? DEFAULT_RUN_BUDGET_LIMITS.commands,
    ...(timed ? { activeMs } : {}),
  })
}

// Alpha policy: recovery is finite and separate from execution allowance.
export const CONTROL_REQUESTS_PER_GRANT = 12
export const CONTROL_REQUESTS_PER_TURN = 3
export const CLOSED_RUN_HANDOFF_REQUESTS = 3
export const MAX_RUN_TOPUPS = 3
export const DEFAULT_BUDGET_TOPUP = Object.freeze({ modelRequests: 60, commands: 10 })
export const budgetAdditionSchema = z.strictObject({
  modelRequests: z.int().min(0).max(120), commands: z.int().min(0).max(20),
  activeMs: z.int().min(0).max(1_800_000).optional(),
})
export const budgetRecoveryInputSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(), action: z.enum(['topup', 'end']),
  reason: z.string().trim().min(1).max(500), add: budgetAdditionSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.action === 'end' && value.add) ctx.addIssue({ code: 'custom', message: 'ending cannot add allowance' })
})
const auditSchema = z.strictObject({ authority: z.literal('user'), channel: z.literal('native-question'),
  operator: z.literal('unverified'), requestId: z.string().min(1).max(256) })
const requestSchema = z.strictObject({
  id: z.string().min(1).max(256), action: z.enum(['topup', 'end']), block: z.int().positive(),
  workflowRevision: z.int().positive(), createdAt: z.int().nonnegative(), reason: z.string().trim().min(1).max(500),
  before: runBudgetLimitsSchema, add: budgetAdditionSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  settledAt: z.int().nonnegative().optional(), decisionAudit: auditSchema.optional(),
}).superRefine((value, ctx) => {
  const decided = value.status === 'approved' || value.status === 'rejected'
  if ((value.status === 'pending') !== (value.settledAt === undefined)
    || (value.settledAt !== undefined && value.settledAt < value.createdAt)
    || decided !== (value.decisionAudit !== undefined)
    || (value.decisionAudit && value.decisionAudit.requestId !== value.id)
    || (value.action === 'end' && (value.add.modelRequests !== 0 || value.add.commands !== 0 || (value.add.activeMs ?? 0) !== 0))
    || (value.action === 'topup' && value.add.modelRequests + value.add.commands + (value.add.activeMs ?? 0) === 0)) {
    ctx.addIssue({ code: 'custom', message: 'budget request lifecycle or native decision is invalid' })
  }
})
export type BudgetRequest = z.infer<typeof requestSchema>
const recoverySchema = z.strictObject({
  initialLimits: runBudgetLimitsSchema, blocks: z.int().nonnegative(), controlUsed: z.int().nonnegative(),
  requests: z.array(requestSchema).max(128), closed: z.boolean(), resumes: z.int().nonnegative(), awaitingResume: z.boolean(),
})

export const runTimeSchema = z.strictObject({
  revision: z.int().nonnegative(), observedMs: z.int().nonnegative(), uncertainMs: z.int().nonnegative(),
  reservedMs: z.int().min(0).max(RUN_TIME_SLICE_MS * 2), overrunMs: z.int().nonnegative(),
  ownerId: z.string().min(1).max(256).nullable(),
})
export type RunTimeAccount = z.infer<typeof runTimeSchema>
export const timeUsed = (time: RunTimeAccount) => time.observedMs + time.uncertainMs
export const formatRunTime = (ms: number) => {
  const tenths = Math.round(ms / 100)
  return `${Math.floor(tenths / 600)}分${((tenths % 600) / 10).toFixed(1)}秒`
}

export const runBudgetAccountSchema = z.strictObject({
  runId: z.string().min(1).max(256),
  limits: runBudgetLimitsSchema,
  used: z.strictObject({ rootModel: z.int().nonnegative(), childModel: z.int().nonnegative(), commands: z.int().nonnegative() }),
  blocked: z.strictObject({ resource: z.enum(['root-model', 'child-model', 'command', 'active-time']), recordedAt: z.int().nonnegative() }).nullable(),
  recovery: recoverySchema.optional(),
  time: runTimeSchema.optional(),
}).superRefine((value, context) => {
  const model = value.used.rootModel + value.used.childModel
  if (model > value.limits.modelRequests || value.used.commands > value.limits.commands
    || (value.blocked && (value.blocked.resource === 'active-time'
      ? !value.time || timeUsed(value.time) < (value.limits.activeMs ?? Infinity)
      : value.blocked.resource === 'command' ? value.used.commands < value.limits.commands : model < value.limits.modelRequests))) {
    context.addIssue({ code: 'custom', message: 'budget accounting exceeds or disagrees with its frozen limit' })
  }
  if ((value.time !== undefined) !== (value.limits.activeMs !== undefined)
    || (value.time && (timeUsed(value.time) + value.time.reservedMs > value.limits.activeMs!
      || (value.time.reservedMs > 0) !== (value.time.ownerId !== null)
      || (value.time.revision === 0 && (timeUsed(value.time) + value.time.reservedMs + value.time.overrunMs > 0 || value.time.ownerId))))) {
    context.addIssue({ code: 'custom', message: 'duration balance or reservation owner is invalid' })
  }
  const r = value.recovery
  if (!r) return // First-slice persisted accounts retain their exact read shape.
  const limits = { ...r.initialLimits }
  let grants = 0, ended = false, pending = 0, lastBlock = 0, lastTime = 0
  for (const request of r.requests) {
    if (ended || pending || request.block < lastBlock || request.block > r.blocks || request.block !== grants + 1
      || request.createdAt < lastTime || request.before.modelRequests !== limits.modelRequests
      || request.before.commands !== limits.commands || request.before.activeMs !== limits.activeMs
      || (request.add.activeMs !== undefined && limits.activeMs === undefined)) {
      context.addIssue({ code: 'custom', message: 'budget request history is not append-only or frozen' })
    }
    lastBlock = request.block; lastTime = request.settledAt ?? request.createdAt
    if (request.status === 'pending') pending++
    if (request.status !== 'approved') continue
    if (request.action === 'end') ended = true
    else { grants++; limits.modelRequests += request.add.modelRequests; limits.commands += request.add.commands
      if (limits.activeMs !== undefined) limits.activeMs += request.add.activeMs ?? 0 }
  }
  if (limits.modelRequests !== value.limits.modelRequests || limits.commands !== value.limits.commands
    || limits.activeMs !== value.limits.activeMs
    || grants > MAX_RUN_TOPUPS || r.controlUsed > CONTROL_REQUESTS_PER_GRANT * (1 + grants) + (r.closed ? CLOSED_RUN_HANDOFF_REQUESTS : 0)
    || r.blocks !== grants + (value.blocked ? 1 : 0) || ended !== r.closed
    || r.resumes !== grants - (r.awaitingResume ? 1 : 0) || (r.awaitingResume && (value.blocked || r.closed))
    || (r.closed && !value.blocked) || (pending > 0 && !value.blocked)
    || new Set(r.requests.map(item => item.id)).size !== r.requests.length) {
    context.addIssue({ code: 'custom', message: 'budget recovery limits, blocks or audit history disagree' })
  }
})
export type RunBudgetAccount = z.infer<typeof runBudgetAccountSchema>
export function runTimeSummary(account: RunBudgetAccount): string {
  const time = account.time
  if (!time) return ''
  return `有效时长：已观测 ${formatRunTime(time.observedMs)}；重启保守计入 ${formatRunTime(time.uncertainMs)}；已记账 ${formatRunTime(timeUsed(time))}/${formatRunTime(account.limits.activeMs!)}。`
    + (time.reservedMs ? `待结算预留 ${formatRunTime(time.reservedMs)}（不是已耗时）。` : '')
    + (time.overrunMs ? `另观察到计时回调延迟越界 ${formatRunTime(time.overrunMs)}；不声称实时强制终止。` : '')
}
export const runBudgetsSchema = z.strictObject({
  revision: z.int().positive(), accounts: z.array(runBudgetAccountSchema).min(1).max(10_000),
}).superRefine((value, context) => {
  const minimum = value.accounts.reduce((sum, account) => sum + 1 + account.used.rootModel
    + account.used.childModel + account.used.commands + (account.time?.revision ?? 0) + (account.recovery
      ? account.recovery.blocks + account.recovery.controlUsed + account.recovery.resumes
        + account.recovery.requests.reduce((n, request) => n + (request.status === 'pending' ? 1 : 2), 0)
      : (account.blocked ? 1 : 0)), 0)
  if (value.revision !== minimum || new Set(value.accounts.map(item => item.runId)).size !== value.accounts.length) {
    context.addIssue({ code: 'custom', message: 'budget revision/counts or run identities disagree' })
  }
})
export type RunBudgets = z.infer<typeof runBudgetsSchema>

export function emptyRunBudget(runId: string, limits: RunBudgetLimits): RunBudgetAccount {
  return runBudgetAccountSchema.parse({ runId, limits, used: { rootModel: 0, childModel: 0, commands: 0 }, blocked: null,
    recovery: { initialLimits: limits, blocks: 0, controlUsed: 0, requests: [], closed: false, resumes: 0, awaitingResume: false },
    ...(limits.activeMs === undefined ? {} : { time: { revision: 0, observedMs: 0, uncertainMs: 0, reservedMs: 0, overrunMs: 0, ownerId: null } }) })
}
export function mutableBudget(account: RunBudgetAccount): RunBudgetAccount & { recovery: z.infer<typeof recoverySchema> } {
  return { ...structuredClone(account), recovery: structuredClone(account.recovery ?? {
    initialLimits: account.limits, blocks: account.blocked ? 1 : 0, controlUsed: 0, requests: [], closed: false, resumes: 0, awaitingResume: false,
  }) }
}
export { BUDGET_TOPUP_LABEL, BUDGET_END_LABEL } from './workflow-ui-contract.ts'
export const RUN_BUDGET_STOP_MESSAGE = '本轮累计执行预算已耗尽（请求次数或有效时长），自动执行已封闭；不是业务验收失败，也不证明后台已停止。记录与产物保留。可在原生对话核对、申请补额或结束；补额必须明确确认且不能恢复已中断角色。无需模型的入口：/workflow-budget（查看）、/workflow-budget topup（申请补额）、/workflow-budget end（申请结束）。'
export class RunBudgetExceeded extends Error {
  override name = 'RunBudgetExceeded'
  constructor() { super(RUN_BUDGET_STOP_MESSAGE) }
}
