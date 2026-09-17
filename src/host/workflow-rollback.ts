/** Restartable file rollback. Authority lives in Journal, never in workspace files.
 * Startup only inspects unfinished transactions. Continuing requires a fresh gate.
 * Each step is recognizable from its deterministic names and exact byte digests.
 */
import { createHash } from 'node:crypto'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { captureWorkspaceFileState, sameWorkspaceFileState } from './workflow-artifacts.ts'
import type { WorkspaceRestoreEntry, WorkspaceFileCapture } from './workflow-artifacts.ts'

type RestoreStatus = 'untouched' | 'backed-up' | 'restored'
interface RestoreItem {
  readonly entry: WorkspaceRestoreEntry
  readonly current: WorkspaceFileCapture
  readonly backup: WorkspaceFileCapture
  readonly staged: WorkspaceFileCapture
  readonly status: RestoreStatus
}

function names(id: string, path: string) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) throw new Error('invalid rollback transaction id')
  const key = createHash('sha256').update(path.toLocaleLowerCase('en-US')).digest('hex').slice(0, 24)
  const base = join(dirname(path), `.workflow-rollback-${id}-${key}`)
  return { backup: `${base}.backup`, staged: `${base}.restore` }
}

async function inspect(root: string, id: string, entries: readonly WorkspaceRestoreEntry[], committed: boolean): Promise<RestoreItem[]> {
  // A replaced workspace root must not silently redirect an old authorization.
  if (resolve(await realpath(root)).toLocaleLowerCase('en-US') !== resolve(root).toLocaleLowerCase('en-US')) {
    throw new Error('撤销冲突：工作区根目录已重定向，保留现场')
  }
  if (!entries.length || entries.length > 100 || new Set(entries.map(e => e.relativePath.toLocaleLowerCase('en-US'))).size !== entries.length) {
    throw new Error('invalid rollback file set')
  }
  const result: RestoreItem[] = []
  for (const entry of entries) {
    const paths = names(id, entry.relativePath)
    const current = await captureWorkspaceFileState(root, entry.relativePath)
    const backup = await captureWorkspaceFileState(root, paths.backup)
    const staged = await captureWorkspaceFileState(root, paths.staged)
    const conflict = (detail: string): never => { throw new Error(`撤销冲突：${entry.relativePath} ${detail}；未覆盖文件，保留原文件及本次备份`) }
    if (backup.state.kind !== 'absent' && !sameWorkspaceFileState(backup.state, entry.expected)) conflict('备份摘要不匹配')
    if (staged.state.kind !== 'absent' && !sameWorkspaceFileState(staged.state, entry.target)) conflict('暂存内容不完整或已改变')
    let status: RestoreStatus
    if (committed) status = 'restored' // Cleanup never uses current content as permission to rewrite it.
    else if (sameWorkspaceFileState(current.state, entry.expected) && backup.state.kind === 'absent') status = 'untouched'
    else if (sameWorkspaceFileState(current.state, entry.target)
      && (entry.expected.kind === 'absent' || backup.state.kind === 'file')) status = 'restored'
    else if (current.state.kind === 'absent' && backup.state.kind === 'file' && entry.target.kind === 'file') status = 'backed-up'
    else status = conflict('与事务记录不一致（可能有后续编辑、缺失备份或外部删除）')
    result.push({ entry, current, backup, staged, status })
  }
  return result
}

/** Read only. Reject the entire set before resuming any file when one conflicts. */
export async function inspectDurableRollback(root: string, id: string, entries: readonly WorkspaceRestoreEntry[]) {
  const items = await inspect(root, id, entries, false)
  return items.map(item => ({ path: item.entry.relativePath, status: item.status }))
}

/** Must only run after the matching native approval and intent are committed together. */
export async function applyDurableRollback(root: string, id: string, entries: readonly WorkspaceRestoreEntry[], readCheckpoint: (digest: string) => Promise<Uint8Array>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const items = await inspect(root, id, entries, false)
  // Preflight every required immutable object before the first workspace mutation.
  const targets = new Map<string, Uint8Array>()
  for (const { entry, status } of items) {
    if (entry.target.kind !== 'file' || status === 'restored') continue
    const bytes = await readCheckpoint(entry.target.digest)
    if (bytes.byteLength !== entry.target.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.target.digest) {
      throw new Error(`撤销检查点损坏：${entry.relativePath}`)
    }
    targets.set(entry.relativePath, bytes)
  }
  for (const item of items) {
    signal?.throwIfAborted()
    if (item.status === 'restored') continue
    if (item.entry.target.kind === 'file' && item.staged.state.kind === 'absent') {
      const file = await open(item.staged.locator, 'wx')
      try { await file.writeFile(targets.get(item.entry.relativePath)!); await file.sync() }
      finally { await file.close() }
    }
  }
  // Recheck the full set after staging and each entry directly before mutation.
  await inspect(root, id, entries, false)
  for (const entry of entries) {
    signal?.throwIfAborted()
    let [item] = await inspect(root, id, [entry], false)
    if (item!.status === 'restored') continue
    if (item!.status === 'untouched' && entry.expected.kind === 'file') {
      await rename(item!.current.locator, item!.backup.locator)
      // A racing modification is retained in the backup, not overwritten by a restore.
      ;[item] = await inspect(root, id, [entry], false)
    }
    if (entry.target.kind === 'file' && item!.status !== 'restored') {
      signal?.throwIfAborted()
      // Unlike rename, hard-link installation cannot replace a file that appeared
      // after the check. Both names may survive a crash; that is a valid state.
      await link(item!.staged.locator, item!.current.locator)
      // Keep staged until the durable applied event: cleanup is the only deletion.
    }
  }
  const final = await inspect(root, id, entries, false)
  if (final.some(item => item.status !== 'restored')) throw new Error('撤销未完整完成；保留现场等待重新核对')
}

/** Only after rollback/applied; never rewrite or delete the current workspace target. */
export async function cleanDurableRollback(root: string, id: string, entries: readonly WorkspaceRestoreEntry[]): Promise<void> {
  const items = await inspect(root, id, entries, true)
  for (const item of items) {
    for (const [path, expected] of [[item.backup.relativePath, item.entry.expected], [item.staged.relativePath, item.entry.target]] as const) {
      const current = await captureWorkspaceFileState(root, path)
      if (current.state.kind === 'absent') continue
      if (!sameWorkspaceFileState(current.state, expected)) throw new Error(`撤销临时文件已改变，拒绝删除：${path}`)
      await unlink(current.locator)
    }
  }
}
