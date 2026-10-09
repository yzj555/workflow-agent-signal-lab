# Workflow Agent — release candidate

Windows x64 / DSH 0.2.0-rc.2 / supervised local L0 text and L1 project work only.
This is an **unactivated candidate**, not Production v1 approval. Gates C/D/E
and the project owner's licensing/publication decision remain open.

This RC.12 candidate pins the complete reviewed 0.2.0-rc.2 SDK graph. RC.7 is a
separate legacy artifact for 0.1.5-rc.1, not a fallback for a newer Host without
its own compatibility proof. This bundle has four initially disabled rows,
including the official declarative preset. It does not append directory roots
or change registry defaults. Startup checks
identity and claims one owner first, then initializes Journal/controller for
a preset-subtree audit. Workflow roots and UI remain closed until that audit
passes; failure closes the runtime and releases the owner. Clean-source type
checks, builds and full regression establish a candidate artifact, not an
accepted installation. Installed startup, Web and maintenance acceptance on
this exact archive are still required. Do not retarget a legacy archive or
treat a passing build as production approval.

## Installation and activation are separate

After checking the tarball digest against its build receipt, install the
prebuilt `.tgz` with the official `dsh plugin --profile <name> add <absolute-tgz>`
command. It needs no build scripts. Do not install into a running Profile.
DSH uses pnpm; its ordinary internal package-store links are not links to this
project's development checkout.

All four bundle rows are deliberately disabled. Nothing copies credentials,
rewrites the default Agent, selects a workspace, takes over a writer, enables
budgets on old runs, or imports/migrates native Session history on install.
For a fresh, installed Profile, `node scripts/configure-workflow.mjs --help`
describes how to prepare a separate enable overlay. The Profile must explicitly
disable every `@deepseek-ai/dsh-hmr` row in its existing composition while
offline, preserving unrelated fields. SDK2 no longer reads the legacy
`dsh.profile.patchReload` field; writing `startup` there does not turn off live
reload. The tool refuses active or unevaluated HMR rather than silently changing
that policy or hiding new settings behind a frozen overlay. The guard also
checks that no HMR service is actually provided. It preserves the complete
preset-registry configuration, enables this package's official declaration plus
a startup guard and UI/runtime, and requires an explicit new private data
directory and resource-policy choice. It writes only a new output directory;
it does not install, edit existing Profile files or launch DSH. The guard
checks the declared installed Host, payload, composition and shared module
identity before opening storage under the exclusive owner. After controller
initialization it checks the declaration and its preset subtree; workflow
roots and UI remain closed until this second phase succeeds. Start with
the same DSH_HOME, installed Host and existing ordered overlays, adding the
generated --patch last. Omit it after an idle shutdown to disable. Changing
the source composition invalidates the prepared overlay instead of silently
replacing newer settings. Existing runtime data and custom dynamic root
expressions need separate upgrade/manual review. Full Web acceptance and the
upgrade/disable/rollback rehearsal must still pass before production approval;
do not treat `dsh plugin add` alone as a usable production setup.

The native input box remains the only primary conversation surface. Selecting
the Workflow Agent preset opts into its workflow; installation never guesses
from the user's text or automatically selects it.

## Data and rollback

Plugin binaries, native DSH Sessions, the workflow Journal and workspace files
are separate data sets. Uninstall must not delete any of the latter three.
Before an upgrade, verify no active work, back up each data set, and test the
exact new reader against an isolated copy. Old native formats may be unreadable
even when Journal replay succeeds. A rollback is allowed only after proving
the target code can read the current data; never restore an old database over
newer records to make an old binary boot. Unknown execution remains unknown.

For existing data, `node scripts/transition-workflow.mjs --help` describes a
two-step offline capture and configuration preparation flow. It takes the
normal exclusive writer while copying/replaying data, never reclaims an old
owner, and never installs, launches or restores a database. Startup checks the
current data again and transfers that same owner to storage without a gap.
The checkpoint and archived package are private. Rollback needs a fresh capture
of CURRENT data and an exact archived target, not the pre-upgrade database.
Targets must implement `transitionProtocol: 1`; older RCs may be upgrade sources
but are not silently accepted as rollback destinations. Keep the transition
utility from the newer verified archive available during an offline rollback.

`release-manifest.json` identifies payload hashes and source/lock inputs.
`resource-policy.json` is a candidate, **not loaded configuration**. The offline
diagnostic is `node scripts/diagnose-workflow.mjs --help`; it uses explicit
read-only copies and requires new output files. Do not export private maps,
databases, credentials or raw Sessions as public evidence.

## Native capture: bounded visible-session observations

`node scripts/capture-workflow-native.mjs --help` is the packaged native capture
entry point. It selects the exact expected contract from this package's peers;
that metadata does not verify the running Host's version. For 0.2 it reads
session/control, non-activating session/projections and each observed Session's
non-consuming job/list twice. It retains only pending-input counts, active/total
job counts and change fingerprints, not prompts, labels, details or output.
Missing, rejected, incompatible or changing evidence is incomplete, never idle.
No Session available for a fenced job read is also incomplete, not an empty
unowned bucket. Installed acceptance of this exact candidate remains required.
Supply a stable private startup-log copy containing this Host's
official `dsh web: http://127.0.0.1:PORT/?token=...` URL and a new absolute private
output path. It exchanges that URL through the official login route, then reads
only session/list, recursively observed Session catalogue projections (legacy:
subagents/list) and the contract-specific observation
interfaces described above. It needs neither a source checkout nor a browser. It does not read
signing secrets, send prompts, cancel Agents, repair records or follow redirects.
Only literal loopback HTTP is supported. Limits: 1 MiB startup log, 8 MiB per
response/output, 256 MiB total traffic, 5000 listed Sessions, 10000 catalogue
entries, 15000 residents/observation targets, 15000 job rows per Session,
15 seconds per request and 120 seconds overall.
Exit 0 means no activity observed in this bounded capture, 2 means activity or
unclassified residents were observed, 3 means incomplete, and 1 means the call
or export failed. Only jobs visible to the observed Session ids are covered;
unknown owners outside that set are not a whole-Host inventory. Neither two
stable reads nor a terminal job status proves OS process exit, historical readability, business
acceptance, or permission to restart. Feed this PRIVATE JSON into the offline
diagnostic's --native option; only its redacted report is intended for sharing.
Malformed/incompatible or changing observations are incomplete, not empty.

This candidate's compatibility baseline is the complete pinned DSH 0.2.0-rc.2
component set, not just a matching CLI version. Verify actual installed module
identity and plugin composition before activation. Current production-Profile
strategy is a separate installation with independent data; preserve all old
experimental Profiles and archives. This artifact does not create that Profile
or migrate its history.

Upstream installation contract:
https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/user/develop/basic/publish.md

Third-party notices are included separately; no
license for this project's original code has been granted by this candidate.
