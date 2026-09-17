import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyWorkflowStoredEvent,
  emptyWorkflowRunState,
  parseWorkflowEventData,
  parseWorkflowRecord,
  planTaskWaves,
  PROJECT_PILOT,
  summarizeAcceptanceLedger,
} from '../lib/index.js'

const runId = 'run-contract-1'

function versioned(kind, recordId, version, data) {
  return {
    schemaVersion: 1,
    kind,
    runId,
    recordId,
    version,
    createdAt: version,
    createdBy: 'pm',
    ...(version === 1 ? {} : { supersedes: { kind, recordId, version: version - 1 } }),
    data,
  }
}

function requirement(version = 1, questions = []) {
  return versioned('requirement', 'requirements', version, {
    goal: '交付一个可验证的小工具',
    inScope: ['查询端口占用'],
    outOfScope: ['部署到生产环境'],
    constraints: ['Windows'],
    assumptions: [],
    permissionBoundaries: ['结束进程前需要明确确认'],
    questions,
    acceptanceIds: ['AC-1'],
  })
}

function acceptance(version = 1) {
  return versioned('acceptance', 'acceptance', version, {
    criteria: [{
      id: 'AC-1',
      statement: '可查询指定端口的占用进程',
      criticality: 'hard',
      verifier: 'acceptance_qa',
      evidenceRequired: ['黑盒查询结果'],
    }],
    surface: 'Windows 桌面程序',
    setup: [],
    forbiddenKnowledge: ['源代码', '实现 Agent 对话'],
  })
}

function taskBrief(id, options = {}) {
  const version = options.version ?? 1
  return versioned('task', id, version, {
    title: options.title ?? id,
    goal: options.goal ?? `完成 ${id}`,
    stage: options.stage ?? 'implementation',
    role: options.role ?? 'engineer',
    riskLevel: options.riskLevel ?? 'L1',
    requiresActionGate: options.requiresActionGate ?? false,
    lifecycle: options.lifecycle ?? 'continuable',
    contextDomains: options.contextDomains ?? ['C0', 'C1', 'C2'],
    inScope: options.inScope ?? [id],
    outOfScope: options.outOfScope ?? ['未确认范围'],
    dependsOn: options.dependsOn ?? [],
    inputs: options.inputs ?? [
      { kind: 'requirement', recordId: 'requirements', version: 1 },
      { kind: 'acceptance', recordId: 'acceptance', version: 1 },
    ],
    allowedActions: options.allowedActions ?? ['修改任务写入范围'],
    forbiddenActions: options.forbiddenActions ?? ['修改范围外文件'],
    writeScopes: options.writeScopes ?? [`src/${id}`],
    acceptanceIds: options.acceptanceIds ?? ['AC-1'],
    outputContract: options.outputContract ?? {
      artifacts: [`artifact-${id}`],
      evidence: ['变更摘要与验证结果'],
    },
  })
}

function stream() {
  let seq = 0
  let eventNumber = 0
  return (name, payload, actor = { kind: 'pm', id: 'pm' }) => ({
    type: 'workflow/event',
    seq: seq++,
    time: 1000 + seq,
    data: {
      version: 1,
      runId,
      eventId: `event-${++eventNumber}`,
      name,
      actor,
      payload,
    },
  })
}

function created(emit) {
  return emit('run/created', {
    presetId: 'workflow-agent-signal-lab',
    rootSessionId: 'root-session',
    title: '协议测试',
  })
}

function publish(emit, record) {
  return emit('record/published', { record })
}

function establishSignal(state, emit) {
  state = applyWorkflowStoredEvent(state, publish(emit, requirement()))
  state = applyWorkflowStoredEvent(state, publish(emit, acceptance()))
  state = applyWorkflowStoredEvent(state, emit('gate/requested', {
    gateId: 'signal-1',
    kind: 'signal',
    stage: 'requirements',
    summary: '确认目标、边界和验收标准',
    requiredActor: 'user',
    scopeTaskIds: [],
    inputRefs: [
      { kind: 'requirement', recordId: 'requirements', version: 1 },
      { kind: 'acceptance', recordId: 'acceptance', version: 1 },
    ],
  }))
  state = applyWorkflowStoredEvent(state, emit('gate/decided', {
    gateId: 'signal-1',
    decision: 'approved',
    reason: '用户确认',
  }, { kind: 'user', id: 'user' }))
  state = applyWorkflowStoredEvent(state, emit('risk/classified', {
    level: 'L1',
    reasons: ['单模块、可回滚'],
    actionGateRequired: false,
    actionTypes: [],
  }))
  return state
}

