/** Portable, read-only native capture. Keep startup logs and captures private. */
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { captureNative, captureHostVersion, launchUrlFromLog } from './lib/workflow-native-capture.mjs'

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/capture-workflow-native.mjs --startup-log <private-dsh-startup.log> --output <new-private-capture.json>')
    return
  }
  const options = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!['--startup-log', '--output'].includes(args[i]) || !args[i + 1] || !isAbsolute(args[i + 1]) || options.has(args[i])) throw new Error('invalid-arguments')
    options.set(args[i], resolve(args[i + 1]))
  }
  if (options.size !== 2) throw new Error('missing-arguments')
  const input = options.get('--startup-log'), output = options.get('--output')
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!(await lstat(input)).isFile() || !same(await realpath(input), input)
    || !(await lstat(dirname(output))).isDirectory() || !same(await realpath(dirname(output)), dirname(output))) throw new Error('unsafe-path')
  try { await lstat(output); throw new Error('output-exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const file = await open(input, 'r')
  let bytes
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 1024 * 1024) throw new Error('startup-log-limit')
    const buffer = Buffer.alloc(before.size + 1)
    let total = 0
    while (total < buffer.length) {
      const read = await file.read(buffer, total, buffer.length - total, total)
      if (!read.bytesRead) break
      total += read.bytesRead
    }
    const after = await file.stat()
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('startup-log-changed')
    bytes = buffer.subarray(0, total)
  } finally { await file.close() }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const dsh = captureHostVersion(manifest.peerDependencies?.['@deepseek-ai/dsh-agent-preset-registry']
    ?? manifest.peerDependencies?.['@deepseek-ai/dsh-agent-presets'])
  const report = await captureNative(launchUrlFromLog(bytes.toString('utf8')), { dsh })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, roots: report.roots.length,
    catalog: report.catalog.length, failures: report.failures.length, privateCaptureWritten: true }))
  process.exitCode = report.status === 'no-activity-observed' ? 0 : report.status === 'needs-attention' ? 2 : 3
}
main(process.argv.slice(2)).catch(() => {
  console.error('原生采集未完成：请核对启动日志、兼容版本与独立输出路径；认证信息和原始错误不会写入控制台。')
  process.exitCode = 1
})
