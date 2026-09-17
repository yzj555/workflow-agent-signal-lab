import { openWorkflowStorage } from '../../lib/workflow-runtime.js'

// This helper only receives a unique temporary test directory, never a user profile.
const [directory, mode = 'hold', rootSessionId = 'session-a'] = process.argv.slice(2)
try {
  const runtime = await openWorkflowStorage(directory)
  if (mode === 'read') {
    console.log(JSON.stringify(runtime.journal.readSnapshot(rootSessionId)))
    await runtime.close()
  } else {
    process.send({ kind: 'opened' })
    process.once('message', async () => {
      try { await runtime.close(); process.disconnect() }
      catch (error) { console.error(String(error)); process.exitCode = 1; process.disconnect() }
    })
  }
} catch (error) {
  if (process.send) { process.send({ kind: 'rejected', message: String(error) }); process.disconnect() }
  else console.error(String(error))
  process.exitCode = 2
}
