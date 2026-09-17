# Workflow Control Plane Contract v1

状态：本文前十节保留 2026-09-03 Contract／Journal 切片的历史边界；后续已实现原生输入控制桥接、受控文本／工程调度、用户门禁文件撤销，以及 2026-09-08 的证据化沉淀与复用。用户已确认不改 DSH 核心的独立存储路线。当前实现边界见 [工程闭环](workflow-native-project-pilot-v1.md) 与 [沉淀复用 v1](workflow-learning-v1.md)。

## 1. 目标

本协议把 Workflow Agent 的事实从自然语言回复中分离出来，使门禁、任务依赖、Agent 生命周期、证据、验收和沉淀都成为可持久化、可重放、可验证的数据。

用户仍然只通过 DSH 原生输入框交流。后续可视化只读取本协议生成的投影，不承担第二套对话或控制入口。

## 2. 当前接法：插件独立日志

`workflow/event` 现在是插件日志中的领域事件标签，不是向原生 DSH Session 注册的事件类型：

- 插件 Journal 外层负责连续的 `seq` 和不倒退的 `time`，独立 `revision` 等于累计事件数；不能与原生 Session seq 比较。
- 工作流事件数据负责 `version`、`runId`、`eventId`、事件名称、行为主体和载荷。
- 事件只进入插件自己的官方 SQLite/domain 存储，不进入原生日志或模型对话表面。
- 一个根 Session 的全部工作流事件放在一行 KV 中；整个批次先严格重放、再原子写入，成功后才发布投影。写入失败或结果不确定时停止读写，待重新打开核验。
- 一个根 Session 可以先后包含多个 `runId`，但只有当前 run 可以追加；前一 run 结束后必须显式创建下一 run，不能把不同任务的事实合并。
- 独立 Journal 按 `rootSessionId` 关联原生会话。原生 fork、导出、删除不会自动复制或删除 Journal，也不会继承批准状态。
- 客户端通过官方 Connection 只读通道获取已提交的结构化 DTO，不依赖原生 Session Projection，不用聊天文本推断批准或完成。

大体积测试日志、截图和构建产物不直接写入事件。日志中只保存带版本和摘要的 `ArtifactRecord`，由 `locator + digest` 指向真实产物。

2026-09-03 核验：当前全局 DSH `0.1.1-rc.2` 没有仓库外插件的持久化事件注册接口。JSONL 与 SQLite 均允许上述事件追加、落盘，但冷恢复会抛出 `SessionFormatUnsupportedError`。因此暂停向真实会话写入该类型，不得通过修改已知类型集合、冒用已有事件类型或把关键授权事件标成可忽略来绕过守卫。

用户随后确认采用独立日志路线。原生 Session Projection 的同步通知与全量状态事件规则仍是未来若迁移回原生路径必须处理的边界，本实现没有绕过这些规则。

## 3. 版本化记录

| 记录 | 作用 | 关键内容 |
|---|---|---|
| `RequirementSnapshot` | Signal Gate 的需求合同 | 目标、范围、排除项、约束、权限边界、问题和验收 ID |
| `DesignSnapshot` | 已冻结的设计输入 | 决策、影响面、接口、迁移和回滚 |
| `TaskBrief` | Agent 唯一可执行的任务包 | 角色、阶段、风险、上下文域、依赖、允许/禁止动作、写入范围和输出合同 |
| `AcceptanceBrief` | 独立验收合同 | 硬性/建议项、验收者、证据要求和禁止获知的信息 |
| `ArtifactRecord` | 产物或证据引用 | 类型、位置、摘要、上下文域和生产任务 |

所有记录遵循以下规则：

1. 首版必须是 version 1。
2. 后续版本必须连续递增，并通过 `supersedes` 指向同一记录的前一版。
3. 需求、设计、验收在一个 run 内各有一个逻辑记录；任务和产物可以有多个。
4. 任务通过 `inputs` 精确声明自己消费了哪些记录版本。
5. 上游记录升级后，只把引用旧版本的任务标记为 stale。
6. 未声明字段和未知 schema 版本一律拒绝，不能静默猜测。
7. 验收结果绑定具体 AcceptanceBrief 版本；验收合同升级后旧结果自动回到 pending。

## 4. 门禁绑定

门禁不是一个脱离上下文的“已确认”布尔值。每个门禁必须通过 `inputRefs` 绑定它确认的记录版本。

```text
Requirement v1 ─┐
                ├─ Signal Gate #1（approved）
Acceptance  v1 ─┘

Requirement v2 发布
        │
        └─ Signal Gate #1 自动变 stale，不能继续授权实现
```

Signal Gate 必须同时绑定当前 Requirement 和 Acceptance 版本。若存在未解决的 material question，或者需求引用了不存在的验收项，确认事件会失败关闭。