test('versioned records reject undeclared fields and broken ancestry', () => {
  assert.equal(parseWorkflowRecord(requirement()).kind, 'requirement')
  assert.throws(
    () => parseWorkflowRecord({ ...requirement(), surprise: true }),
    /is not a declared field/,
  )
  assert.throws(
    () => parseWorkflowRecord({ ...requirement(2), supersedes: { kind: 'requirement', recordId: 'another-record', version: 1 } }),
    /immediately preceding version/,
  )
})

test('task graph returns deterministic serial and parallel waves', () => {
  const researchA = parseWorkflowRecord(taskBrief('research-a', { stage: 'planning', role: 'researcher', dependsOn: [] }))
  const researchB = parseWorkflowRecord(taskBrief('research-b', { stage: 'planning', role: 'researcher', dependsOn: [] }))
  const implementation = parseWorkflowRecord(taskBrief('implementation', { dependsOn: ['research-a', 'research-b'] }))
  assert.deepEqual(planTaskWaves([researchB, implementation, researchA]), [
    ['research-a', 'research-b'],
    ['implementation'],
  ])

  const cyclicA = parseWorkflowRecord(taskBrief('cyclic-a', { dependsOn: ['cyclic-b'] }))
  const cyclicB = parseWorkflowRecord(taskBrief('cyclic-b', { dependsOn: ['cyclic-a'] }))
  assert.throws(() => planTaskWaves([cyclicA, cyclicB]), /contains a cycle/)
})

test('Signal Gate blocks implementation until the merged contract is explicitly approved', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = applyWorkflowStoredEvent(state, publish(emit, requirement()))
  state = applyWorkflowStoredEvent(state, publish(emit, acceptance()))
  state = applyWorkflowStoredEvent(state, emit('risk/classified', {
    level: 'L1', reasons: ['局部变更'], actionGateRequired: false, actionTypes: [],
  }))
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('implementation')))
  state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'implementation', taskVersion: 1, expectedStatus: 'pending', status: 'ready', reason: '依赖已满足',
  }))
  const beforeGate = state
  assert.throws(() => applyWorkflowStoredEvent(beforeGate, emit('task/status-changed', {
    taskId: 'implementation', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '开始实现',
  })), /before Signal Gate approval/)

  state = applyWorkflowStoredEvent(state, emit('gate/requested', {
    gateId: 'signal-1', kind: 'signal', stage: 'requirements', summary: '请确认', requiredActor: 'user', scopeTaskIds: [],
    inputRefs: [
      { kind: 'requirement', recordId: 'requirements', version: 1 },
      { kind: 'acceptance', recordId: 'acceptance', version: 1 },
    ],
  }))
  state = applyWorkflowStoredEvent(state, emit('gate/decided', {
    gateId: 'signal-1', decision: 'approved', reason: '确认',
  }, { kind: 'user', id: 'user' }))
  state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'implementation', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '开始实现',
  }))
  assert.equal(state.tasks.implementation.status, 'running')
})

test('legacy project Signal Gate compatibility requires explicit executable task scope', () => {
  const prepare = scopeTaskIds => {
    const emit = stream()
    let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
    state = applyWorkflowStoredEvent(state, publish(emit, requirement()))
    state = applyWorkflowStoredEvent(state, publish(emit, acceptance()))
    state = applyWorkflowStoredEvent(state, emit('risk/classified', {
      level: 'L1', reasons: ['局部工程变更'], actionGateRequired: false, actionTypes: [],
    }))
    state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('implementation', {
      outputContract: { artifacts: ['workspace-file'], evidence: ['Host 文件摘要'], reportSchema: PROJECT_PILOT },
    })))
    state = applyWorkflowStoredEvent(state, emit('gate/requested', {
      gateId: 'legacy-signal', kind: 'signal', stage: 'requirements', summary: '旧版工程执行确认',
      requiredActor: 'user', scopeTaskIds,
      inputRefs: [
        { kind: 'requirement', recordId: 'requirements', version: 1 },
        { kind: 'acceptance', recordId: 'acceptance', version: 1 },
      ],
    }))
    state = applyWorkflowStoredEvent(state, emit('gate/decided', {
      gateId: 'legacy-signal', decision: 'approved', reason: '旧版用户确认',
    }, { kind: 'user', id: 'user' }))
    state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
      taskId: 'implementation', taskVersion: 1, expectedStatus: 'pending', status: 'ready', reason: '依赖已满足',
    }))
    return { emit, state }
  }

  const legacy = prepare(['implementation'])
  const admitted = applyWorkflowStoredEvent(legacy.state, legacy.emit('task/status-changed', {
    taskId: 'implementation', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '重放旧版执行',
  }))
  assert.equal(admitted.tasks.implementation.status, 'running')

  const layered = prepare(['architecture'])
  assert.throws(() => applyWorkflowStoredEvent(layered.state, layered.emit('task/status-changed', {
    taskId: 'implementation', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '不得越过第二道门禁',
  })), /before execution gate approval/)
})

