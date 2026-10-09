import { captureTransition, prepareTransition } from './lib/workflow-profile-transition.mjs'
const help = `Capture (offline): node scripts/transition-workflow.mjs capture --plan <current-activation-plan.json> --output <new-private-directory>
Prepare after OFFLINE official installation: node scripts/transition-workflow.mjs prepare --checkpoint <CURRENT-data-checkpoint.json> --mode upgrade|rollback|reconfigure --output <new-plan-directory> [--rollback-checkpoint <archived-target-checkpoint.json>] [--accept-config-change]
No install, stop, launch, migration, data rollback or lock reclamation. Existing writers refuse. A checkpoint is private and is not proof of Host-wide idle.
Rollback must use a freshly captured CURRENT database, not a pre-upgrade data restore. Target packages without transitionProtocol 1 are refused.
Only the pinned Host and unchanged resource policy are supported; config review applies to same-version reconfigure only.`
async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return }
  const [command, ...rest] = args, options = {}, seen = new Set()
  const keys = command === 'capture' ? { '--plan': 'planPath', '--output': 'output' }
    : command === 'prepare' ? { '--checkpoint': 'checkpointPath', '--output': 'output', '--mode': 'mode', '--rollback-checkpoint': 'rollbackCheckpoint' } : null
  if (!keys) throw new Error('Expected capture or prepare; see --help')
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    if (seen.has(key)) throw new Error('duplicate-argument')
    seen.add(key)
    if (key === '--accept-config-change' && command === 'prepare') { options.acceptConfigChange = true; continue }
    const value = rest[++i]
    if (!keys[key] || !value || value.startsWith('--')) throw new Error('invalid-argument')
    options[keys[key]] = value
  }
  for (const key of command === 'capture' ? ['planPath', 'output'] : ['checkpointPath', 'output', 'mode']) if (!options[key]) throw new Error('missing-' + key)
  console.log(JSON.stringify(await (command === 'capture' ? captureTransition(options) : prepareTransition(options))))
}
try { await main(process.argv.slice(2)) }
catch (error) {
  // Assertion values can contain configuration or durable task text. Details
  // remain in the private checkpoint; never dump actual/expected JSON here.
  console.error('Transition refused: ' + String(error.message).split('\n')[0]); process.exitCode = 1
}
