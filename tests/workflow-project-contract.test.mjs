import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROJECT_PILOT,
  foldWorkflowRun,
  guardProjectTool,
  isSupportedL1Command,
  planTaskWaves,
  projectContract,
  projectRecords,
  projectRequirementConfirmationCard,
} from '../lib/index.js'

const workspace = 'C:\\work\\project'
const proposal = (changeClass = 'architecture') => ({
  expectedRevision: 0,
  kind: 'project-change',
  title: '工程合同测试',
  goal: '在现有项目中实现并验证一个局部功能',
  changeClass,
  inScope: ['应用源码与单元测试'],
  outOfScope: ['部署与外部系统操作'],
  constraints: ['不安装依赖'],
  assumptions: [],
  unresolvedQuestions: [],
  writeScopes: ['src', 'tests/unit.test.ts'],
  engineeringChecks: [{ id: 'ENG-1', command: 'npm run typecheck', workdir: '.', purpose: '执行类型检查' }],
  acceptanceChecks: [{ id: 'ACC-1', command: 'npm test', workdir: '.', purpose: '执行黑盒验收' }],
  criteria: [{ statement: '当前测试全部通过', checkIds: ['ACC-1'] }],
})

function stateFrom(records) {
  const runId = 'project-run'
  const events = [{
    type: 'workflow/event', seq: 1, time: 1,
    data: { version: 1, runId, eventId: 'created', name: 'run/created', actor: { kind: 'pm', id: 'root' },
      payload: { presetId: 'workflow-agent-signal-lab', rootSessionId: 'root', title: '工程合同测试' } },
  }, ...records.map((record, index) => ({
    type: 'workflow/event', seq: index + 2, time: index + 2,
    data: { version: 1, runId, eventId: `record-${index}`, name: 'record/published', actor: { kind: 'pm', id: 'root' }, payload: { record } },
  }))]
  return foldWorkflowRun(runId, events)
}

test('project contract compiles architecture, implementation, parallel checks and isolated acceptance', () => {
  const records = projectRecords(proposal(), 'project-run', 'root', workspace)
  const contract = projectContract(stateFrom(records), workspace)
  assert.equal(contract.profile, PROJECT_PILOT)
  assert.deepEqual(planTaskWaves(contract.tasks), [
    ['architecture'],
    ['implementation'],
    ['code-review', 'engineering-test'],
    ['acceptance'],
  ])
  assert.equal(contract.qa.data.role, 'acceptance_qa')
  assert.equal(contract.qa.data.allowedActions.some(action => action.includes('ACC-1')), true)
  assert.equal(contract.qa.data.forbiddenActions.includes('读取或检索源码'), true)
  assert.equal(contract.implementation.data.allowedActions.some(action => action.includes('ENG-1')), false)
  assert.ok(contract.implementation.data.forbiddenActions.some(action => action.includes('独立工程测试 Agent')))
})

test('localized project changes omit the architecture task without changing downstream isolation', () => {
  const records = projectRecords(proposal('localized'), 'project-run', 'root', workspace)
  const contract = projectContract(stateFrom(records), workspace)
  assert.equal(contract.architecture, undefined)
  assert.deepEqual(planTaskWaves(contract.tasks), [
    ['implementation'],
    ['code-review', 'engineering-test'],
    ['acceptance'],
  ])
})

test('cross-module project changes use the layered read-only planning route', () => {
  const records = projectRecords(proposal('cross-module'), 'project-run', 'root', workspace)
  const contract = projectContract(stateFrom(records), workspace)
  assert.equal(contract.architecture?.data.role, 'architect')
  assert.match(contract.architecture?.data.title ?? '', /跨模块影响/)
  assert.deepEqual(planTaskWaves(contract.tasks), [
    ['architecture'],
    ['implementation'],
    ['code-review', 'engineering-test'],
    ['acceptance'],
  ])
})

test('L1 command grammar rejects composition, installs, servers and process control', () => {
  assert.equal(isSupportedL1Command('python -m unittest discover -s tests -v'), true)
  assert.equal(isSupportedL1Command('npm run typecheck'), true)
  for (const command of [
    'npm install',
    'npm test; Remove-Item x',
    'python -c print(1)',
    'pwsh -File build.ps1',
    'taskkill /PID 4 /F',
    'npm start',
  ]) assert.equal(isSupportedL1Command(command), false, command)
  for (const command of [
    'node --test C:\\outside\\test.mjs',
    'pytest ../outside',
    'npm test -- --config=../outside.json',
    'npm test -- --config=C:\\outside\\config.json',
    'npm test -- --config=/outside/config.json',
    'npm test -- --workspace=src/../../outside',
  ]) assert.equal(isSupportedL1Command(command), false, command)
})

test('task guard permits only role tools, workspace scopes and frozen foreground checks', () => {
  const contract = projectContract(stateFrom(projectRecords(proposal('localized'), 'project-run', 'root', workspace)), workspace)
  const engineer = contract.implementation
  assert.equal(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'read', { file_path: 'src/a.ts' }, workspace), undefined)
  assert.equal(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'write', { file_path: 'src/a.ts', content: 'x' }, workspace), undefined)
  assert.match(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'write', { file_path: 'README.md', content: 'x' }, workspace), /写入目标/)
  assert.match(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'read', { file_path: '..\\secret.txt' }, workspace), /离开/)
  assert.match(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'pwsh', {
    command: 'npm run typecheck', description: 'Run project typecheck', workdir: '.', timeoutMs: 60_000,
  }, workspace), /无权/)
  assert.match(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'pwsh', {
    command: 'npm test; Remove-Item x', description: 'Bypass contract', workdir: '.',
  }, workspace), /无权/)
  assert.match(guardProjectTool(engineer, contract.engineeringChecks, workspace, 'pwsh', {
    command: 'npm run typecheck', description: 'Escalate project command', workdir: '.', sandbox_permissions: 'danger-full-access', justification: 'need it',
  }, workspace), /无权/)

  const qa = contract.qa
  assert.match(guardProjectTool(qa, contract.acceptanceChecks, workspace, 'read', { file_path: 'src/a.ts' }, workspace), /无权/)
  assert.match(guardProjectTool(qa, contract.acceptanceChecks, workspace, 'grep', { pattern: 'secret' }, workspace), /无权/)
  assert.equal(guardProjectTool(qa, contract.acceptanceChecks, workspace, 'pwsh', {
    command: 'npm test', description: 'Run black box tests', workdir: '.',
  }, workspace), undefined)
})

test('a recorded rule decoration reaches the first project gate without its rule identity', () => {
  const ruleId = 'learning-4a7b6c5d-1111-4222-8333-444455556666'
  const decoration = `【已确认历史规则 ${ruleId}@v2 · 当前项目】公告必须保留一条可复核的独立验收证据。`
  const records = projectRecords(
    { ...proposal('cross-module'), constraints: [decoration] },
    'project-run', 'root', workspace,
  )
  const state = stateFrom(records)
  const card = projectRequirementConfirmationCard(state, workspace, 1)
  assert.ok(card.detail.includes('独立验收证据'), 'the recorded rule text must stay visible')
  assert.match(card.detail, /【已确认历史规则 · 当前项目】/)
  assert.doesNotMatch(card.detail, new RegExp(ruleId))
  assert.doesNotMatch(card.detail, /@v\d/u)
  assert.ok(state.records['requirement:requirement'].data.constraints.some(item => item.includes(ruleId)))
})