test('Signal Gate fails closed while a material question is unresolved', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = applyWorkflowStoredEvent(state, publish(emit, requirement(1, [{
    id: 'Q-1', question: '是否允许结束系统进程？', material: true, status: 'open',
  }])))
  state = applyWorkflowStoredEvent(state, publish(emit, acceptance()))
  state = applyWorkflowStoredEvent(state, emit('gate/requested', {
    gateId: 'signal-1', kind: 'signal', stage: 'requirements', summary: '请确认', requiredActor: 'user', scopeTaskIds: [],
    inputRefs: [
      { kind: 'requirement', recordId: 'requirements', version: 1 },
      { kind: 'acceptance', recordId: 'acceptance', version: 1 },
    ],
  }))
  assert.throws(() => applyWorkflowStoredEvent(state, emit('gate/decided', {
    gateId: 'signal-1', decision: 'approved', reason: '确认',
  }, { kind: 'user', id: 'user' })), /unresolved material questions: Q-1/)
})

test('a revised snapshot invalidates only task packets that consumed it', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = establishSignal(state, emit)
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('uses-requirement')))
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('acceptance-only', {
    inputs: [{ kind: 'acceptance', recordId: 'acceptance', version: 1 }],
  })))
  state = applyWorkflowStoredEvent(state, publish(emit, requirement(2)))
  assert.deepEqual(state.staleTaskIds, ['uses-requirement'])
  assert.deepEqual(state.staleGateIds, ['signal-1'])
  assert.equal(state.tasks['acceptance-only'].status, 'pending')
})

test('X action gates are scoped to the dangerous task instead of freezing safe parallel work', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = establishSignal(state, emit)
  state = applyWorkflowStoredEvent(state, emit('risk/classified', {
    level: 'L2',
    reasons: ['包含一个结束真实进程的动作'],
    actionGateRequired: true,
    actionTypes: ['end-process'],
  }))
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('safe-query', { riskLevel: 'L2' })))
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('end-process', {
    riskLevel: 'L2',
    requiresActionGate: true,
  })))
  state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'safe-query', taskVersion: 1, expectedStatus: 'pending', status: 'ready', reason: '可安全执行',
  }))
  state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'end-process', taskVersion: 1, expectedStatus: 'pending', status: 'ready', reason: '等待即时确认',
  }))
  state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'safe-query', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '查询可以继续',
  }))
  assert.equal(state.tasks['safe-query'].status, 'running')
  assert.throws(() => applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'end-process', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '试图结束进程',
  })), /requires an approved action gate/)

  state = applyWorkflowStoredEvent(state, emit('gate/requested', {
    gateId: 'action-end-process',
    kind: 'action',
    stage: 'implementation',
    summary: '即将结束真实进程',
    requiredActor: 'user',
    scopeTaskIds: ['end-process'],
    inputRefs: [{ kind: 'task', recordId: 'end-process', version: 1 }],
  }))
  state = applyWorkflowStoredEvent(state, emit('gate/decided', {
    gateId: 'action-end-process', decision: 'approved', reason: '用户确认本次执行',
  }, { kind: 'user', id: 'user' }))
  state = applyWorkflowStoredEvent(state, emit('task/status-changed', {
    taskId: 'end-process', taskVersion: 1, expectedStatus: 'ready', status: 'running', reason: '执行已确认动作',
  }))
  assert.equal(state.tasks['end-process'].status, 'running')
})

