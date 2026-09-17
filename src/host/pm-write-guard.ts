import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface SessionHeaderLike {
  cwd?: string
  origin?: string
  parentSession?: string
  delegationDepth?: number
}

interface ToolExecutionLike {
  agent?: { session?: { header?: SessionHeaderLike } }
  arguments?: { file_path?: unknown }
  callId?: string
  name?: string
  parent?: unknown
  signal?: AbortSignal
}

interface GuardConfig {
  enabled?: boolean
  jobsDir?: string
}

interface GuardContext {
  get(name: string): {
    request(input: {
      agent: NonNullable<ToolExecutionLike['agent']>
      toolName: string
      callId: string
      reason: string
      signal?: AbortSignal
    }): Promise<ApprovalOutcome>
  } | undefined
  on(
    name: 'tools/execute',
    listener: (exec: ToolExecutionLike, next: () => Promise<unknown>) => Promise<unknown>,
  ): unknown
}

export const name = '@local/workflow-agent-signal-lab'
export const inject = ['tools']

const WRITE_TOOLS = new Set(['write', 'edit'])
const DEFAULT_JOBS_DIR = join(homedir(), '.dsh', 'crew', 'jobs')
const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function segmentsOf(target: string): string[] {
  return resolve(target).split(/[\\/]+/).filter(segment => segment.length > 0)
}

function endsWith(segments: readonly string[], tail: readonly string[]): boolean {
  if (segments.length < tail.length) return false
  const offset = segments.length - tail.length
  return tail.every((part, index) => segments[offset + index] === part)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function realpathOf(target: string): string {
  const missing: string[] = []
  let cursor = target
  for (;;) {
    try {
      const real = realpathSync.native(cursor)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return target
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

function isJobStateFile(segments: readonly string[], jobsDir: string): boolean {
  const dirSegments = segmentsOf(canonicalPath(jobsDir))
  if (segments.length <= dirSegments.length) return false
  if (dirSegments.some((part, index) => segments[index] !== part)) return false
  return segments.at(-1) === 'state.json'
}

/**
 * DSH's ToolExecution.parent is a nested transport token, not Agent lineage.
 * A real in-process subagent is identified by the immutable session header
 * written by the host when the child is created.
 */
export function isDelegatedAgentExecution(exec: ToolExecutionLike): boolean {
  const header = exec.agent?.session?.header
  return header?.origin === 'subagent'
    && typeof header.parentSession === 'string'
    && header.parentSession.length > 0
    && typeof header.delegationDepth === 'number'
    && Number.isSafeInteger(header.delegationDepth)
    && header.delegationDepth > 0
}

/** Classify paths the root PM may write without a per-call approval. */
export function classifyPmWriteTarget(target: string, jobsDir = DEFAULT_JOBS_DIR): 'pm' | 'protected' {
  const segments = segmentsOf(realpathOf(target))
  const last = segments.at(-1) ?? ''
  const parent = segments.slice(0, -1)

  if (endsWith(parent, ['docs', 'design']) && /^prd-.+\.md$/.test(last)) return 'pm'
  if (endsWith(parent, ['docs', 'decisions', 'crd']) && last.endsWith('.md')) return 'pm'
  if (endsWith(parent, ['docs', 'decisions', 'adr']) && last.endsWith('.md')) return 'pm'
  if (endsWith(parent, ['docs', 'tasks'])) return 'pm'
  if (endsWith(segments, ['qa', 'run-all.sh'])) return 'pm'
  if (endsWith(segments, ['qa', 'gaps.md'])) return 'pm'
  if (last === 'CLAUDE.md' || last === 'principles.md') return 'pm'
  if (endsWith(segments, ['roles', 'pm.md'])) return 'pm'
  if (isJobStateFile(segments, jobsDir)) return 'pm'
  return 'protected'
}

function resolveWritePath(filePath: string, exec: ToolExecutionLike): string {
  const cwd = exec.agent?.session?.header?.cwd
  if (cwd === undefined) return resolve(filePath)
  const base = PARENT_PATH_SEGMENT.test(cwd) || PARENT_PATH_SEGMENT.test(filePath)
    ? canonicalPath(cwd)
    : cwd
  return resolve(base, filePath)
}

function describeTarget(target: string, real: string): string {
  return real === target ? `"${target}"` : `"${real}" (the PM typed "${target}")`
}

function approvalReason(target: string, real: string): string {
  return `Workflow Agent PM write guard: the root Agent wants to write ${describeTarget(target, real)}, `
    + 'which is not on the PM whitelist. Approve to allow this one write only.'
}

function refusalReason(target: string, real: string, outcome: ApprovalOutcome): string {
  const base = `the root Agent may not write ${describeTarget(target, real)} because it is not on the PM whitelist.`
  if (outcome === 'rejected') return `${base} The user rejected this write.`
  if (outcome === 'cancelled') return `${base} The approval prompt was cancelled.`
  if (outcome === 'unavailable') return `${base} No approval channel is available, so the write fails closed.`
  return base
}

function block(reason: string): Record<string, unknown> {
  const message = `Workflow Agent PM write guard blocked this write: ${reason}`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'WorkflowAgentPmWriteGuardError', code: 'WORKFLOW_AGENT_PM_WRITE_BLOCKED' } },
  }
}

async function askApproval(
  ctx: GuardContext,
  exec: ToolExecutionLike,
  target: string,
  real: string,
): Promise<ApprovalOutcome> {
  const approval = ctx.get('approval')
  if (approval === undefined || exec.agent === undefined || exec.name === undefined || exec.callId === undefined) {
    return 'unavailable'
  }
  try {
    return await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: approvalReason(target, real),
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
  } catch {
    return 'unavailable'
  }
}

/**
 * Local compatibility guard for dsh-crew 0.10.0.
 *
 * The upstream guard treats ToolExecution.parent as proof that a call belongs
 * to a Crew child. DSH defines that field as a nested tool-dispatch token, so a
 * child's direct write has no value while a root Code Mode write does. This
 * implementation uses durable Agent lineage instead: delegated children pass;
 * every root write/edit remains guarded, nested or direct.
 */
export function apply(ctx: GuardContext, config?: GuardConfig): void {
  if (config?.enabled === false) return
  const jobsDir = config?.jobsDir === undefined ? DEFAULT_JOBS_DIR : expandHome(config.jobsDir)

  ctx.on('tools/execute', async (exec, next) => {
    if (isDelegatedAgentExecution(exec)) return next()
    if (!WRITE_TOOLS.has(exec.name ?? '')) return next()

    const filePath = exec.arguments?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) return next()

    const target = resolveWritePath(filePath, exec)
    if (classifyPmWriteTarget(target, jobsDir) === 'pm') return next()

    const real = realpathOf(target)
    const outcome = await askApproval(ctx, exec, target, real)
    if (outcome === 'allowed-once') return next()
    return block(refusalReason(target, real, outcome))
  })
}