X 类动作采用任务级粒度：

- Run 风险记录说明本轮是否存在 X 动作。
- 风险可以自动升级，但不能通过后续事件静默降级或删除已识别的 X 动作。
- 只有 `TaskBrief.requiresActionGate = true` 的任务需要即时动作门禁。
- Action Gate 必须绑定当前任务版本并明确 `scopeTaskIds`。
- 同一并行波次中的安全任务不因另一个 X 任务等待确认而冻结。

## 5. 事件词汇

| 事件 | 含义 |
|---|---|
| `run/created` | 建立一个独立工作流运行 |
| `risk/classified` | 记录 L0-L3 与 X 动作判断 |
| `gate/requested` / `gate/decided` | 请求和决定版本绑定的门禁 |
| `record/published` | 发布一个新记录版本 |
| `task/status-changed` | 以 expectedStatus 做并发安全的任务状态迁移 |
| `agent/assigned` | 把一个任务版本、角色和上下文域绑定到子 Agent |
| `agent/resumed` | 同一 Agent 在同一角色与上下文域内续接新任务包版本 |
| `agent/settled` | 记录本轮执行结算；continuable Agent 仍可恢复 |
| `evidence/recorded` | 保存研究、实现、验证、审查或产品证据 |
| `acceptance/recorded` | 对单项验收记录 PASS、FAIL 或 WAIVED |
| `checkpoint/file-captured` / `checkpoint/file-observed` | 在实现写入前保存原始文件状态，并以 CAS 更新该检查点的受控最终状态 |
| `return/routed` | 返回最小责任阶段与任务 |
| `outcome/declared` | 宣告 PASS、QUALIFIED、FAIL 或 CANCELLED |
| `rollback/applied` | 记录经用户专用门禁确认、且文件恢复事务已经成功的检查点撤销 |
| `learning/proposed` / `learning/decided` | 提议有证据来源的沉淀候选，并通过原生用户权限门禁完整决定是否及在哪个作用域采纳 |
| `learning/applied` | 记录后续草案确定性命中的规则及本轮应用／显式覆盖状态 |
| `learning/revoked` | 记录经原生用户权限门禁决定停用活动规则；原候选与既往应用仍保留 |

每个事件都有独立 `eventId`。重复 ID、倒退的序号、非法状态迁移和跨 run 引用都会被重放器拒绝。

事件中的 `actor.kind=user` 是权限域语义：它证明回答来自 DSH 原生用户问题通道，而不是模型在对话中自述批准。目标版本的官方回答载荷不包含物理操作者来源，因此它不能证明用户亲手点击，也不能排除经用户授权的客户端或代理操作；审计不得把两者混为一谈。

新产生的原生门禁决定同时携带 Host 生成的 `decisionAudit`：`authority=user`、`channel=native-question`、`operator=unverified`、`requestId=<Host 关联 ID>`。重放器要求该关联 ID 与 `actor.id=native-question:<requestId>` 完全一致，不能由模型额外提交操作者声明。多候选沉淀使用同一次原生问题批次的 Host 关联 ID。系统自动取消不伪装成该审计；为兼容既有 Journal，旧事件可缺少此字段，投影必须明确显示为旧版来源信息缺失，不能反向补造。

## 6. 角色与上下文连续性

任务包明确记录目标角色和允许看到的上下文域：

- C0：验收合同
- C1：研究与设计
- C2：实现信息
- C3：独立黑盒验收信息
- C4：显式授权的敏感信息

同一 continuable Agent 可以接收新版 TaskBrief，但必须同时满足：

1. assignment 不变；
2. 子 Session ID 不变；
3. 角色不变；
4. 上下文域集合不变；
5. 新 TaskBrief 是当前版本。

角色或上下文域改变时必须建立新的独立 Agent，不能借“继续执行”跨越隔离边界。

## 7. 串并行任务

`TaskBrief.dependsOn` 形成有向无环图。协议提供确定性的 parallel waves 计算：同一 wave 可并行，后一 wave 必须等待前置任务完成。缺失依赖、自依赖和环都会失败关闭。

任务从 `pending` 开始，状态改变必须携带 `expectedStatus`。运行前还会检查：

- 任务包是否为当前版本；
- 输入是否 stale；
- Signal Gate 是否仍绑定当前合同；
- Run 风险级别是否覆盖任务风险；
- 前置任务是否完成；
- 当前任务是否需要且已经获得 Action Gate。

创建或恢复 Agent assignment 也执行同一组授权检查，不能通过“先启动 Agent、后改变任务状态”绕过门禁。

## 8. 验收与最终结论

硬性验收项的结果只来自结构化账本：

- 存在 FAIL：总体硬性结果为 FAIL；
- 没有 FAIL，但存在未记录项：PENDING；
- 全部已记录且存在 WAIVED：QUALIFIED；
- 全部为 PASS：PASS。

