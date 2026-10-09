/** Produces a last --patch overlay; does not edit or launch a Profile. */
import { prepareProfile, verifyProfile } from './lib/workflow-profile-config.mjs'
const help = `Prepare: node scripts/configure-workflow.mjs prepare --host-package <DSH-package.json> --home <DSH_HOME> --profile <name> --data <new-private-directory> --policy packaged-candidate --output <new-output-directory> [--patch <existing-overlay>]...
Check: node scripts/configure-workflow.mjs check --plan <activation-plan.json>
Preparation writes only a new output directory. It does not initialize, install, start, stop or modify a Profile.
For legacy DSH the Profile must explicitly use dsh.profile.patchReload=startup. For DSH 0.2 it must explicitly disable every dsh-hmr row in its existing composition; the ignored legacy manifest field is not sufficient. Default live reload is refused, not silently changed.
Legacy Check requires official module fallback established by normal startup. DSH 0.2 Check uses the public official runtime-resolution service in a disposable context, with no filesystem link repair. The installed guard checks the actual Host routing and absence of live reload again at startup.
For DSH 0.2, identity/owner preflight comes first; Journal and controller may initialize for the scoped preset audit. Workflow root binding and UI remain closed until that audit passes. Check alone does not prove runtime admission.
Launch separately with the same DSH_HOME, Host, Profile and ordered existing --patch arguments, followed by --patch <workflow-enable.patch.yml>. Omit this last patch to disable after a confirmed idle shutdown. Neither operation is performed here.`

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return }
  const [mode, ...rest] = args
  if (!['prepare', 'check'].includes(mode)) throw new Error('Expected prepare or check; see --help')
  const options = { patches: [] }, seen = new Set()
  const keys = mode === 'check' ? { '--plan': 'planPath' } : {
    '--host-package': 'hostPackage', '--home': 'home', '--profile': 'profile', '--data': 'dataDirectory', '--policy': 'policy', '--output': 'output', '--patch': 'patches',
  }
  for (let i = 0; i < rest.length; i += 2) {
    const [key, value] = [rest[i], rest[i + 1]]
    if (!keys[key] || !value || value.startsWith('--') || (key !== '--patch' && seen.has(key))) throw new Error('Invalid or duplicate argument')
    seen.add(key)
    if (key === '--patch') options.patches.push(value)
    else options[keys[key]] = value
  }
  for (const [flag, key] of Object.entries(keys)) if (flag !== '--patch' && !options[key]) throw new Error('Missing ' + flag)
  if (mode === 'prepare') console.log(JSON.stringify(await prepareProfile(options)))
  else {
    const result = await verifyProfile(options.planPath)
    console.log(JSON.stringify({ status: 'configuration-verified-not-activated', version: result.plan.version,
      sharedHostPeers: Object.keys(result.peers).length, idleVerified: false, browserVerified: false }))
  }
}
try { await main(process.argv.slice(2)) }
catch (error) { console.error(String(error.message)); process.exitCode = 1 }
