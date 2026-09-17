import { isAbsolute, relative, resolve } from 'node:path'
import type { TaskBrief } from '../workflow-contract.ts'
import type { WorkflowCheck } from '../workflow-project-contract.ts'
import { normalizeProjectRelative } from '../workflow-project-contract.ts'

export const PROJECT_NATIVE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'] as const
const WORKFLOW_CHILD_TOOLS = ['workflow_packet', 'workflow_report'] as const

const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  architect: [...WORKFLOW_CHILD_TOOLS, 'read', 'glob', 'grep'],
  engineer: [...WORKFLOW_CHILD_TOOLS, 'read', 'write', 'edit', 'glob', 'grep'],
  test_engineer: [...WORKFLOW_CHILD_TOOLS, 'read', 'glob', 'grep', 'pwsh'],
  code_reviewer: [...WORKFLOW_CHILD_TOOLS, 'read', 'glob', 'grep'],
  acceptance_qa: [...WORKFLOW_CHILD_TOOLS, 'pwsh'],
}

interface JsonObject { readonly [key: string]: unknown }

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function unknownKeys(value: JsonObject, allowed: readonly string[]): string[] {
  return Object.keys(value).filter(key => !allowed.includes(key))
}

function canonicalRoot(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) throw new Error('工程工作区必须是绝对路径')
  return resolve(workspaceRoot)
}

export function resolveProjectPath(workspaceRoot: string, candidate: string): string {
  const root = canonicalRoot(workspaceRoot)
  const target = resolve(root, candidate)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('路径离开了已确认工作区')
  }
  return target
}

function inWriteScope(workspaceRoot: string, task: TaskBrief, candidate: string): boolean {
  const target = resolveProjectPath(workspaceRoot, candidate)
  return task.data.writeScopes.some(scope => {
    const base = resolveProjectPath(workspaceRoot, normalizeProjectRelative(scope, false))
    const rel = relative(base, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel))
  })
}

export function projectToolsForTask(task: TaskBrief): readonly string[] {
  return ROLE_TOOLS[task.data.role] ?? [...WORKFLOW_CHILD_TOOLS]
}

export function matchProjectCheck(checks: readonly WorkflowCheck[], args: unknown,
  workspaceRoot: string, childCwd?: string): WorkflowCheck | undefined {
  const value = object(args)
  if (!value || typeof value.command !== 'string') return undefined
  const extras = unknownKeys(value, ['command', 'description', 'timeoutMs', 'workdir', 'run_in_background', 'sandbox_permissions', 'justification'])
  if (extras.length || value.run_in_background === true || value.sandbox_permissions !== undefined || value.justification !== undefined) return undefined
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0 || value.timeoutMs > 120_000)) return undefined
  const command = value.command.trim().replace(/\s+/gu, ' ')
  return checks.find(check => {
    if (check.command.trim().replace(/\s+/gu, ' ') !== command) return false
    const expected = resolveProjectPath(workspaceRoot, normalizeProjectRelative(check.workdir, true))
    if (value.workdir === undefined) return check.workdir === '.' && childCwd !== undefined && resolve(childCwd) === canonicalRoot(workspaceRoot)
    return typeof value.workdir === 'string' && resolveProjectPath(workspaceRoot, value.workdir) === expected
  })
}

/**
 * Final task-packet guard layered on top of DSH's native sandbox and approval
 * policy. It can only deny; it never widens native permissions.
 */
export function guardProjectTool(task: TaskBrief, checks: readonly WorkflowCheck[], workspaceRoot: string,
  name: string, args: unknown, childCwd?: string): string | undefined {
  const allowed = projectToolsForTask(task)
  if (!allowed.includes(name)) return `角色 ${task.data.role} 无权使用 ${name}`
  if ((WORKFLOW_CHILD_TOOLS as readonly string[]).includes(name)) return undefined
  const value = object(args)
  if (!value) return `${name} 参数必须是对象`
  if (name === 'pwsh') {
    return matchProjectCheck(checks, value, workspaceRoot, childCwd)
      ? undefined
      : '只允许执行任务包中逐字冻结的前台检查命令；禁止后台、升权和替换工作目录'
  }
  if (name === 'read') {
    const extras = unknownKeys(value, ['file_path', 'offset', 'limit'])
    if (extras.length || typeof value.file_path !== 'string') return 'read 参数不符合受控文件读取约定'
    try { resolveProjectPath(workspaceRoot, value.file_path) } catch (error) { return error instanceof Error ? error.message : String(error) }
    return undefined
  }
  if (name === 'glob' || name === 'grep') {
    const allowedKeys = name === 'glob' ? ['pattern', 'path'] : ['pattern', 'path', 'include']
    const extras = unknownKeys(value, allowedKeys)
    if (extras.length || typeof value.pattern !== 'string') return `${name} 参数不符合受控检索约定`
    try {
      resolveProjectPath(workspaceRoot, value.path === undefined ? '.' : typeof value.path === 'string' ? value.path : '../invalid')
    } catch (error) { return error instanceof Error ? error.message : String(error) }
    return undefined
  }
  if (name === 'write') {
    const extras = unknownKeys(value, ['file_path', 'content', 'sandbox_permissions', 'justification'])
    if (extras.length || typeof value.file_path !== 'string' || typeof value.content !== 'string'
      || value.sandbox_permissions !== undefined || value.justification !== undefined) return 'write 参数不符合受控写入约定，且不允许升权'
    try { return inWriteScope(workspaceRoot, task, value.file_path) ? undefined : '写入目标不在已确认的任务前缀内' }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  if (name === 'edit') {
    const extras = unknownKeys(value, ['file_path', 'old_string', 'new_string', 'replace_all', 'sandbox_permissions', 'justification'])
    if (extras.length || typeof value.file_path !== 'string' || typeof value.old_string !== 'string' || typeof value.new_string !== 'string'
      || value.sandbox_permissions !== undefined || value.justification !== undefined) return 'edit 参数不符合受控编辑约定，且不允许升权'
    try { return inWriteScope(workspaceRoot, task, value.file_path) ? undefined : '编辑目标不在已确认的任务前缀内' }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  return `未声明的工程工具：${name}`
}
