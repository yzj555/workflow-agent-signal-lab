/**
 * Exercise the installed official DSH persistence stack with disposable data.
 * This probe does not register, patch, or whitelist a custom event type.
 * It never opens the user's profile, credentials, or existing Session logs.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseWorkflowEventData, WORKFLOW_SESSION_EVENT_TYPE } from '../lib/index.js'

const sourceArgument = process.argv[2] ?? process.env.DSH_SOURCE_ROOT
if (!sourceArgument) throw new Error('Usage: node scripts/probe-session-event-compat.mjs <DSH source root>')
const sourceRoot = resolve(sourceArgument)
const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const officialRequire = createRequire(join(sourceRoot, 'packages/session/session-persistence-jsonl/package.json'))
const importOfficial = specifier => import(pathToFileURL(officialRequire.resolve(specifier)).href)

const [cordis, sessions, jsonl, sqlite, projection] = await Promise.all([
  importOfficial('@deepseek-ai/cordis'),
  importOfficial('@deepseek-ai/dsh-session'),
  import(pathToFileURL(join(sourceRoot, 'packages/session/session-persistence-jsonl/lib/index.js')).href),
  import(pathToFileURL(join(sourceRoot, 'packages/session/session-persistence-sqlite/lib/index.js')).href),
  import(pathToFileURL(join(sourceRoot, 'packages/session/session-projection/lib/index.js')).href),
])
const manifest = JSON.parse(await readFile(join(sourceRoot, 'apps/cli/package.json'), 'utf8'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'workflow-session-compat-'))
const catalogKnowsEvent = sessions.KNOWN_SESSION_EVENT_TYPES.has(WORKFLOW_SESSION_EVENT_TYPE)

const definitions = [
  {
    name: 'JSONL',
    provider: jsonl.default,
    config: { root: join(temporaryRoot, 'jsonl'), compression: 'none' },
  },
  {
    name: 'SQLite',
    provider: sqlite.default,
    config: { path: join(temporaryRoot, 'sessions.sqlite'), journalMode: 'delete' },
  },
]

async function stack(definition) {
  const ctx = new cordis.Context()
  try {
    await ctx.plugin(sessions.default)
    await ctx.plugin(definition.provider, definition.config)
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

const results = []
for (const definition of definitions) {
  const writer = await stack(definition)
  const result = { backend: definition.name, append: false, flush: false, logOnly: false }
  try {
    const baseline = writer.sessions.create(sessions.SessionId('baseline'), { meta: { cwd: labRoot } })
    baseline.append('todo/write', { todos: [] })
    await writer.sessions.flush(baseline)

    const custom = writer.sessions.create(sessions.SessionId('custom-event'), { meta: { cwd: labRoot } })
    const data = parseWorkflowEventData({
      version: 1,
      runId: 'compatibility-probe',
      eventId: 'compatibility-event-1',
      name: 'run/created',
      actor: { kind: 'system', id: 'compatibility-probe' },
      payload: {
        presetId: 'workflow-agent-signal-lab',
        rootSessionId: custom.id,
        title: 'Disposable event compatibility probe',
      },
    })
    custom.append(WORKFLOW_SESSION_EVENT_TYPE, data)
    result.append = true
    result.logOnly = custom.deriveMessages().length === 0
    await writer.sessions.flush(custom)
    result.flush = true
  } finally {
    await writer.fiber.dispose()
  }

  const reader = await stack(definition)
  try {
    const baseline = await reader.sessionPersistence.load(sessions.SessionId('baseline'))
    result.baselineColdReload = baseline.events.length === 1 && baseline.events[0].type === 'todo/write'
    try {
      const custom = await reader.sessionPersistence.load(sessions.SessionId('custom-event'))
      result.customColdReload = { ok: true, eventCount: custom.events.length }
    } catch (error) {
      result.customColdReload = { ok: false, error: error.name, message: error.message }
    }
  } finally {
    await reader.fiber.dispose()
  }
  results.push(result)
}

// The official registry observes the synchronous append, before a writer can
// await flush. This is observation, not a durability acknowledgement.
const projectionContext = new cordis.Context()
let observedBeforeFlush = false
try {
  await projectionContext.plugin(sessions.default)
  await projectionContext.plugin(projection.default)
  const identitySchema = { parse: value => value }
  projectionContext.sessionProjections.register({
    key: 'workflowCompatibilityProbe',
    stateVersion: 1,
    stateSchema: identitySchema,
    init: () => null,
    apply: (state, event) => event.type === 'todo/write' ? event.data : state,
    wire: { viewSchema: identitySchema, view: state => state },
  })
  projectionContext.sessionProjections.onChanged(() => { observedBeforeFlush = true })
  const probe = projectionContext.sessions.create()
  probe.append('todo/write', { todos: [] })
} finally {
  await projectionContext.fiber.dispose()
}

const baselinePassed = results.every(item => item.append && item.flush && item.logOnly && item.baselineColdReload)
const customRestorable = results.every(item => item.customColdReload.ok)
console.log(JSON.stringify({
  status: baselinePassed && customRestorable ? 'SUPPORTED' : 'BLOCKED',
  dshVersion: manifest.version,
  sourceRoot,
  temporaryRoot,
  catalogKnowsEvent,
  projectionCanPublishBeforeFlush: observedBeforeFlush,
  results,
}, null, 2))

// A demonstrated unsupported feature is not a successful implementation.
if (!baselinePassed || !customRestorable) process.exitCode = 2
