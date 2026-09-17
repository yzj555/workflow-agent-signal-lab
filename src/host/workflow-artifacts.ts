import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ArtifactRecord } from '../workflow-contract.ts'
import type { WorkflowFileState } from '../workflow-events.ts'
import { normalizeProjectRelative } from '../workflow-project-contract.ts'

/** Plugin-owned immutable text objects; never accepts a model-supplied path. */
export class WorkflowTextArtifacts {
  private constructor(readonly directory: string, readonly checkpointDirectory: string) {}

  static async open(dataDirectory: string): Promise<WorkflowTextArtifacts> {
    if (!isAbsolute(dataDirectory)) throw new Error('artifact dataDirectory must be absolute')
    const base = await realpath(dataDirectory)
    const directory = join(base, 'text-artifacts')
    const checkpointDirectory = join(base, 'workspace-checkpoints')
    await mkdir(directory, { recursive: true })
    await mkdir(checkpointDirectory, { recursive: true })
    for (const target of [directory, checkpointDirectory]) {
      const stat = await lstat(target)
      if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(target)) !== resolve(target)) {
        throw new Error('artifact directory must be a real, plugin-owned directory')
      }
    }
    return new WorkflowTextArtifacts(directory, checkpointDirectory)
  }

  private path(digest: string): string {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('invalid artifact digest')
    return join(this.directory, `${digest}.txt`)
  }

  async put(text: string): Promise<{ digest: string; locator: string }> {
    if (typeof text !== 'string' || text.length === 0 || text.length > 32000) throw new Error('invalid text artifact')
    const digest = createHash('sha256').update(text, 'utf8').digest('hex')
    const target = this.path(digest)
    let file
    try { file = await open(target, 'wx') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await this.read(digest) !== text) throw new Error('artifact collision or corruption')
      return { digest, locator: target }
    }
    try { await file.writeFile(text, 'utf8'); await file.sync() }
    finally { await file.close() }
    return { digest, locator: target }
  }

  async read(digest: string): Promise<string> {
    const target = this.path(digest)
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) throw new Error('invalid stored artifact')
    const text = await readFile(target, 'utf8')
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== digest) throw new Error('stored artifact digest mismatch')
    return text
  }

  private checkpointPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('invalid checkpoint digest')
    return join(this.checkpointDirectory, `${digest}.bin`)
  }

  /** Content-addressed binary objects used only for pre-mutation workspace snapshots. */
  async putCheckpoint(bytes: Uint8Array): Promise<{ digest: string; bytes: number }> {
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('checkpoint file exceeds the 16 MiB pilot limit')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const target = this.checkpointPath(digest)
    let file
    try { file = await open(target, 'wx') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.readCheckpoint(digest)
      if (existing.byteLength !== bytes.byteLength) throw new Error('checkpoint collision or corruption')
      return { digest, bytes: bytes.byteLength }
    }
    try { await file.writeFile(bytes); await file.sync() }
    finally { await file.close() }
    return { digest, bytes: bytes.byteLength }
  }

  async readCheckpoint(digest: string): Promise<Uint8Array> {
    const target = this.checkpointPath(digest)
    const stat = await lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('invalid stored checkpoint')
    const bytes = await readFile(target)
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('stored checkpoint digest mismatch')
    return bytes
  }
}

export type WorkspaceFileState = WorkflowFileState

export interface WorkspaceFileCapture {
  readonly relativePath: string
  readonly locator: string
  readonly state: WorkspaceFileState
  readonly content?: Uint8Array
}

export interface WorkspaceFileSnapshot {
  readonly relativePath: string
  readonly locator: string
  readonly digest: string
  readonly bytes: number
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('workspace artifact escaped the confirmed root')
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function safeWorkspaceTarget(workspaceRoot: string, relativePath: string): Promise<{
  readonly relativePath: string
  readonly locator: string
}> {
  if (!isAbsolute(workspaceRoot)) throw new Error('workspace root must be absolute')
  const normalized = normalizeProjectRelative(relativePath, false)
  const root = resolve(await realpath(workspaceRoot))
  const requested = resolve(root, normalized)
  assertInside(root, requested)
  let cursor = root
  const segments = normalized.split('/')
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    let stat
    try { stat = await lstat(cursor) }
    catch (error) {
      if (isMissing(error)) break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`workspace path contains a symbolic link: ${normalized}`)
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`workspace path parent is not a directory: ${normalized}`)
    }
  }
  return { relativePath: normalized, locator: requested }
}

/** Read a regular file or a confirmed absence without following symlinks. */
export async function captureWorkspaceFileState(workspaceRoot: string, relativePath: string): Promise<WorkspaceFileCapture> {
  const target = await safeWorkspaceTarget(workspaceRoot, relativePath)
  let stat
  try { stat = await lstat(target.locator) }
  catch (error) {
    if (isMissing(error)) return { ...target, state: { kind: 'absent' } }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`workspace artifact is not a regular file: ${target.relativePath}`)
  if (stat.size > 16 * 1024 * 1024) throw new Error(`workspace artifact exceeds the 16 MiB pilot limit: ${target.relativePath}`)
  const content = await readFile(target.locator)
  return {
    ...target,
    state: { kind: 'file', digest: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength },
    content,
  }
}

export function sameWorkspaceFileState(left: WorkspaceFileState, right: WorkspaceFileState): boolean {
  return left.kind === right.kind && (left.kind === 'absent'
    || (right.kind === 'file' && left.digest === right.digest && left.bytes === right.bytes))
}

