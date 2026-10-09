# DSH 工作流 Agent 项目完整指南

更新日期：2026-10-09。面向在其他设备上克隆项目的使用者、开发者和接续助手。读完本指南，应能理解项目解决什么问题、已经制作到哪里、如何复现候选和安排安装、哪些操作不能直接执行，以及距离正式生产版还差什么。

当前结论：**源码和技术专项已推进到 `1.0.0-rc.12`，正式 Production v1 尚未完成。** 本仓库可以用于接续开发和复现候选，不是一个已经获准投入生产、克隆后即可直接启动的发行版。独立生产 Profile 尚未创建；真实使用和最终交付仍需完成。

## 阅读顺序

- 只想理解产品：[项目定位](#项目定位)、[完整工作流](#完整工作流)、[角色与权限](#角色与权限)。
- 准备换机接续：[当前制作进度](#当前制作进度)、[新设备接续与候选构建](#新设备接续与候选构建)、[私有档案与换机备份](#私有档案与换机备份)。
- 准备安装：[版本基线与目录](#版本基线与目录)、[首次安装与启用](#首次安装与启用)，不要从历史脚本开始。
- 准备发布：[生产准入和下一步](#生产准入和下一步)、[正式发布流程](#正式发布流程)、[尚不支持和接续注意事项](#尚不支持和接续注意事项)。
- 发生异常：[停止与恢复](#停止与恢复)、[升级与兼容回退](#升级与兼容回退)、[故障处理与诊断](#故障处理与诊断)。

本指南是总体入口；具体协议仍以链接的设计文档和当前源码为准。旧文档中的 PID、3080 部署、SDK 版本和“下一步”带有当时日期，不代表新设备或当前在线状态。最新进度以 [Production v1 执行状态](docs/operations/production-v1-status.md)为准，不将旧结论倒签到新版本。

## 项目定位

项目名称为 **Workflow Agent Signal Lab**，仓库为 [yzj555/workflow-agent-signal-lab](https://github.com/yzj555/workflow-agent-signal-lab)，内部包名为 `@local/workflow-agent-signal-lab`。

这是 DSH 的 Agent 预设与工作流插件，不是 DSH 核心，也不是一套独立聊天软件。用户在 DSH 中选择“工作流 Agent · Signal Lab”模式后，原生 Agent 按这套受控工作流执行；不依靠猜测用户的输入来决定是否启用模式。端口管理工具只是早期模拟测试任务，插件不限定于端口管理。

设计起点不是增加任务表单，而是保留自然语言交流，同时让用户看得见进展、控制得住执行、追得回证据。主要需求是：

- 模糊需求先讨论、补问和合并，不能不明不白进入实现。
- 明确授权范围内可以自动推进；需求变化、敏感动作、授权不足和异常必须停下。
- 用户随时通过原生输入框补充、调整或要求停止，不用学习第二套聊天入口。
- 工作流可视化显示当前阶段、下一步、角色正在做什么、是否需要用户操作，以及返工来源、次数和原因。
- 实现、测试、审查和验收职责分离；通过不能只靠 Agent 自述。
- 交付后逐次沉淀经验，但长期规则必须逐项确认，且不能扩大权限。

v1 的目标边界是 **Windows、本地有人看护的 L0 文本与 L1 工程开发辅助**。无人值守线上操作、云资源或数据库写入、自动部署、任意动态 Agent 编排不属于这一版本。

## 架构与事实来源

项目分成四个层次，用户不必直接操作底层记录：

| 层次 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| DSH 原生交互 | 输入、模型对话、原生问题、预设选择、原生会话 | 不用聊天文本充当工作流批准记录 |
| Host 控制层 | 验证合同和调用者、门禁、派发、预算、角色生命周期与证据 | 不让模型自批、越权或伪造通过 |
| 独立 Journal 与对象存储 | 保存版本化事件、合同、账本、内容对象和文件检查点 | 不自动迁移原生会话或回滚外部系统 |
| 原生工作流页签 | 读取已提交状态，展示阶段、角色、计划与证据 | 不提供第二个输入框，不直接批准或执行 |

```text
原生输入和原生问答
        ↓
协调 Agent 提议 → Host 校验与门禁 → 受控角色执行
                         ↓                 ↓
                 Journal 和证据账本 ← 实际工具与退出事实
                         ↓
                  只读工作流页签
```

`RequirementSnapshot` 保存需求，`DesignSnapshot` 保存设计，`TaskBrief` 保存角色任务包，`AcceptanceBrief` 保存验收合同，`ArtifactRecord` 指向真实产物。门禁和验收绑定具体记录版本；合同改版会使相关旧授权或结论失效，不能沿用一句“已经确认”。

工作流事件进入插件独立的官方 SQLite/domain 存储，不向 DSH 原生 Session 冒写自定义 `workflow/event`。一个根 Session 可以先后有多个 run，但不能把不同 run 的授权和产物合并为一个成功事实。原生 Session、工作流 Journal、项目文件是不同对象，必须分别保护。

关键依据为 [控制层合同](docs/design/workflow-control-plane-contract-v1.md)、[Journal 协议](docs/design/workflow-journal-v1.md)和 [Host 接入说明](docs/design/workflow-host-integration-findings.md)。自然语言分类和历史展示辅助函数不替代 Journal 的结构化权威判定。

## 完整工作流

七个可视阶段是需求确认、计划与拆解、实现、验证、独立审查、交付、沉淀。它们表示当前任务实际路径；某些阶段可以跳过或并入，不能为了让阶段条填满而执行无意义步骤。跳过、结束、失败、撤销和返回不是同一种状态。

### 文本任务

L0 路径为：原生需求澄清与确认 → 文本作者 → 独立文本验收 → 交付 → 沉淀。只提交插件内文本产物，不访问项目文件、运行 Shell 或操作进程。失败可在同一范围内返回作者一次，不能无限重试。

### 工程任务

```text
原生补问和合并合同
  ├─ localized：执行授权 ───────────────────────────────┐
  └─ cross-module / architecture：                      │
       需求理解门禁 → 只读方案 Agent → 执行授权门禁 ────┤
                                                       ↓
                                                    实现 Agent
                                              ┌────────┴────────┐
                                              ↓                 ↓
                                         工程测试           代码审查
                                              └────────┬────────┘
                                                       ↓
                                                  黑盒验收
                                                       ↓
                                                    交付与沉淀
```

`localized` 是局部变更；`cross-module` 是跨模块变更；`architecture` 是架构类变更。这三类是工程合同的明确字段，不是按文件数量自动完成的影响分析。跨模块和架构任务需要两道确认：第一道只放行只读方案，第二道才允许约定范围内实现。

在执行授权前，合同必须明确目标、包含与排除范围、约束、未解决问题、工作区、写入前缀、工程检查、黑盒检查和验收标准。协调者没有项目读取工具，不能在首次需求确认前自行勘察陌生仓库；陌生路径和命令需由已有事实或用户确认提供。

测试与审查在实现后并行，黑盒验收等待二者汇合。真实失败证据允许一次同范围返工；返工后完整重跑下游测试、审查和验收。改变范围、命令或验收标准不是普通返工，必须重新处理合同和授权。

协议层具有依赖和并行波次校验，但当前产品只执行已冻结的有限角色图，**不是任意 DAG 调度器**。多根运行可以并存，不代表任务之间已支持自由共享产物、动态角色或跨项目自动依赖。

### 大型需求如何处理

确认卡只展示当前决策摘要，全部范围、权限、设计、命令、依赖和验收保存在“完整计划／证据”中。不能把大量信息硬塞进一张确认卡，也不能通过省略信息让用户批准。

当前工程合同存在明确上限：最多 20 个写入前缀、8 项工程检查、8 项黑盒检查、10 项验收标准；不是无限任务模型。超过容量应先与用户拆成边界明确的多轮任务，或另行设计扩展，不能静默截断标准。更大需求的易用性仍需独立体验验证。

## 角色与权限

| 角色 | 责任和可见信息 | 工具边界 |
| --- | --- | --- |
| 协调者 | 澄清、合同、请求门禁、推进、汇合、交付与沉淀 | 工作流控制工具及原生问答；没有项目文件和 Shell 工具 |
| 方案／架构 | 分析接口、影响、执行方案和回滚约束 | 只读 `read/glob/grep`；禁止写入和命令 |
| 实现 | 在确认前缀内修改当前文件 | `read/write/edit/glob/grep`；禁止 Shell、自测、自批和委派 |
| 工程测试 | 源码可见地执行全部 `ENG-*` 检查 | 只读检索和逐字冻结的前台 `pwsh`；禁止直接改文件 |
| 代码审查 | 审查当前文件版本，报告阻塞项和建议项 | 只读检索；禁止修改、Shell 和自行修复后审自己 |
| 黑盒验收 | 按 `AC-*` 逐条引用 `ACC-*` 行为证据 | 冻结的 `pwsh` 和报告工具；不给源码读取工具和实现者对话 |

每个子角色是独立的原生 Session；身份、任务版本和上下文域绑定。角色变化不能借“继续执行”沿用被污染的同一身份。Host 在实际工具调用处再次检查工具、路径、命令和当前授权，工具在模型视图里隐藏不是唯一防线。

“黑盒验收不看源码”指模型上下文和工具白名单隔离，**不等于 Windows OS 安全隔离**。冻结的测试脚本也可能有间接副作用，必须先审阅；不适合用此候选处理不可信代码或需要严格保密隔离的生产环境。

实现依据：[`src/host/workflow-capabilities.ts`](src/host/workflow-capabilities.ts)、[工程闭环协议](docs/design/workflow-native-project-pilot-v1.md)。

## 自动推进和用户控制

自动推进只发生在当前合同、角色、资源与有效门禁允许的范围内。模型可以提出方案或报告，不能自行获得用户权限。

| 情况 | 系统行为 | 用户如何参与 |
| --- | --- | --- |
| 合同已确认，依赖满足 | 在有限路径内推进 | 原生输入可补充或要求停止 |
| 关键问题未明确 | 保持澄清，不进入实现 | 补充范围、路径、命令或标准 |
| 跨模块／架构方案完成 | 停在执行授权 | 查看完整计划后决定 |
| 当前检查有真实失败 | 最多一次同范围返回并完整复验 | 可调整需求；范围变化重新确认 |
| 预算不足或并发不足 | 暂停新执行，不后台排队偷跑 | 查看状态，按适用原生门禁处理 |
| 退出未确认、写入异常 | 封闭执行，显示需要处理 | 核实事实后处置，不猜测完成 |
| 提出长期经验规则 | 逐项原生裁决 | 采纳、退回修订或不采纳 |

`actor.kind=user` 证明决定经过原生用户权限通道，不认证“用户亲手点击”。审计保留 `operator=unverified`；助手代理操作不能冒充独立用户体验验收。

### 资源政策

[`src/workflow-resource-candidate.json`](src/workflow-resource-candidate.json)定义 `packaged-candidate` 的显式政策。安装本身不启用这些限制，也不重写历史运行额度。

| 对象 | RC.12 候选限制 |
| --- | --- |
| 根响应无进展 | 普通 180 秒，单次恢复 120 秒，取消宽限 15 秒 |
| 子角色 | 启动 30 秒、无进展 180 秒、最长 20 分钟，报告／取消宽限各 15 秒 |
| 冻结命令 | 执行 120 秒，退出核对宽限 15 秒 |
| 正式 run | 240 次模型准入、40 次命令准入、30 分钟有效活动时间 |
| 有限推进 | 一次同范围返工，最多三次明确补额 |
| Host 准入 | 本预设 2 个活动根范围／根模型流、4 个子角色范围 |
| 文件与检查点 | 单文件 16 MiB；单次实现 100 文件／64 MiB |
| Journal | 9000 事件／14 MiB 暂停新执行，10000 事件／16 MiB 硬限 |

有效活动时间取执行区间并集；单纯等待用户可以暂停计时，但后台角色仍在工作时继续计时。取消中或退出未知仍占位，不假释放并发额度。名额释放后，先前被拒绝的任务需要新的原生用户消息，不自动排队续跑。

模型请求数不是 Token 或费用封顶；正式 run 前的需求入口及原生辅助模型调用也不全由该账户计量。内存、整个磁盘、其他预设和任意 OS 进程数量不受这些数值全面约束。具体说明见 [资源政策](docs/operations/workflow-resource-policy.md)。

## 停止与恢复

停止、取消、结束 run、文件撤销、代码版本回退是不同操作。不能把点击停止、Agent drain、退出码 0、PID 消失或新 Host 的空列表单独当成“所有进程已停止”。

- 正常停止保留已产生的文件和证据，等待对应托管范围退出核对。
- 冷启动恢复记录，不默认重派角色、重放命令或复用旧批准；未知执行保留“未确认停止”。
- 用户核实后可通过既有原生门禁人工结束旧 run，记为 `ABANDONED`；原 unknown 和退出证据不被补造，新目标重新确认。
- 文件撤销先停止活动范围，再核对检查点和当前摘要，经专用原生门禁恢复；冲突时拒绝覆盖用户后续编辑。
- 撤销只能处理明确记录的受控文件，不补偿命令产生的网络、缓存、进程、数据库等外部副作用。
- 跨进程撤销恢复保留意图和当前状态；旧确认不自动复用。新协议写入后不能降到不认识它的解析器。

安装启用后，原生 `/workflow-resources` 可查看本预设资源，`/workflow-resources stop` 仅请求停止当前工作流；`/workflow-budget` 可查看预算，`topup`／`end` 仍走原生确认。命令不提供扩容或跳过未知占位的捷径。

遇到旧 `writer` 标记时不要删除锁重试。先明确对应 Home、Profile、数据目录、Host 身份和真实退出，再按恢复协议备份与核验。进程名、端口和旧 PID 都不足以决定杀哪个进程。

详见 [命令与退出核对](docs/design/workflow-command-budget-v1.md)、[人工处置](docs/design/workflow-manual-recovery-v1.md)、[文件撤销](docs/design/workflow-file-rollback-v1.md)和[撤销恢复 v2](docs/design/workflow-file-rollback-recovery-v2.md)。

## 经验沉淀

交付后从本轮已保存证据提出最多三条经验；无有价值候选就记录无候选，不强迫用户完成表单。每条决定独立持久化，可采纳到当前项目或同类工作流、退回修订、不采纳；某条退回不重问其他项。

已采纳规则只在后续匹配任务的需求草案中成为可见约束或假设，并再次经过正常确认。当前指令优先，可说明本轮覆盖原因；停用追加事件，历史不删除。规则不能增加工具权限、修改冻结命令、跳过门禁或污染其他项目。

运行时复用采用确定性作用域和精确词项匹配，不是通用语义搜索。当前没有全局规则、跨 Profile 自动迁移或独立规则管理页；真实模型提炼规则的质量还需实际使用验证。见 [沉淀复用协议](docs/design/workflow-learning-v1.md)。

## 当前制作进度

以下状态对应 2026-10-08 的验证和 2026-10-09 的源码保存，不证明任何新设备已经安装或运行。

| 部分 | 已完成 | 尚未完成或不能外推的结论 |
| --- | --- | --- |
| 原生模式与界面 | 预设选择、原生对话／问答、只读页签与确认信息合同 | 独立操作者、大型需求与极窄界面的完整体验验收 |
| 有限工作流 | L0/L1、两段授权、固定串并行、角色隔离、一次返工 | 任意动态 DAG、开放角色与选择性复验 |
| 事实与恢复 | 版本合同、Journal、证据账本、文件检查点、七类中断机制矩阵 | 不能宣称所有系统故障或旧数据问题已修复 |
| 可靠性与资源 | 共享存储故障封闭、容量守卫、并发、命令／模型／时长专项 | 正式 Profile 的绑定、真实使用与 Gate C 总体关闭 |
| 交付工程 | 固定 SDK2、干净归档、安装准入、编号 RC 升级、兼容回退和卸载重装 | 稳定版发行路径、许可证、正式交付和 Gate E 总体关闭 |
| 换机保存 | GitHub 源码、锁文件、设计及验收摘要、接续说明 | 私有原始证据、Session、数据库和凭据不在仓库 |

可定位的最新证据摘要：

- 两次主工程干净构建各 **588/588**，50 个测试文件，零失败／取消／跳过／todo；220 个发行输入、43 个载荷和归档一致。
- 同包双 L1／四角色、40 次命令与第 41 次拒绝、120031ms 命令超时及完整冷回放通过。
- 双 L0 各一次返工，240 次模型请求及第 241 次拒绝通过。
- 两根实际 30 分钟有效活动到限，7,010 次成功快照 RPC，8 个完整冷快照／5 行 Journal 与正常退出一致；保留 10／15ms 收尾超量，不承诺毫秒级 OS 强杀。
- 新版七类恢复分支的 28 个明确用例逐项绑定两轮日志；不是重新进行生产环境强停。
- RC.11／RC.12 的实际隔离原生准入、维护与保留新增数据的回退有证据。只读浏览器回放不当成真实批准，脚本化模型不当成独立使用。

详情见 [主工程与新版恢复](docs/validation/2026-10-08-dsh-020-canonical.md)、[资源专项](docs/validation/2026-10-08-dsh-020-resource.md)、[安装准入](docs/validation/2026-10-08-dsh-020-installed-activation.md)和[维护验收](docs/validation/2026-10-08-dsh-020-maintenance.md)。588 是特定基线的测试数量，不是完成度百分比；包名中的 RC 也不代表生产准入计划的所有 RC 条件已满足。

## 生产准入和下一步

| Gate | 必须证明什么 | 当前结论 |
| --- | --- | --- |
| A 真实工程 | 真实模型完成干净工程交付与有证据失败返回，权限和产物来源明确 | 旧 SDK 有真实通过证据；新版合成工程不能替代新版实际验收 |
| B 恢复一致性 | 七类既定切点不重复派发、不复用过期批准、不伪造终态 | 同 RC.12 机制矩阵已逐项绑定；范围有限 |
| C 可靠性资源 | 超时、停止、异常、容量、诊断、正式配置和数据一致性 | 同包技术专项通过，正式接入及总体准入未关闭 |
| D 独立体验 | 未参与实现的人完成补充需求、授权、返工等场景 | 未完成；助手代理或反复提示答案不能替代 |
| E 交付兼容 | 固定版本可安装、升级、停用、兼容回退且旧档案保留 | 隔离 RC 维护通过，正式环境、稳定版本、许可证及交付未完成 |

依照 [完整准入计划](docs/design/workflow-production-readiness-v1.md)，下一步顺序是：

1. 用户确认新设备的路径和离线准备范围；创建独立生产 Home／Profile，旧实验档案完整保留。
2. 另行安排原生欢迎偏好和模型设置，工作流仍停用；空闲关闭后固定配置、HMR 政策、Host 和资源方案。
3. 受控启用同一候选并完成只读界面和准入核对；新建真实可恢复工程完成新版真实模型与独立操作者验收。
4. 核对 C/D/E 的剩余条件及旧问题的保留方案，不能用新环境健康证明旧历史已修复。
5. 冻结最终源码和交付基线，补齐稳定版本交付路径、许可证和发布授权，再决定正式 Production v1。

不复用已消耗的旧重启许可。阅读本指南、克隆仓库或通过 `check` 都不是启动、模型任务、门禁批准或发布的授权。

## 版本基线与目录

| 项目 | 当前固定值 |
| --- | --- |
| 系统 | Windows x64；不宣称 macOS／Linux 已验收 |
| Node.js | `26.1.0`，发行政策严格核对 `v26.1.0` |
| pnpm | `11.7.0` |
| DSH／SDK | `0.2.0-rc.2` |
| 官方源码提交 | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| 共享基础库 | Cordis `4.0.4`、Schemastery `3.18.4` |
| 源码工程 | 内部 `0.0.1`、`private: true` |
| 发行候选 | `1.0.0-rc.12`；当前不是 npm 可安装的正式版 |
| 权限与兼容协议 | 归档清单包含 `transitionProtocol: 1`、SDK2 `presetAdmissionProtocol: 1` |

旧 DSH `0.1.5-rc.1` 及旧 RC 的证据保留原日期，不能混装到当前 Host。全局 `dsh` 可能指向源码 Junction 或另一安装；CLI 版本相同也不保证共享组件的物理身份相同。固定 Host 还要核对实际 CLI、组件集合和已安装插件的共享解析结果。

```text
src/          Host、客户端、合同、事件、资源与沉淀实现
preset/       工作流预设定义
tests/        回归、原生组件接线、故障与进程夹具
scripts/      发行与维护入口，另含不得直接照抄的历史实验工具
release/      发行说明、停用组合层、第三方声明与验证政策
docs/design/  协议、设计与准入条件
docs/operations/  操作流程与最新状态
docs/validation/  各版本已核验的范围、失败与限制
.dsh/         本机私有证据和工作流数据，不提交
```

`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 必须一起保留。仓库根 `lib` 不受 Git 管理，旧设备保留的 lib 与最新源码可能不一致；不能直接部署它。`.gitattributes` 保留发行输入的原字节，换机不要自动转换换行后仍引用旧摘要。

## 新设备接续与候选构建

先安装 Git、指定版本 Node.js、pnpm 和匹配的 Windows PowerShell 环境。以下命令只克隆、核对和构建，不安装到用户 Profile，不启动 DSH，不调用真实模型：

```powershell
git clone https://github.com/yzj555/workflow-agent-signal-lab.git
Set-Location .\workflow-agent-signal-lab
git status --short --branch
git rev-parse HEAD
node --version
pnpm --version

# 父目录需已存在；输出子目录必须不存在，且不要选部署目录。
pnpm run release:build --output C:/work/evidence/workflow-rc12 --version 1.0.0-rc.12
```

示例路径需要自己选定，不要求新设备存在旧 `F:\dsh`。发行器在仓库外复制固定输入，以 frozen lock 和禁止安装期脚本的方式获取注册表依赖，执行双端类型检查、production 模式构建和全量回归，收集载荷并生成 `.tgz`。不依赖旁边的 DSH 源码，不覆写主目录构建，不自动清理证据或发布。

预期输出包括 `receipt.json`、步骤日志、`package/`、`local-workflow-agent-signal-lab-1.0.0-rc.12.tgz`。必须阅读回执，核对零失败和跳过、输入与载荷、实际 Node／pnpm／组件版本；失败现场保留，不用旧通过回执覆盖。

2026-10-08 已核验归档的 SHA-256：

```text
31d9e72cdc801d540972def46d8975c9979f4ff971e78200b6f878533e33c192
```

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath C:\work\evidence\workflow-rc12\local-workflow-agent-signal-lab-1.0.0-rc.12.tgz
```

输入未变时应复核归档是否一致；不一致先查实际输入和环境，不手工改清单。新设备一次构建不自动重做全部运行验收。安装包不是公开仓库自带文件，原 `.tgz` 若未私有备份就需要重新构建。

开发调试可用匹配 DSH 源码和 `scripts/link-dsh-dev.ps1 -CheckOnly`，再在不供 Host 使用的副本链接和构建；这不是生产安装路径。不要在活动部署目录运行 build／包管理器重装。更多细节见 [发行构建说明](docs/operations/release-build.md)；其中旧 SDK 示例按版本范围阅读。

## 首次安装与启用

此流程用于**独立的新环境**。当前新生产环境尚未建立；下面是供操作者评审和执行的命令模板，本指南不会代执行。首次配置工具也不创建 Profile、不停服务、不安装或启动包。

### 准备固定 Host 和私有目录

先准备路径稳定的官方 DSH `0.2.0-rc.2` 安装并核对组件基线。不要只执行一次“更新到最新”就默认兼容，不把源码构建用的 overrides 强行复制到别人的 Profile。记录真实 `package.json` 和 `lib/bin.js` 路径；pnpm 别名可能是 Junction，`--host-package` 要求已解析的真实文件绝对路径。

操作者选定独立 Home、Profile、对象数据目录和方案输出父目录。Home 不与旧实验 Home 共用；数据目录必须新建或为空，不与安装／配置目录重叠。需要权限保护、足够磁盘空间和受控备份；Windows 文件 mode 参数不是 ACL 保证。

以下变量仅为模板，所有路径都需要替换并核对，不指向正在运行的环境：

```powershell
$workflowNode = 'C:\path\to\node.exe'
$workflowCli = 'C:\path\to\real-dsh-package\lib\bin.js'
$workflowHostPackage = 'C:\path\to\real-dsh-package\package.json'
$workflowHome = 'C:\DSHProduction\home'
$workflowProfile = 'workflow-production-v1'
$workflowArchive = 'C:\work\evidence\workflow-rc12\local-workflow-agent-signal-lab-1.0.0-rc.12.tgz'
$env:DSH_HOME = $workflowHome
```

`DSH_HOME` 这里只影响当前终端进程及其子进程。切回其他环境时恢复原值或另开终端，不把生产 Home 误用于旧实验会话。不要把实际凭据写入这些命令或仓库。

### 离线创建 Web Profile 并安装

确认目标 Profile 目录不存在，使用官方 Web 模板配合配置 dump 离线创建；只用 `plugin add` 创建自定义 Profile 时默认基于 base，不一定具有 Web 应用。已有 Profile 不能再次传创建参数。

```powershell
& $workflowNode $workflowCli --profile $workflowProfile --from-default-profile web --dump-config
# 上一步成功、版本和归档摘要已核对后：
& $workflowNode $workflowCli plugin --profile $workflowProfile add $workflowArchive --config.ignore-scripts=true
```

dump 不启动应用，但会初始化目标并输出配置；配置输出可能含私有值，不上传。安装后的 SDK2 归档含声明、guard、UI、engine 四项默认停用行，不改变默认 Agent，不复制旧凭据、运行或预算。

官方机制依据为固定基线的 [CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/cli/reference/README.zh.md)及[插件打包安装](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/user/develop/basic/publish.zh.md)。生产接续采用已验证预构建 tarball，不直接 `add github:...`：本仓库没有用于 Git 安装的自包含 prepare，源码也不携带 lib。

### 工作流停用时完成原生设置

另行取得启动范围后，以同一 Home／Host／Profile 启动原生 Web，不追加工作流启用 overlay，完成欢迎偏好和所需模型设置。凭据由用户通过原生方式配置，不从旧环境自动复制。设置完成后确认整个 Host 空闲并正常关闭。

正式方案要在设置完成后冻结；欢迎偏好或模型配置后续变化会使指纹失效，不能忽略。检查网络、代理、证书、模型可用性和费用责任；真实连通性调用与任务执行需要对应许可，不由离线安装顺带授权。

### 明确 HMR 政策并冻结准入方案

DSH 0.2 要求在此独立 Profile 的最终组合中，**所有官方 `dsh-hmr` 行显式停用**。旧 `patchReload: startup` 字段已经不适用，不能替代检查。停用 HMR 影响整个 Profile 的配置／代码重载，不仅影响工作流；需人工审阅且保留无关配置。

取**实际安装包目录**作为 `$workflowPackage`，在 Host 关闭状态下运行：

```powershell
$workflowPackage = 'C:\path\to\installed-workflow-package'
& $workflowNode "$workflowPackage\scripts\configure-workflow.mjs" prepare `
  --host-package $workflowHostPackage --home $workflowHome --profile $workflowProfile `
  --data C:/DSHProduction/private/workflow-data --policy packaged-candidate `
  --output C:/DSHProduction/private/activation-v1

& $workflowNode "$workflowPackage\scripts\configure-workflow.mjs" check `
  --plan C:/DSHProduction/private/activation-v1/activation-plan.json
```

输出父目录必须已存在，输出子目录必须不存在；数据路径同样按前提核对。若已有额外 overlays，`prepare` 按原顺序逐项加 `--patch`，以后启动必须保持相同顺序。不要把第一次配置工具用于已有非空数据。

成功会写 `activation-plan.json` 和 `workflow-enable.patch.yml`。`check` 只证明当前配置、载荷及共享解析核对通过，不证明 Host 空闲、浏览器、模型或用户授权。SDK2 使用公开解析服务的临时作用域，不靠补开发链接或旧 fallback 修补函数。

### 受控启用与安装验收

核对 3080 无冲突、启动范围已明确后，启动器参数要写在 Web 参数之前；已有 overlays 仍在启用层之前按原顺序传入：

```powershell
& $workflowNode $workflowCli --profile $workflowProfile `
  --patch C:/DSHProduction/private/activation-v1/workflow-enable.patch.yml `
  --no-open --host 127.0.0.1 --port 3080
```

guard 先检查身份、指纹、载荷和 writer，再在 controller 可用后审计实际预设子树；审计通过前不绑定工作流根。后阶段失败可能已经初始化 Journal 后再关闭，不能一概说失败从未打开数据库。

安装验收至少核对：真实 Home／Profile／CLI／版本与 writer 一致；原生界面只有一个聊天输入；显式选择工作流预设可见；页面无错误；已有记录与对象可读；正常停用保留数据。空白会话可能不显示运行视图，并非插件失效；没有任务就不应制造假进度。真实任务和门禁验收另行安排，不为烟测擅自发送模型任务。

完整步骤与边界见 [首次 Profile 激活流程](docs/operations/workflow-profile-activation.md)。安装后生成的计划、路径、Profile 配置和启动认证日志均应私有保存。

## 日常使用与停用

先在原生界面选择工作流预设，确认当前工作区，再表达目标、约束和可接受结果。Agent 补问时先明确关键问题；门禁只批准当前展示的版本，必要时展开完整计划。执行中用工作流页签看阶段、角色、最近事实和下一步；自然语言“继续”不扩大既有权限。

一个合适的需求表达示例是：“在这个独立示例项目里增加本地配置校验，只改 `src/config` 和相应测试，不安装新依赖、不访问网络。先确认错误行为和验收标准，命令需要核对后冻结。测试失败可以在同一范围返工一次。”这只是对话输入示例，不是已批准任务；实际工作区、命令和标准仍须补齐并走门禁。比起只说“做一个工具”，明确范围和不可做的事更容易建立可执行合同。

拒绝或调整需求可以回到澄清；要停止就明确要求停止并观察确认状态。需要文件撤销时另提请求、核对精确文件清单，不把停止当成自动撤销。新建目标必须新 run，不能把旧成功或批准复制到新任务。

停用前确认整个 Host 没有活动任务、待退出进程或未处理写入，按正常退出方式关闭。下次启动省略最后的工作流启用 overlay，保留其他参数和全部数据。需要移除包时在停机后通过官方 `plugin remove ... --config.ignore-scripts=true`；移除不等于删除历史或可以续跑缺少工具的旧会话，不支持活动 Host 热卸载。

## 升级与兼容回退

维护时分开保护插件代码、工作流私有目录、原生 Session 和项目文件。工具 `capture` 不是整个 Host 的备份，不能用它代替原生历史和工作区备份。

1. 核对精确目标版本、组件、计划和资源政策，取得维护范围并确认整个 Host 空闲且正常退出。
2. 使用当前有效计划捕获新的私有当前数据检查点；工具拒绝已有 writer，不自动回收锁。
3. 通过官方机制离线安装目标归档，不启动；用目标兼容工具核对当前完整回放并生成新启用方案。
4. 受控启动后核对新增／既有数据、原生历史、guard、界面和正常停用；失败现场保留。

```text
node <已验证工具包>/scripts/transition-workflow.mjs capture --plan <当前计划> --output <新检查点目录>
node <目标安装包>/scripts/transition-workflow.mjs prepare --checkpoint <checkpoint.json> --mode upgrade --output <新启用目录>
```

代码回退必须保留升级后新增的当前数据：先捕获**最新当前数据**，再核对**已归档目标载荷**，离线安装该目标后使用验证工具执行：

```text
node <已验证工具包>/scripts/transition-workflow.mjs prepare --checkpoint <最新当前checkpoint.json> --mode rollback --rollback-checkpoint <归档目标checkpoint.json> --output <新回退方案目录>
```

升级前的旧库不能覆盖现在的库。目标不认识新协议、配置或数据有变化、载荷不符时必须拒绝；若当前有效方案已损坏，保留现场人工核查，不改摘要或伪造检查点。

同版本配置变化使用 `--mode reconfigure --accept-config-change`，只表示接受已审阅配置变化，不允许改变资源政策、升级或恢复旧数据。当前工具仅接受特定编号 RC 和固定 Host，RC.11↔RC.12 已有限验收；不支持任意旧版本、跨 SDK、通用 schema 迁移或正式 `1.0.0` 方向。详见 [维护流程](docs/operations/workflow-profile-transition.md)。

## 正式发布流程

当前已经做的是公开保存源码；没有自动发布 npm、GitHub Release、稳定版本或选择开源许可证。源码公开不表示项目所有者已授予某个开源许可证。

正式发布必须依次完成：

1. 冻结支持范围、官方基线、源码提交、Profile 与数据协议，逐项完成 Gate A–E；保留失败和已知限制。
2. 由项目所有者决定许可证、包名与 scope、分发渠道、版本和授权责任；检查第三方声明及其义务。
3. 实现并验证稳定版本构建／升级回退路径。现有 `candidateVersion` 和验证政策故意拒绝正式 `1.0.0`，不能删安全检查来制造生产标签。
4. 对最终源码做干净构建、全量回归、同包运行和安装维护核验，冻结输入、载荷、清单和归档摘要；不能仅给 RC 改名字。
5. 发布前审核公开内容，排除原始日志、数据库、Session、启动 token、Cookie、凭据和本机配置；更新 README、CHANGELOG、安装文档及兼容表。
6. 在明确授权后提交 tag／GitHub Release／npm 等选定渠道，并从发布渠道重新取得产物核对版本、摘要与实际安装。
7. 保存私有证据和支持／回退方案；后续 DSH 更新逐版本做兼容验收，不默认最新版本兼容。

当前默认适合接续的是“克隆源码 → 固定环境重建 RC → 独立 Profile 验收”。若未来通过 tarball 交付，至少提供包、SHA-256、版本清单、安装维护文档、第三方声明和明确准入结果；是否发布 npm 由所有者决定，不能直接去掉 `private: true`。

## 故障处理与诊断

安装包提供只读原生采集和脱敏诊断，使用匹配版本的安装包入口，不使用旧设备的旧 lib。原生采集只读有界范围，不是原子空闲证明；JSON 报告也不是修复操作。

```text
node <安装包>/scripts/capture-workflow-native.mjs --startup-log <稳定私密启动日志副本> --output <新的私密采集.json>
node <安装包>/scripts/diagnose-workflow.mjs --snapshot <一致性Journal副本> --data <对象目录> --native <采集.json> --workspace <显式允许的工程目录> --output <新的脱敏报告.json>
```

不要把活动数据库直接当一致性副本，忽略 WAL／SHM 或只复制一部分旁文件。启动日志含认证链接，不能粘贴到公开 issue；采集结果中的身份和活动关系也应私有保存。脱敏报告分享前仍需人工检查，私密对应表绝不上传。

| 症状 | 优先核对 | 不应采取的捷径 |
| --- | --- | --- |
| 预设／工作流页签不可用 | Host 版本、四项默认停用、启用方案、guard 与真实声明 | 手工强开行、改默认 Agent、绕过审计 |
| 启动后指纹过期 | 欢迎偏好、Profile／Home／overlays、包或 Host 是否变化 | 修改摘要、删除 guard |
| HMR 准入失败 | 最终组合中的每一项官方 HMR 是否明确停用 | 只填旧 startup 字段 |
| 诊断入口报缺少 `ws` 等模块 | 是否误用未安装依赖的源码目录，安装包依赖和真实路径是否完整 | 单独复制脚本，补不明来源的全局／开发链接 |
| writer 拒绝 | 实际 Host、退出、记录来源、备份与恢复边界 | 删除锁，按旧 PID 杀进程 |
| 预算／并发暂停 | 当前资源和退出占位，原生预算／资源入口 | 自动补额、后台重试、假释放槽位 |
| unknown／未确认停止 | 精确旧执行证据与人工处置流程 | 把查无进程改成 stopped／PASS |
| 历史可列出但打不开 | 原生正文格式和固定 DSH 读取能力 | 改格式版本、清目录、补造结局 |
| 文件摘要不符 | 后续正常编辑、其他 run、检查点和当前文件 | 用旧检查点覆盖当前内容 |
| SQLite I/O 失败 | 保留原件、错误码、一致性备份和受影响范围 | 反复写入重试、宣布新环境证明旧库修复 |

诊断／采集退出码通常为 0 所查范围无冲突或未观察活动、2 需要处理、3 未完成、1 参数／导出失败；这些含义各以入口文档为准。非零不能包装为全部通过，0 也不认证在线版本、全库健康或 OS 退出。完整说明见 [诊断与隐私边界](docs/operations/workflow-diagnostics.md)。

## 私有档案与换机备份

**GitHub 只能恢复公开源码，不会恢复原实验历史。** 设备弃用前另外通过可信私有存储或移动介质保存：

- 原项目 `.dsh`：Journal、内容对象、文件检查点、激活及验证原始回执，包含失败样本。
- 实际 DSH Home：原生 Session、附加对象、Profile／Home 配置、依赖锁与对应版本说明；不要只按默认目录猜测。
- 已验证候选归档、载荷／输入清单、运行证据涉及的临时 Home 和原生日志；有些不位于项目目录，而在系统临时目录。
- 原工程工作区及 Git 基线、未提交文件；工作流文件检查点不等于完整工程备份。
- 需保留的模型配置与凭据，用受控私有方式处理；也可以在新设备重新配置并轮换旧凭据。

先确认相关 Host 已正常停止，再制作一致性备份和哈希清单，并在另一位置验证可读取性。原件保留，不以验证副本覆盖；备份中的 writer 标记是历史证据，不直接作为新 Home 的活动锁。迁移原历史必须专门在副本评估，不把目录整体复制当无损升级。

备份涉及真实任务文本、代码、模型凭据和认证日志，应加密并限制访问；Windows mode 参数不等于 ACL。不要公开上传 `.dsh` 或“全部日志”，不要假定 Chat 聊天记录可替代运行证据，也不要假定临时目录会永久保留。

用户已经确定：新生产 Profile 独立、旧实验档案全部保留。旧格式只在副本核查；3 个根会话／8 个已有结局运行的旧 v0／descriptor v2 不兼容，以及历史退出未知和 `SQLITE_IOERR_TRUNCATE` 物理根因未知仍保留，不宣布修复。具体边界见 [历史问题核验](docs/validation/2026-09-20-native-history.md)和[本次设备交接](docs/operations/device-handoff-2026-10-09.md)。

## 尚不支持和接续注意事项

- 不支持任意动态 DAG、无限返工、动态角色或自由跨任务产物协作。
- 不支持 L2/L3、自动部署、外部生产系统写入、命令间接副作用的通用补偿。
- 不提供 OS 级读取／网络／进程隔离，不承诺任意后台进程存活核对或进程树全部退出。
- 不支持选择性复验、全局语义规则、独立规则管理页和跨 Profile 自动规则迁移。
- 不支持任意原生历史格式迁移、运行中热卸载或任意解析器降级。
- 原生 fork、导出、删除不自动同步插件 Journal，也不继承工作流批准；需要分别评审保留关系。
- 模型服务的版本、费用、断流、代理和网络故障属于新设备配置风险，测试夹具不能替代真实连通性与质量验收。
- 重型工程、满容量历史及多个长运行角色的长期性能仍需按实际使用验证；有限单机样本不证明长期无泄漏或全场景 SLO。
- 公开仓库没有自动 CI／正式发行流水线的完成证明，不能把“可以运行脚本”当作已经部署持续发布服务。
- 新设备上的 Home、路径和全局命令都重新识别；旧许可、进程 ID、旧成功记录和技术专项不自动成为新设备的生产授权。

## 维护文档与接续助手入口

后续每次变更一起更新 [CHANGELOG](CHANGELOG.md)、[Production v1 状态](docs/operations/production-v1-status.md)及相关验收摘要。记录源码提交、官方基线、归档摘要、验证日期、覆盖范围和限制；失败后另写新结果，不能覆盖失败样本或混用版本。

让新设备上的助手从以下任务说明接续即可：

> 先读 PROJECT_GUIDE.md、docs/operations/production-v1-status.md 和相关安装维护文档，检查实际仓库与环境，不按旧 PID 或 F 盘路径操作。目标是 Windows／本地有人看护的 L0/L1 正式 Production v1，不是端口工具或重建聊天 UI。RC.12 技术专项已有证据；独立生产环境、新版真实使用、独立体验和正式交付未完成。保留旧档案，先确认当前阶段的操作范围；不得绕过 guard、复用旧批准、删除 writer、恢复旧库覆盖新数据或把脚本化样本当独立验收。

深入文档按目的选择：

| 目的 | 入口 |
| --- | --- |
| 实际完成度和任务顺序 | [Production v1 状态](docs/operations/production-v1-status.md) |
| 全部生产门槛 | [准入计划](docs/design/workflow-production-readiness-v1.md) |
| 原生交互与阶段呈现 | [原生 UI](docs/design/workflow-native-ui-v3.md)、[确认卡合同](docs/design/workflow-confirmation-card-v1.md) |
| 工程、权限、证据 | [工程闭环](docs/design/workflow-native-project-pilot-v1.md)、[控制层合同](docs/design/workflow-control-plane-contract-v1.md) |
| 构建与安装 | [发行工程](docs/operations/release-build.md)、[首次配置](docs/operations/workflow-profile-activation.md) |
| 升级和回退 | [离线维护](docs/operations/workflow-profile-transition.md) |
| 资源与停止 | [资源策略](docs/operations/workflow-resource-policy.md)、[Host 准入](docs/design/workflow-host-admission-v1.md) |
| 排错与数据 | [诊断](docs/operations/workflow-diagnostics.md)、[历史边界](docs/validation/2026-09-20-native-history.md) |
| 规则沉淀 | [沉淀复用](docs/design/workflow-learning-v1.md) |
