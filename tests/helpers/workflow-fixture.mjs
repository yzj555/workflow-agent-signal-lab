export function fixture(rootSessionId = 'session-a', runId = 'run-a') {
  let id = 0
  const event = (name, payload, actor = { kind: 'pm', id: 'test-pm' }) => ({
    version: 1, runId, eventId: `${runId}-event-${++id}`, name, actor, payload,
  })
  const record = (kind, recordId, version, data) => ({
    schemaVersion: 1, kind, runId, recordId, version, createdAt: version, createdBy: 'test-pm', data,
    ...(version === 1 ? {} : { supersedes: { kind, recordId, version: version - 1 } }),
  })
  const requirement = (version = 1) => record('requirement', 'requirement', version, {
    goal: '交付文本规范化工具', inScope: ['转换文本'], outOfScope: ['网络服务'],
    constraints: ['仅测试数据'], assumptions: [], permissionBoundaries: ['不访问用户文档'],
    questions: [], acceptanceIds: ['AC-1'],
  })
  const acceptance = () => record('acceptance', 'acceptance', 1, {
    criteria: [{ id: 'AC-1', statement: '指定输入得到约定输出', criticality: 'hard',
      verifier: 'acceptance_qa', evidenceRequired: ['黑盒结果'] }],
    surface: '命令行工具', setup: [], forbiddenKnowledge: ['实现源码', '实现 Agent 对话'],
  })
  const refs = [
    { kind: 'requirement', recordId: 'requirement', version: 1 },
    { kind: 'acceptance', recordId: 'acceptance', version: 1 },
  ]
  const task = (taskId = 'normalize', role = 'engineer') => record('task', taskId, 1, {
    title: taskId === 'normalize' ? '实现文本转换' : '独立黑盒验收', goal: '满足验收合同',
    stage: role === 'engineer' ? 'implementation' : 'verification', role,
    riskLevel: 'L1', requiresActionGate: false, lifecycle: 'continuable',
    contextDomains: role === 'engineer' ? ['C0', 'C1', 'C2'] : ['C0', 'C3'],
    inScope: [taskId], outOfScope: ['范围外动作'], dependsOn: [], inputs: refs,
    allowedActions: ['处理测试数据'], forbiddenActions: ['访问范围外文件'], writeScopes: [`test/${taskId}`],
    acceptanceIds: ['AC-1'], outputContract: { artifacts: ['result'], evidence: ['验证结果'] },
  })
  const created = () => event('run/created', { presetId: 'workflow-agent-signal-lab', rootSessionId, title: '通用流程测试' })
  const publish = item => event('record/published', { record: item })
  const initial = () => [
    created(), publish(requirement()), publish(acceptance()),
    event('risk/classified', { level: 'L1', reasons: ['局部变更'], actionGateRequired: false, actionTypes: [] }),
    publish(task()),
    event('gate/requested', { gateId: 'signal', kind: 'signal', stage: 'requirements', summary: '确认合并需求',
      requiredActor: 'user', scopeTaskIds: [], inputRefs: refs }),
  ]
  const approve = () => event('gate/decided', { gateId: 'signal', decision: 'approved', reason: '测试用户明确同意' }, { kind: 'user', id: 'test-user' })
  const readyTask = () => event('task/status-changed', { taskId: 'normalize', taskVersion: 1, expectedStatus: 'pending', status: 'ready', reason: '任务已就绪' })
  const runTask = () => event('task/status-changed', { taskId: 'normalize', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '开始实现' })
  const assign = (taskId = 'normalize', role = 'engineer') => event('agent/assigned', {
    assignmentId: `assignment-${taskId}`, taskId, taskVersion: 1, agentSessionId: `child-${taskId}`, role,
    lifecycle: 'continuable', contextDomains: role === 'engineer' ? ['C0', 'C1', 'C2'] : ['C0', 'C3'],
  })
  return { rootSessionId, runId, event, created, requirement, acceptance, task, publish, initial, approve, readyTask, runTask, assign }
}

export function memoryTable() {
  const rows = new Map()
  return { rows, get: key => rows.get(key), entries: () => rows.entries(), put: async (key, value) => { rows.set(key, value) } }
}
