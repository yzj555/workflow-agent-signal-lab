import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { emptySchema, proposalSchema, revisionSchema, rollbackSchema, authorReportSchema, qaReportSchema } from '../workflow-pilot-contract.ts'
import { reconciliationSchema } from '../workflow-reconciliation.ts'
import { budgetRecoveryInputSchema } from '../workflow-run-budget.ts'
import { projectProposalSchema, projectReportSchema } from '../workflow-project-contract.ts'
import { learningCommandSchema, learningRevokeSchema, learningToolCommandSchema } from '../workflow-learning.ts'
import type { WorkflowTextController } from './workflow-controller.ts'

const inputEnvelope = z.strictObject({ input: z.unknown() })

/** Transport is native DSH tool output, not an HTML form or custom chat. */
function register(ctx: Context, name: string, description: string, schema: z.ZodType, execute: (agent: Agent, input: unknown, exec: ToolRunContext) => Promise<object> | object): () => void {
  return ctx.tools.register(defineTool({
    name,
    description: `${description}\ninput 必须符合以下严格 JSON 结构（不要添加 actor、Agent ID 或权限字段）：${JSON.stringify(z.toJSONSchema(schema))}`,
    parameters: { input: { type: 'json', required: true, description: '命令内容；无参数命令传 {}。结构见工具说明。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const { input } = inputEnvelope.parse(args)
      if (!exec.agent) throw new Error('工作流工具要求真实的原生 Agent 上下文')
      const value = await execute(exec.agent, input, exec)
      return { result: JSON.stringify(value) }
    },
  }))
}

export function registerRootTools(ctx: Context, controller: WorkflowTextController): () => void {
  const remove = [
    register(ctx, 'workflow_status', '只读当前工作流、revision、角色分工、证据与交付物。工程终态会把本轮 deliverables 与仍匹配先前 run 摘要的 retainedPriorRunArtifacts 分开返回；后者不得表述为本轮产物。不可从自然语言或过期记录推断执行完成。', emptySchema, (agent, input) => controller.status(agent, input)),
    register(ctx, 'workflow_budget', '只在预算耗尽且用户要求时申请补额或结束，必须等待 DSH 原生确认；不能将用户的核对消息当补额授权。补额不清零、不扩权、不恢复中断角色；处理后结束当前轮等待用户，不自动推进。', budgetRecoveryInputSchema, async (agent, input, exec) => {
      const result = await controller.budgetRecovery(agent, input, exec.signal)
      exec.concludeTurn()
      return result
    }),
    register(ctx, 'workflow_propose', '合并用户需求并保存草案。支持 kind=text-deliverable 的 L0 文本闭环，或 kind=project-change 的受控 L1 工程闭环；此操作不批准执行。实现开始后不可覆盖合同。', z.union([proposalSchema, projectProposalSchema]), async (agent, input, exec) => {
      const controlOnly = controller.isBudgetControlTurn(agent)
      const result = await controller.propose(agent, input, exec.signal)
      if (controlOnly) exec.concludeTurn()
      return result
    }),
    register(ctx, 'workflow_confirm', '通过 DSH 原生确认处理当前门禁。局部工程任务直接确认执行；跨模块／架构任务第一次只确认需求理解并允许只读方案评估，方案完成后第二次才确认写入、检查与验收执行。不是让模型回答，存在未解决问题时会拒绝。返回的 decisionAudit 只证明用户权限和原生问答通道有效；operator=unverified 时不得声称用户亲手点击或没有代理。', revisionSchema, (agent, input, exec) => controller.confirm(agent, input, exec.signal)),
    register(ctx, 'workflow_advance', '推进一个 Host 允许的安全波次：按依赖串行，并把同波次的工程测试与代码审查并行派发。跨模块／架构任务会在只读方案完成后停住，必须再经 execution gate 才能实现。只有 Host 证据和全部角色记录通过后才交付；终态必须区分本轮 deliverables 与仍匹配先前 run 的 retainedPriorRunArtifacts。派发后自动结束协调者当前轮，等待原生结束通知；不要循环轮询。', revisionSchema, async (agent, input, exec) => {
      const value = await controller.advance(agent, input, exec.signal)
      if (('dispatched' in value && value.dispatched === true) || ('waiting' in value && value.waiting === true)) exec.concludeTurn()
      return value
    }),
    register(ctx, 'workflow_return', '仅依据当前工程测试、代码审查或独立验收的真实失败记录返回实现；同一确认范围内最多一次。保留原角色 Agent 身份，旧验收结论转待验证。', revisionSchema, (agent, input, exec) => controller.returnForRework(agent, input, exec.signal)),
    register(ctx, 'workflow_learn', '交付或结束后整理最多三条有本轮证据支持的候选经验，或修订一条已被用户退回的候选。首次整理使用 items；sourceEvidenceIds 必须逐字取自终态 workflow_advance 返回的 learningSources，或随后 workflow_status.learning.sources 中的 evidenceId。某条选择“内容有误，退回修改”后，其他候选决定立即独立保存；应先在原生对话等待用户说明具体改法，再仅提交该 candidateId、修订后 statement 与 reason，不得重提整批。Host 会保留每次修订前后内容、原因和次数，并只重新确认这一条。statement 必须不超过 160 字、没有换行、无明显机械文本错误且能独立读懂。返回的 decisionAudit 只证明用户权限和原生问答通道有效，operator=unverified 时不得声称用户亲手操作。采纳规则只能约束后续待确认需求，不能扩大权限、替代门禁或改变冻结命令。', learningToolCommandSchema, (agent, input, exec) => learningCommandSchema.safeParse(input).success
      ? controller.learn(agent, input, exec.signal)
      : controller.reviseLearning(agent, input, exec.signal)),
    register(ctx, 'workflow_learning_revoke', '停用一条当前项目或同类工作流中的活动规则。必须通过 DSH 原生确认通道获得批准；保留原候选、采纳和停用历史。该通道证明经过用户权限门禁，但当前官方回答协议不证明是谁亲手操作界面。', learningRevokeSchema, (agent, input, exec) => controller.revokeLearning(agent, input, exec.signal)),
    register(ctx, 'workflow_rollback', '仅在用户明确要求撤销或继续中断的撤销时使用。活动运行必须先 workflow_stop；随后展示最新实现检查点的精确文件预览并等待原生用户确认。若此前撤销中断，先核对同一事务，重新确认后只补完未完成项，不复用旧回答。已经落盘的撤销只核对清理其备份，不再改目标文件。摘要冲突时保留现场，不覆盖后续编辑；不撤销网络、进程、缓存或数据库副作用。', rollbackSchema, (agent, input, exec) => controller.rollback(agent, input, exec.signal)),
    register(ctx, 'workflow_reconcile', '仅在用户明确要求处理未确认停止的旧运行时使用。先 workflow_status，按 reconciliation.scope 的每个 assignmentId/incidentId 提供核实依据 checks[].evidence（source 与 observation），不得编造或把 PID 消失当成完整证明。本工具仅对无当前 Host 执行凭据的全部 unknown 范围发起原生用户门禁；确认后记录 ABANDONED 人工结束，保留原未知退出证据，不恢复旧 Agent、不自动重试、不撤销文件。新任务仍须重新确认。实际操作者未核验。', reconciliationSchema, (agent, input, exec) => controller.reconcile(agent, input, exec.signal)),
    register(ctx, 'workflow_stop', '停止这个工作流及其受控子 Agent，不删除已保存的交付物和历史，不扩大权限。未知退出不能由空回收视为停止；需用户核实后通过 workflow_reconcile 独立处置。', emptySchema, (agent, input) => controller.stop(agent, input)),
  ]
  return () => { for (const undo of remove.reverse()) undo() }
}

/** Only installed on an admitted child's exact unpublished scope. */
export function registerChildTools(ctx: Context, controller: WorkflowTextController): () => void {
  const remove = [
    register(ctx, 'workflow_packet', '读取本 Agent 的不可越权分配包。包内会明确本角色可见的工作区、冻结检查与报告合同；若存在 retainedPriorRunArtifacts，它们只是当前文件与先前 run 摘要一致的来源提示，不是本轮产物。不得获取父会话、其他角色对话或额外工具。', emptySchema, (agent, input) => controller.packet(agent, input)),
    register(ctx, 'workflow_report', '提交本角色的最终结构化报告。工程角色的文件与检查声明必须匹配 Host 观察到的真实工具结果；独立验收必须逐条提交证据支持的 PASS/FAIL。报告落盘成功后自动结束当前轮。', z.union([authorReportSchema, qaReportSchema, projectReportSchema]), async (agent, input, exec) => {
      const result = await controller.report(agent, input, exec.signal)
      exec.concludeTurn()
      return result
    }),
  ]
  return () => { for (const undo of remove.reverse()) undo() }
}