test('continuation keeps the same agent only while role and context domain stay unchanged', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = establishSignal(state, emit)
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('implementation')))
  state = applyWorkflowStoredEvent(state, emit('agent/assigned', {
    assignmentId: 'assignment-1',
    taskId: 'implementation',
    taskVersion: 1,
    agentSessionId: 'child-1',
    role: 'engineer',
    lifecycle: 'continuable',
    contextDomains: ['C0', 'C1', 'C2'],
  }))
  state = applyWorkflowStoredEvent(state, emit('agent/settled', {
    assignmentId: 'assignment-1', outcome: 'completed', summary: '第一阶段完成',
  }))
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('implementation', { version: 2 })))
  state = applyWorkflowStoredEvent(state, emit('agent/resumed', {
    assignmentId: 'assignment-1', taskVersion: 2, reason: '同职责返工',
  }))
  assert.equal(state.assignments['assignment-1'].agentSessionId, 'child-1')
  assert.equal(state.assignments['assignment-1'].status, 'running')

  state = applyWorkflowStoredEvent(state, emit('agent/settled', {
    assignmentId: 'assignment-1', outcome: 'completed', summary: '返工完成',
  }))
  state = applyWorkflowStoredEvent(state, publish(emit, taskBrief('implementation', {
    version: 3,
    role: 'architect',
  })))
  assert.throws(() => applyWorkflowStoredEvent(state, emit('agent/resumed', {
    assignmentId: 'assignment-1', taskVersion: 3, reason: '试图跨角色继续',
  })), /cannot cross role or context domain boundaries/)
})

test('WAIVED is an explicit user decision and produces QUALIFIED, never PASS', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = establishSignal(state, emit)
  state = applyWorkflowStoredEvent(state, emit('evidence/recorded', {
    evidence: {
      evidenceId: 'evidence-1',
      kind: 'product',
      verdict: 'fail',
      summary: '视觉验收存在已知偏差',
      producedBy: 'acceptance-qa',
      acceptanceId: 'AC-1',
      artifactRefs: [],
    },
  }, { kind: 'agent', id: 'qa-child', role: 'acceptance_qa' }))

  const waiver = {
    result: {
      criterionId: 'AC-1',
      briefVersion: 1,
      status: 'WAIVED',
      evidenceIds: ['evidence-1'],
      rationale: '用户接受本轮偏差',
      userApprovalRef: 'user-message-42',
    },
  }
  assert.throws(() => applyWorkflowStoredEvent(state, emit('acceptance/recorded', waiver, {
    kind: 'agent', id: 'qa-child', role: 'acceptance_qa',
  })), /explicit user decision/)
  state = applyWorkflowStoredEvent(state, emit('acceptance/recorded', waiver, { kind: 'user', id: 'user' }))
  assert.deepEqual(summarizeAcceptanceLedger(acceptance(), state.acceptance), {
    pass: 0, fail: 0, waived: 1, pending: 0, hardOutcome: 'QUALIFIED',
  })
  state = applyWorkflowStoredEvent(state, publish(emit, acceptance(2)))
  assert.deepEqual(summarizeAcceptanceLedger(acceptance(2), state.acceptance), {
    pass: 0, fail: 0, waived: 0, pending: 1, hardOutcome: 'PENDING',
  })
})

test('risk classification may escalate but cannot silently downgrade or remove X actions', () => {
  const emit = stream()
  let state = applyWorkflowStoredEvent(emptyWorkflowRunState(runId), created(emit))
  state = applyWorkflowStoredEvent(state, emit('risk/classified', {
    level: 'L2', reasons: ['用户可见变更'], actionGateRequired: true, actionTypes: ['end-process'],
  }))
  assert.throws(() => applyWorkflowStoredEvent(state, emit('risk/classified', {
    level: 'L1', reasons: ['试图降级'], actionGateRequired: true, actionTypes: ['end-process'],
  })), /cannot be silently downgraded/)
  assert.throws(() => applyWorkflowStoredEvent(state, emit('risk/classified', {
    level: 'L2', reasons: ['试图删除 X 动作'], actionGateRequired: false, actionTypes: [],
  })), /X-action classification cannot be silently removed/)
})

test('persisted event versions and undeclared payload fields fail closed', () => {
  assert.throws(() => parseWorkflowEventData({
    version: 2,
    runId,
    eventId: 'event-1',
    name: 'run/created',
    actor: { kind: 'pm', id: 'pm' },
    payload: { presetId: 'preset', rootSessionId: 'root', title: 'title' },
  }), /unsupported version 2/)
  assert.throws(() => parseWorkflowEventData({
    version: 1,
    runId,
    eventId: 'event-1',
    name: 'run/created',
    actor: { kind: 'pm', id: 'pm' },
    payload: { presetId: 'preset', rootSessionId: 'root', title: 'title', hidden: true },
  }), /is not a declared field/)

  const selected = emptyWorkflowRunState(runId)
  const unrelatedFutureEvent = {
    type: 'workflow/event',
    seq: 0,
    time: 1,
    data: { version: 99, runId: 'another-run', futureShape: true },
  }
  assert.equal(applyWorkflowStoredEvent(selected, unrelatedFutureEvent), selected)
})
