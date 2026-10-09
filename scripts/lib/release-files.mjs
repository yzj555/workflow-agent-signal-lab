import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const digest = value => createHash('sha256').update(value).digest('hex')
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value
export const inside = (root, value) => {
  const part = relative(keyPath(resolve(root)), keyPath(resolve(value)))
  return !part || (part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part))
}

export async function regularFiles(root) {
  const result = {}
  async function walk(at) {
    const info = await lstat(at)
    if (info.isSymbolicLink()) throw new Error('release-input-link: ' + relative(root, at))
    if (info.isDirectory()) {
      for (const name of (await readdir(at)).sort()) await walk(join(at, name))
    } else if (info.isFile()) {
      result[relative(root, at).replaceAll('\\', '/')] = digest(await readFile(at))
    } else throw new Error('release-input-not-regular')
  }
  await walk(root)
  return result
}

export async function newDirectory(path) {
  if (!isAbsolute(path)) throw new Error('absolute-output-required')
  const parent = dirname(resolve(path))
  if (keyPath(await realpath(parent)) !== keyPath(parent)) throw new Error('output-parent-link')
  await mkdir(path) // Exclusive: never reuse, clean or overwrite a caller directory.
}

export async function saveJson(file, value, { newline = true } = {}) {
  await writeFile(file, JSON.stringify(value, null, 2) + (newline ? '\n' : ''), { flag: 'wx' })
}

export function candidateVersion(value) {
  // A development build cannot silently manufacture a final production version.
  if (!/^1\.0\.0-rc\.[1-9][0-9]{0,5}$/u.test(value)) throw new Error('explicit-rc-version-required')
  return value
}
