const test = require('node:test')
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
test('a controlled command and descendant both exceed the workflow budget', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
  writeFileSync('fixture-pid.json', JSON.stringify({ pid: child.pid }))
  child.unref()
  await new Promise(resolve => setTimeout(resolve, 30000))
})
