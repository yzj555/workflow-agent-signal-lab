/** Offline maintenance CLI. Inputs are read-only; outputs must be new files. */
import { writeFile, lstat, realpath } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/diagnose-workflow.mjs --snapshot <checkpointed-journal.sqlite> --data <object-directory> --output <new-report.json> [--native <read-only-tree-capture.json>] [--workspace <explicit-project-root>]... [--private-map <new-private-map.json>]')
    return
  }
  const options = { workspaceRoots: [] }, seen = new Set()
  const keys = { '--snapshot': 'journalSnapshot', '--data': 'dataDirectory', '--output': 'output', '--native': 'nativeCapture', '--private-map': 'privateMap' }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!value || value.startsWith('--') || (key !== '--workspace' && (!keys[key] || seen.has(key)))) throw new Error('invalid-arguments')
    if (!isAbsolute(value)) throw new Error('absolute-path-required')
    if (key === '--workspace') options.workspaceRoots.push(resolve(value))
    else { options[keys[key]] = resolve(value); seen.add(key) }
  }
  if (!options.journalSnapshot || !options.dataDirectory || !options.output) throw new Error('missing-required-arguments')
  // Never place an export or a private map into a inspected source directory.
  const inputs = [dirname(options.journalSnapshot), options.dataDirectory, ...options.workspaceRoots,
    ...(options.nativeCapture ? [dirname(options.nativeCapture)] : [])].map(value => resolve(value).toLowerCase())
  for (const output of [options.output, options.privateMap].filter(Boolean)) {
    const actualParent = await realpath(dirname(output)), stat = await lstat(dirname(output))
    if (stat.isSymbolicLink() || actualParent.toLowerCase() !== dirname(output).toLowerCase()) throw new Error('unsafe-output-directory')
    if (inputs.some(input => { const part = relative(input, output.toLowerCase()); return !part || (!part.startsWith('..') && !isAbsolute(part)) })) throw new Error('output-overlaps-input')
    try { await lstat(output); throw new Error('output-exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (options.privateMap && options.privateMap.toLowerCase() === options.output.toLowerCase()) throw new Error('outputs-overlap')
  const { inspectWorkflow } = await import('./lib/workflow-diagnostics.mjs')
  const { report, privateReferences } = await inspectWorkflow(options)
  // A private map is deliberately separate and requires an explicit option;
  // raw errors, conversations, command text and file contents are never exported.
  if (options.privateMap) await writeFile(options.privateMap, JSON.stringify({ schemaVersion: 1,
    warning: 'PRIVATE: session identities and paths; do not share with the redacted report', references: privateReferences }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, checkedRows: report.checkedRows, counts: report.counts, privateMapWritten: Boolean(options.privateMap) }))
  process.exitCode = report.status === 'no-conflicts-observed' ? 0 : report.status === 'needs-attention' ? 2 : 3
}
main(process.argv.slice(2)).catch(() => {
  console.error('诊断未完成：请核对参数、备份及独立输出路径；原始错误、路径和内容不会写入控制台。')
  process.exitCode = 1
})
