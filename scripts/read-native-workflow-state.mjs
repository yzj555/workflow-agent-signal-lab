/** Read one native DSH Session, its direct children and Workflow snapshot. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceRoot, baseUrl, launchLog, rootSessionId] = process.argv.slice(2)
const compact = process.argv.includes('--compact')
const includePlan = process.argv.includes('--plan')
const includeDesign = process.argv.includes('--design')
const includeDiagnostics = process.argv.includes('--diagnostics')
if (![sourceRoot, baseUrl, launchLog, rootSessionId].every(Boolean)) {
  throw new Error('usage: node scripts/read-native-workflow-state.mjs <DSH source> <URL> <launch log> <root Session id>')
}
const target = new URL(baseUrl)
assert.equal(target.hostname, '127.0.0.1', 'state reader is limited to local DSH')
const launchMatches = [...(await readFile(launchLog, 'utf8')).matchAll(/dsh web:\s+(http:\/\/\S+)/gu)]
assert.ok(launchMatches.length > 0, 'launch log does not contain a DSH web URL')
const navigationUrl = launchMatches.at(-1)[1]

const officialRequire = createRequire(join(resolve(sourceRoot), 'package.json'))
let playwrightPath
try { playwrightPath = officialRequire.resolve('playwright') }
catch { playwrightPath = join(resolve(sourceRoot), 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs') }
const { chromium } = await import(pathToFileURL(playwrightPath).href)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const navigation = await page.goto(navigationUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert.equal(navigation?.status(), 200, 'authenticated DSH navigation failed')
  const state = await page.evaluate(async rootSessionId => {
    const rpc = async (path, method, payload) => {
      const rpcId = crypto.randomUUID()
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      })
      if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`${method} returned an invalid RPC envelope`)
      if (envelope.result?.ok !== true) throw new Error(envelope.result?.error?.message ?? `${method} failed`)
      return envelope.result.value
    }
    const sessions = await rpc('/api/session/list', 'session/list', { args: { _request: {} } })
    const children = await rpc('/api/subagents/list', 'subagents/list', { args: { parentSessionId: rootSessionId } })
    const workflow = await rpc('/workflow-runtime/snapshot', 'snapshot', { schemaVersion: 1, rootSessionId })
    return {
      root: sessions.items.find(item => item.sessionId === rootSessionId) ?? null,
      children,
      workflow,
    }
  }, rootSessionId)
  const output = compact ? {
    root: state.root === null ? null : {
      sessionId: state.root.sessionId,
      running: state.root.running,
      updatedAt: state.root.updatedAt,
      asOfSeq: state.root.projections?.asOfSeq ?? null,
      title: state.root.projections?.values?.title ?? null,
      agentPreset: state.root.projections?.values?.agentPreset ?? null,
      response: state.root.projections?.values?.turnOutline?.at(-1)?.response ?? null,
      ...(includeDiagnostics ? {
        projectionKeys: Object.keys(state.root.projections?.values ?? {}).sort(),
        turnBoundary: state.root.projections?.values?.turnBoundary ?? null,
        inbox: state.root.projections?.values?.inbox ?? null,
        lastTurn: state.root.projections?.values?.turnOutline?.at(-1) ?? null,
      } : {}),
    },
    children: state.children.entries,
    workflow: {
      availability: state.workflow.availability,
      revision: state.workflow.revision,
      preRunRecovery: state.workflow.preRunRecovery ?? null,
      run: state.workflow.run === null ? null : {
        runId: state.workflow.run.runId,
        stage: state.workflow.run.stage,
        outcome: state.workflow.run.outcome,
        needsUser: state.workflow.run.needsUser,
        gates: state.workflow.run.gates.map(gate => ({ kind: gate.kind, status: gate.status, stale: gate.stale })),
        tasks: state.workflow.run.tasks.map(task => ({ taskId: task.taskId, role: task.role, status: task.status, stale: task.stale })),
        agents: state.workflow.run.agents.map(agent => ({ taskId: agent.taskId, role: agent.role, status: agent.status,
          ...(agent.runtimeIssue ? { runtimeIssue: agent.runtimeIssue } : {}) })),
        ledger: state.workflow.run.ledger,
        latestReturn: state.workflow.run.latestReturn,
        learning: {
          reviewed: state.workflow.run.learning.reviewed,
          decisionRecorded: state.workflow.run.learning.decisionRecorded,
          applied: state.workflow.run.learning.applied,
          candidateStatuses: state.workflow.run.learning.candidates.map(item => ({ id: item.id, status: item.status })),
        },
        ...(includePlan ? { plan: state.workflow.run.plan ?? null } : {}),
        ...(includeDesign ? { planAudit: state.workflow.run.plan === undefined ? null : {
          requirementVersion: state.workflow.run.plan.requirementVersion,
          workspaceRoot: state.workflow.run.plan.workspaceRoot,
          goal: state.workflow.run.plan.goal,
          inScope: state.workflow.run.plan.inScope,
          outOfScope: state.workflow.run.plan.outOfScope,
          writeScopes: state.workflow.run.plan.writeScopes,
          criteria: state.workflow.run.plan.criteria,
          engineeringChecks: state.workflow.run.plan.engineeringChecks,
          acceptanceChecks: state.workflow.run.plan.acceptanceChecks,
          design: state.workflow.run.plan.design,
        } } : {}),
      },
    },
  } : state
  console.log(JSON.stringify(output, null, 2))
} finally {
  await browser.close()
}
