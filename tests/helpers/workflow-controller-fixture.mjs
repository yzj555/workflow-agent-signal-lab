import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowJournal } from '../../lib/workflow-journal.js'
import { WorkflowTextArtifacts, WorkflowTextController, CONFIRM_LABEL } from '../../lib/workflow-control.js'
import { memoryTable } from './workflow-fixture.mjs'

export const signal = new AbortController().signal
export const proposal = expectedRevision => ({
  expectedRevision, kind: 'text-deliverable', title: '测试：写一则简短公告', goal: '生成一则说明测试功能的公告',
  inScope: ['简短中文公告'], outOfScope: ['运行程序', '发布公告'], constraints: ['纯文本'], assumptions: [],
  unresolvedQuestions: [], criteria: ['包含“测试”两个字', '不超过三十个字'],
})
export const reportQA = (pass = true) => ({ role: 'acceptance_qa', results: [
  { criterionId: 'AC-1', status: pass ? 'PASS' : 'FAIL', observation: pass ? '当前文本含“测试”' : '当前文本缺少“测试”' },
  { criterionId: 'AC-2', status: 'PASS', observation: '当前文本共八个字，不超过三十字' },
] })

export async function controllerFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-controller-test-'))
  const artifacts = await WorkflowTextArtifacts.open(directory)
  const table = memoryTable()
  const journal = new WorkflowJournal(table)
  const root = { id: 'controller-root' }
  const live = new Map([[root.id, root]])
  const calls = [], questions = [], notices = []
  let controller
  const driver = {
    isRoot: agent => agent === root && live.get(agent.id) === agent,
    isLive: agent => live.get(agent.id) === agent,
    // This fixture is in-memory; native persistence is covered by the real Host tests.
    ensureRootDurable: options.ensureRootDurable ?? (async () => {}),
    async ask(agent, requested, signal) {
      const batch = [...requested]
      questions.push(...batch)
      if (options.ask) return options.ask(agent, batch.length === 1 ? batch[0] : batch, signal)
      return { answers: batch.map(question => ({ id: question.id, selected: [CONFIRM_LABEL] })) }
    },
    async start(parent, id, role, prompt, signal) {
      calls.push({ operation: 'start', id, role, prompt })
      if (options.start) await options.start({ parent, id, role, signal })
      signal.throwIfAborted()
      const child = { id }
      controller.bindChild(child)
      live.set(id, child)
    },
    async resume(parent, id, prompt, signal) {
      calls.push({ operation: 'resume', id, prompt })
      signal.throwIfAborted()
      const child = { id }
      controller.bindChild(child)
      live.set(id, child)
    },
    async drain(parent, ids) {
      calls.push({ operation: 'drain', ids })
      if (options.drain) await options.drain({ parent, ids })
      for (const id of ids) live.delete(id)
    },
    notify(parent, summary) { notices.push({ root: parent.id, summary, snapshot: journal.readSnapshot(parent.id) }) },
  }
  controller = new WorkflowTextController(journal, artifacts, driver, options.reportError, options.childConfig, options.childClock,
    options.commandConfig, { runBudgetEnabled: true, runBudgetScope: 'all', ...options.runBudgetConfig }, options.hostAdmissionConfig)
  controller.bindRoot(root)
  t.after(async () => { await controller.close(); await journal.close() })
  const snapshot = () => journal.readSnapshot(root.id)
  const revision = () => ({ expectedRevision: snapshot().revision })
  const setup = async () => {
    await controller.propose(root, proposal(snapshot().revision), signal)
    await controller.confirm(root, revision(), signal)
  }
  const advance = () => controller.advance(root, revision(), signal)
  const child = task => {
    const id = snapshot().run.agents.find(agent => agent.taskId === task)?.agentSessionId
    return live.get(id)
  }
  const settle = async agent => { live.delete(agent.id); await controller.settled(agent.id, true) }
  const author = async text => {
    await advance()
    const agent = child('author')
    await controller.report(agent, { role: 'engineer', text }, signal)
    await settle(agent)
    return agent.id
  }
  const qa = async pass => {
    await advance()
    const agent = child('acceptance')
    await controller.report(agent, reportQA(pass), signal)
    await settle(agent)
    return agent.id
  }
  return { controller, root, journal, table, artifacts, driver, directory, calls, questions, notices, live, snapshot, revision, setup, advance, child, settle, author, qa }
}
