import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface WorkflowOwner {
  readonly directory: string
  readonly instanceId: string
  release(): Promise<void>
}

/** Atomic startup ownership. Stale/foreign/malformed markers are never auto-reclaimed. */
export async function acquireWorkflowOwner(dataDirectory: string): Promise<WorkflowOwner> {
  if (!isAbsolute(dataDirectory)) throw new Error('workflow dataDirectory must be absolute')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const directory = await realpath(dataDirectory)
  const path = join(directory, 'writer.lock')
  const instanceId = randomUUID()
  const contents = JSON.stringify({ version: 1, instanceId, pid: process.pid, startedAt: Date.now() })
  const handle = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new Error(`workflow store is owned or needs crash recovery: ${path}; no owner was replaced`)
    }
    throw error
  })
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close()
    // Preserve an incomplete marker for explicit recovery, never guess ownership.
    throw error
  }
  const identity = await handle.stat()
  let released = false
  let releasing: Promise<void> | undefined
  return {
    directory, instanceId,
    release() {
      if (releasing !== undefined) return releasing
      releasing = (async () => {
        if (released) return
        try {
          const current = await lstat(path)
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
            || await readFile(path, 'utf8') !== contents) {
            throw new Error('workflow owner changed; refusing to remove its marker')
          }
          await handle.close()
          await unlink(path)
          released = true
        } catch (error) {
          await handle.close().catch(() => {})
          throw error
        }
      })()
      return releasing
    },
  }
}
