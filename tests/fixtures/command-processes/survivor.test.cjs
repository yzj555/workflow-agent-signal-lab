// All processes belong to this short-lived test fixture. Even if containment
// fails, the child self-exits after 30s; the harness never kills an arbitrary PID.
const test = require('node:test')
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
test('direct command leaves a controlled descendant', () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
  writeFileSync('fixture-pid.json', JSON.stringify({ pid: child.pid }))
  child.unref()
})