WAIVED 必须由用户事件产生并携带用户决定引用。PASS/FAIL 必须由 AcceptanceBrief 指定的 verifier 产生，并引用方向一致的证据。

最终 PASS 或 QUALIFIED 还要求：

- 没有 stale 任务；
- 所有任务已完成；
- 声明的账本计数与事件重放结果完全一致。

文本中的“全绿”或“已完成”不参与权威判定。

## 9. Contract / Journal 切片当时的未实现边界

以下内容不属于 Contract v1，不能因为协议文件存在就认为已经可用：

- 不向真实 DSH Session 写入 `workflow/event`；这是当前已选路线的边界，不是待补的注册步骤；
- 尚未将原生输入中的需求、补问、用户确认和撤回意图接入受信 Controller；
- 尚未提供受控的 `workflow_dispatch`、`workflow_continue`、`workflow_report`；
- 尚未阻止 PM 绕过协议直接调用现有 Crew 工具；
- 尚未实现 Acceptance QA 的工具白名单或独立进程；
- 尚未把持久化 Agent 运行态与重启后的真实进程/子 Session 存活状态核对，面板仅标注“运行记录”；
- 尚未提供 Journal 的自动迁移、原生会话删除联动、导出/fork 集成或崩溃锁自动回收。

## 10. 下一切片：原生输入与受控执行桥接

独立存储与只读传输已验证，下一步应把协议变成实际执行约束：

1. 将预设选择与根 Session 绑定；受信 Controller 校验调用方身份、会话归属和输入版本，不能让模型自称 user 产生批准事件。
2. 原生对话继续承担需求澄清与确认；未解决的问题不越过 Signal Gate，旧版本的确认不自动沿用。
3. 受控 dispatch/continue/report 将任务包、角色和证据绑定到 Journal，并阻止绕过路径。
4. 先用小任务验证“原生确认 → 持久化授权 → 派发 → 验证/返回 → 面板同步”，再扩大覆盖。

当前第二切片没有调用业务 Agent，没有为旧会话伪造工作流记录。不能仅凭 51 项协议、存储和传输测试，就宣称完整工作流或 QA 权限隔离已经实现。

## 11. 后续受控文本桥接实现注（2026-09-03）

已新增严格的原生需求确认、文本角色派发／续接／报告及一次失败返回，验证实际官方 Agent 循环和权限拒绝。任务包改版会将相关当前验收结论清除为待验证，旧事件证据保留；系统 actor 只能取消未决问题，不能替人批准。

这不补齐所有第 9 节能力，也不等于旧 Crew 会话已经受控。2026-09-03 在用户明确要求后已重启官方 3080 并接入新版预设；原生空白会话挂载与只读页面检查通过，未提交真实模型任务。以 [受控文本闭环实施记录](workflow-native-text-pilot-v1.md) 为当前代码和部署边界，不修改这里的通用协议目标。

## 12. 后续受控工程桥接实现注

`workflow-project-pilot/1` 已把 Contract／Journal 的任务 DAG 接到受控 L1 工程路径：可选架构评估串行在实现之前，工程测试与代码审查在实现之后并行，模型侧源码隔离的黑盒验收等待二者汇合。协调者只有工作流控制工具；各原生 continuable 子 Agent 按角色获得不同的文件／冻结命令能力。文件路径、摘要、命令退出结果和验收引用由 Host 核对，模型报告不能单独构成通过证据。

失败可凭当前工程测试、代码审查或独立验收证据返回同一实现 Agent 一次；当前实现会完整重跑下游工程测试、代码审查和黑盒验收，不声称已经支持影响分析后的选择性复验。

2026-09-07 又补入用户门禁的工作区文件撤销：写入前由 Host 保存内容检查点；活动运行先停止；用户查看精确文件清单并在原生问答再次确认后，按最新检查点后进先出恢复。摘要冲突时整体拒绝，Journal 提交失败时补偿回撤销前状态。它不是失败后的静默自动动作，也不补偿命令产生的外部副作用；详见 [工作区文件撤销 v1](workflow-file-rollback-v1.md)。

这仍不是全部第 9 节能力。Windows 官方沙箱只约束文件写入，不提供读取、网络或进程隔离；验收的“源码隔离”只指模型工具和上下文。确认前自动只读勘察、撤销事务的跨进程崩溃恢复、任意 DAG、L2／L3 和进程存活核对仍未实现。证据化、分作用域、可覆盖和可停用的沉淀 v1 已于 2026-09-08 实现，但不包含语义检索、全局规则或独立规则管理页；详见 [沉淀复用 v1](workflow-learning-v1.md)。第 9、10 节保留为当时切片的历史描述，不倒签改写。
