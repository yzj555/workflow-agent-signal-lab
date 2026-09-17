const test = require('node:test')
const { spawn } = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')

test('real bounded budget process probe', async () => {
  const config = JSON.parse(readFileSync('budget-fixture.json', 'utf8'))
  const record = event => appendFileSync('budget-processes.jsonl', JSON.stringify({ event, pid: process.pid, at: Date.now() }) + '\n')
  record('started')
  if (config.hold) {
    // Both the test and its only descendant have an independent 20s exit fuse.
    // The run budget should terminate this owned range well before that fuse.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true })
    writeFileSync('budget-owned-pids.json', JSON.stringify({ testPid: process.pid, descendantPid: child.pid }))
    child.unref()
    await new Promise(resolve => setTimeout(resolve, 20000))
  }
  record('completed')
})