/** Hash one regular, non-symlink workspace file after resolving every parent. */
export async function snapshotWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<WorkspaceFileSnapshot> {
  const captured = await captureWorkspaceFileState(workspaceRoot, relativePath)
  if (captured.state.kind !== 'file') throw new Error(`workspace artifact is not a regular file: ${captured.relativePath}`)
  return {
    relativePath: captured.relativePath,
    locator: captured.locator,
    digest: captured.state.digest,
    bytes: captured.state.bytes,
  }
}

/** Re-read an immutable Journal reference before accepting downstream evidence. */
export async function verifyWorkspaceArtifact(workspaceRoot: string, record: ArtifactRecord): Promise<void> {
  if (record.data.artifactType !== 'workspace-file') throw new Error(`unsupported project artifact type: ${record.data.artifactType}`)
  const snapshot = await snapshotWorkspaceFile(workspaceRoot, record.data.name)
  if (snapshot.locator !== resolve(record.data.locator) || snapshot.digest !== record.data.digest) {
    throw new Error(`workspace artifact changed after implementation report: ${record.data.name}`)
  }
}

export interface WorkspaceRestoreEntry {
  readonly relativePath: string
  readonly expected: WorkspaceFileState
  readonly target: WorkspaceFileState
}

export interface WorkspaceRestoreTransaction {
  /** Delete temporary backups after the caller durably records the rollback. */
  complete(): Promise<void>
  /** Restore the exact expected pre-transaction state if Journal commit fails. */
  revert(): Promise<void>
}

interface PreparedRestore {
  readonly relativePath: string
  readonly locator: string
  readonly expected: WorkspaceFileState
  readonly target: WorkspaceFileState
  readonly backup: string
  readonly staged?: string
  backedUp: boolean
  installed: boolean
}

async function removeIfPresent(path: string): Promise<void> {
  try { await unlink(path) }
  catch (error) { if (!isMissing(error)) throw error }
}

/**
 * Replace a bounded set of files without recursive deletion. Current files are
 * renamed aside until the caller commits the matching Journal event.
 */
export async function beginWorkspaceRestore(
  workspaceRoot: string,
  entries: readonly WorkspaceRestoreEntry[],
  readCheckpoint: (digest: string) => Promise<Uint8Array>,
): Promise<WorkspaceRestoreTransaction> {
  const keys = entries.map(entry => normalizeProjectRelative(entry.relativePath, false).toLocaleLowerCase('en-US'))
  if (new Set(keys).size !== keys.length) throw new Error('rollback file list contains duplicates')
  const prepared: PreparedRestore[] = []
  try {
    for (const entry of entries) {
      const current = await captureWorkspaceFileState(workspaceRoot, entry.relativePath)
      if (!sameWorkspaceFileState(current.state, entry.expected)) {
        throw new Error(`rollback conflict: ${current.relativePath} no longer matches the recorded implementation state`)
      }
      const token = randomUUID()
      const base = join(dirname(current.locator), `.workflow-rollback-${token}`)
      let staged: string | undefined
      if (entry.target.kind === 'file') {
        const bytes = await readCheckpoint(entry.target.digest)
        if (bytes.byteLength !== entry.target.bytes
          || createHash('sha256').update(bytes).digest('hex') !== entry.target.digest) {
          throw new Error(`rollback checkpoint is corrupt: ${current.relativePath}`)
        }
        staged = `${base}.restore`
        const file = await open(staged, 'wx')
        try { await file.writeFile(bytes); await file.sync() }
        finally { await file.close() }
      }
      prepared.push({
        relativePath: current.relativePath,
        locator: current.locator,
        expected: entry.expected,
        target: entry.target,
        backup: `${base}.backup`,
        ...(staged === undefined ? {} : { staged }),
        backedUp: false,
        installed: false,
      })
    }

    for (const item of prepared) {
      if (item.expected.kind === 'file') {
        const current = await captureWorkspaceFileState(workspaceRoot, item.relativePath)
        if (!sameWorkspaceFileState(current.state, item.expected)) {
          throw new Error(`rollback conflict: ${item.relativePath} changed during restore preparation`)
        }
        await rename(item.locator, item.backup)
        item.backedUp = true
      }
    }
    for (const item of prepared) {
      if (item.target.kind === 'file') {
        await rename(item.staged!, item.locator)
        item.installed = true
      }
    }
    for (const item of prepared) {
      const current = await captureWorkspaceFileState(workspaceRoot, item.relativePath)
      if (!sameWorkspaceFileState(current.state, item.target)) throw new Error(`rollback verification failed: ${item.relativePath}`)
    }
  } catch (error) {
    for (const item of [...prepared].reverse()) {
      try {
        if (item.installed) await removeIfPresent(item.locator)
        if (item.backedUp) await rename(item.backup, item.locator)
        if (item.staged) await removeIfPresent(item.staged)
      } catch { /* Preserve the first failure; the caller will surface recovery guidance. */ }
    }
    throw error
  }

  let settled = false
  return {
    async complete() {
      if (settled) return
      for (const item of prepared) {
        if (item.backedUp) await removeIfPresent(item.backup)
        if (item.staged) await removeIfPresent(item.staged)
      }
      settled = true
    },
    async revert() {
      if (settled) return
      settled = true
      for (const item of [...prepared].reverse()) {
        if (item.installed) await removeIfPresent(item.locator)
        if (item.backedUp) await rename(item.backup, item.locator)
        if (item.staged) await removeIfPresent(item.staged)
      }
      for (const item of prepared) {
        const current = await captureWorkspaceFileState(workspaceRoot, item.relativePath)
        if (!sameWorkspaceFileState(current.state, item.expected)) {
          throw new Error(`rollback compensation failed: ${item.relativePath}`)
        }
      }
    },
  }
}
