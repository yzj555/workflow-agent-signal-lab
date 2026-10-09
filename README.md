# Workflow Agent Signal Lab

面向 DSH 的工作流 Agent 预设与插件：在原生输入框表达需求，通过原生门禁确认授权，以只读工作流视图查看阶段、角色、证据和下一步。

本仓库是工作流插件，不是 DSH 核心，也不是端口管理工具；端口工具只是早期测试任务。

首次了解项目或换设备接续，请先阅读 [项目完整指南](PROJECT_GUIDE.md)，其中汇总了架构、制作进度、构建、安装、升级回退、发布与故障处理；[换机接续说明](docs/operations/device-handoff-2026-10-09.md)保留本次设备交接范围。源码与锁文件可从仓库恢复，原始实验档案、凭据和本机配置不在公开仓库中；当前仍是候选，不是正式生产版。

## 能力与当前状态

2026-10-08：最终目标为正式 **Production v1**；当前在发布候选验证阶段，尚未完成生产准入。剩余工作与验收状态见 [Production v1 执行清单](docs/operations/production-v1-status.md)。

新版兼容进展：固定 0.2.0-rc.2 的 **RC.12 已合回主工程，并从主工程复现两次干净构建各 588/588**；220 个输入、43 个载荷及归档与前序验收包完全一致。同包通过实际双 L1／四角色并行、命令第 41 次拒绝、120 秒超时、双 L0 各一次返工、模型第 241 次调用前拒绝及实际 30 分钟到限；7,010 次成功快照 RPC 和完整冷回放通过。新版七类恢复分支也已逐项绑定两轮的 28 个明确用例，不沿用旧 SDK 结论。模型与问答来自限定合成提供者，不当作独立真实使用；收尾计时超量和原生只读回放限制保留，不作毫秒级强杀或可写 UI 保证。此前原生准入、升级、保留新增数据的兼容回退和卸载重装通过，失败及缓存限制保留。旧主目录 `lib` 与开发链接未替换，生产接入及独立真实使用仍待完成，**不是生产准入通过**。见 [主工程整合与恢复证据](docs/validation/2026-10-08-dsh-020-canonical.md)、[同包文本与资源边界](docs/validation/2026-10-08-dsh-020-resource.md)、[维护与数据保留](docs/validation/2026-10-08-dsh-020-maintenance.md)和[原生准入](docs/validation/2026-10-08-dsh-020-installed-activation.md)。

同一 RC.5 已通过隔离安装后的 L0/L1 原生运行、4 角色并行、模型／命令额度、120 秒命令超时及 30 分钟有效时长到限验证；6,988 次实际快照 RPC 和冷读一致。正式接入已选择独立生产 Profile、保留全部实验档案，但还没有创建或切换。现有 3080 在验证期间更换了进程，当前 Profile 绑定待核对；本工作区旧文件和 20 行记录未变，整批环境保护汇总为 needs-attention，不作上线批准。见 [本批验证与限制](docs/validation/2026-10-08-installed-runtime.md)。

发布工程已有不依赖 DSH 开发目录的预构建 `.tgz` 候选。旧 SDK 的 RC.7 补齐可分发原生诊断采集，两次独立生产构建各 528/528，211 个输入、42 个载荷及归档一致；安装后实际采集与脱敏导出通过，运行时 lib 与 RC.5 一致。此前 RC.5 的首次配置、已有数据重配置、编号 RC 升级、受控启动拒绝、保留新增记录的代码回退和空闲停用已通过固定旧官方 Host 验收。全局 DSH 入口当前指向 0.2.0-rc.2 源码；RC.7 的固定基线为 0.1.5-rc.1，RC.8／RC.9 为 0.2.0-rc.2，不同基线的验收不能互相外推。当前 3080 未因此部署；生产 Profile 创建、实际接入、独立真实使用及正式交付未完成。采集未观察到活动不代表全 Host 空闲或获得重启许可。见 [旧基线采集验收](docs/validation/2026-10-08-native-capture.md)、[构建说明](docs/operations/release-build.md)和[已有数据维护](docs/operations/workflow-profile-transition.md)。

- 需求澄清、合并确认、计划／执行授权；明确选择预设后遵循流程。
- 协调、只读架构分析、实现、工程测试、代码审查、黑盒验收的角色与权限边界；固定串并行路径和有限返工。
- 持久化 Journal、停止与未知退出区分、文件检查点、撤销中断恢复和逐项经验沉淀。
- 原生聊天与问答；工作流页签只显示状态与证据，不提供第二个聊天窗口。

状态为**受控内部 Alpha／本地有人看护的开发辅助**，不宣称无人值守生产执行。撤销恢复版本已于 2026-09-20 经授权加载到本机 3080，12 项真实页面只读检查通过，20 条历史记录不变；对应源码的历史干净构建两轮 364/364 通过，本次激活没有重跑或增加这些测试。公开托管不等于已经发布可直接安装的 npm 包。

同日后续只增补恢复测试：既定七类中断矩阵逐项通过，Gate B 关闭；专项 19/19、连续两轮全量 378/378，双端类型检查通过。没有再次重启或修改线上记录。Gate A/B 已有通过证据，C/D/E 仍待完成；见 [本次恢复验收](docs/validation/2026-09-20-gate-recovery.md)。

当前最新源码另含**尚未激活的文件容量修正**：超限写入前置拒绝、检查点容量预检和有界读取。隔离候选两轮 391/391，20 条历史状态兼容；不代表当前 3080 已加载，Gate C 仍在补齐。见 [候选核验](docs/validation/2026-09-20-resource-guards.md)。开发验证新增官方 `dsh-fs-local` 测试依赖，需重新执行下方链接脚本；不替换生产文件提供者。

其后的**日志容量候选也未激活**：9000 条事件或 14 MiB 时提前暂停新执行，预留停止与退出记录空间，并提供无需模型的原生核对入口。最终同一候选两轮 405/405（测试文件并发 4），双端类型检查、计时交叉探针和 20 条历史兼容检查通过；旧失败证据保留，不宣称 Gate C／生产版已经通过。见 [日志容量核验](docs/validation/2026-09-20-journal-capacity.md)。

最新**故障处置候选仍未激活**：共享存储写入失败及时封闭执行、撤下旧可信快照；当前角色调用异常明确提示处理，不能作为业务验收失败或自动重跑。两轮 418/418、双端类型检查、真实隔离 SQLite／HTTP／PowerShell 验证和 20 条历史兼容通过。见 [故障核验与剩余边界](docs/validation/2026-09-20-storage-faults.md)。

现已增加[只读诊断和脱敏导出](docs/operations/workflow-diagnostics.md)：新增 20 项测试，最终两轮 438/438，实际核对 20 行／26 个 run；关联目录告警、退出未知与历史文件差异如实保留，数据报告不是全绿。该增量未改变运行时构建或线上状态，完整 C/D/E 仍未通过；见 [验证记录](docs/validation/2026-09-20-diagnostics.md)。

后续查明其中 24 项告警为 DSH 拒绝旧 v0／descriptor v2 原生历史，涉及 3 会话／8 个已有结局的运行；没有改写旧记录。新增 4 项兼容回归，两轮 442/442；Journal 可读不代表原生对话完整兼容，原 Profile 无损升级仍需单独处置。见 [原因与影响边界](docs/validation/2026-09-20-native-history.md)。

记账性能候选已完成同输入两轮 450/450 及 30 分钟持续验证；随后 Host 并发候选完成两轮 466/466，整批准入、未知占位及新用户轮解封均有隔离证据。两批均**未激活**，旧基准不外推为新版本全链路长跑。见[资源候选](docs/operations/workflow-resource-policy.md)、[记账核验](docs/validation/2026-09-20-budget-performance.md)和[Host 准入核验](docs/validation/2026-09-20-host-admission.md)。

主要文档：[基础使用与限制](docs/operations/basic-production-usage.md)、[生产准入清单](docs/design/workflow-production-readiness-v1.md)、[撤销恢复协议](docs/design/workflow-file-rollback-recovery-v2.md)、[候选验证摘要](docs/validation/2026-09-17.md)、[本次激活摘要](docs/validation/2026-09-20-activation.md)。

## 开发与验证

当前主工程发行基线为 Windows、Node.js 26.1.0、DSH `0.2.0-rc.2`（官方源码提交 `639ed015397290b3745d163aafe02ffee4aa3f84`）；`0.1.5-rc.1` 的结果保留为历史。独立发行构建已经通过类型检查、构建及全量测试；主目录原有 `lib` 和开发链接尚未重建，不作为生产入口。开发者需要先准备已安装依赖且已构建的匹配 DSH 源码，在不供 Host 使用的副本中预检并链接：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-dsh-dev.ps1 -DshSourceRoot C:\path\to\deepseek-harness -CheckOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-dsh-dev.ps1 -DshSourceRoot C:\path\to\deepseek-harness
npm run typecheck
npm run build
npm test
```

这是一条开发验证路径，不是生产安装方式；不要在已运行的部署目录直接执行 build。独立发布构建使用上方另列的入口，不需要这个开发链接脚本。`node_modules`、编译输出和 DSH 上游源码不进入此仓库；现有锁文件与 `pnpm-workspace.yaml` 已验证用于干净候选构建。隔离 RC 升级／回退及 Web 启停已验收，正式版本与同基线生产接入仍待完成。

接入本地 DSH 时参考 `cordis.patch.example.yml`，生成自己的 `cordis.patch.yml` 并填入私有绝对数据目录，随后按官方插件机制接入现有 Web Profile。不要覆盖已有配置、复制他人的凭据或直接运行历史激活脚本。示例没有修改设置／凭据路径，也不禁用其他插件。

## 公开范围

仅保存插件源码、测试夹具、预设、文档和工程脚本。`.gitignore` 排除运行记录、会话、日志、数据库、密钥、依赖、构建输出、本机配置及独立端口测试项目。

`scripts/` 中的在线验证和激活脚本是历史实验工具，部分绑定当时的绝对目录、会话或 PID，**不能当成通用安装／重启工具直接执行**。设计文档和下方开发记录保留历史语境；其中 `.dsh/...` 证据链接指向未公开的本机记录，不是仓库缺失的运行依赖。公开摘要只描述已核验的结果与限制，不上传这些原始数据。

## 原本机开发记录

以下保留历史进度，用于理解实现过程，不代表读取此仓库的机器已有相同安装和授权。

最新候选（2026-09-17，后于下列记录）：文件撤销中断恢复已实现，干净构建后两轮 **364/364**、原生页面只读回放 4 项通过，**尚未激活到 3080**。完成前中断需重新核对和新确认；完成后中断只核对清理备份；冲突不覆盖用户内容。新增协议首次落盘后不可直接降级旧解析器。见 [核验记录](.dsh/activation/workflow-rollback-recovery-20260917/verification.md)、[协议与边界](docs/design/workflow-file-rollback-recovery-v2.md)。以下为此前已部署／补测记录，不代表本候选已上线。

最新补测（2026-09-17）：五项关键中断切点已补齐验证：半写入文件、返工待重做、验收完成未交付、验收后外部改文件、沉淀部分决定。连续两轮专项 5/5、两轮全量 **347/347**。本轮未改运行时或重启 3080；20 条线上记录不变，干净重建的候选与已部署构建逐字节一致。文件撤销事务等剩余生产准入仍未关闭。见 [核验结果](.dsh/activation/workflow-critical-recovery-20260917/verification.md) 与 [矩阵范围](docs/design/workflow-critical-recovery-v1.md)。

当前增量（2026-09-17，后于下列历史记录）：**会话首次落盘与时长定时器两项修复已激活至官方 3080**。全量 342/342，真实命令三类预算连续 6 轮通过；空输出目录重建与旧版本回放兼容通过。用户授权的一次空闲重启后，12 项只读页面检查通过，20 条历史记录不变；当前 PID 54716。没有提交模型任务、批准门禁、修改预设或启用整轮预算。仍不宣布完整生产准入。下一步聚焦剩余关键恢复切点、本机发布恢复及小范围真实试用，不扩张高级功能。见 [交付记录](.dsh/activation/workflow-basic-production-20260917/verification.md)、[基础使用与收口](docs/operations/basic-production-usage.md)、[变更记录](CHANGELOG.md)。

## 此前验证记录

本轮针对性验证（2026-09-17）：补充**已持久化原生会话的隔离跨进程中断矩阵**。活动子 Agent、未结算计时、并行检查中的真实命令、待回答补额门禁四项，连续两轮专项 4/4；新增四项后，两轮全量 **333/333**，双端类型检查通过。重复冷启动不重复派发、扣账或批准，未知退出不冒充停止。没有中断 3080，20 条线上记录、Host、运行时源码／构建、预设及配置均不变。首次会话落盘窗口在快速夹具中暴露缺口、一次全量旧命令用例超时仍未根因闭环；后续转绿不覆盖失败样本。仍是内部 Alpha，下一步优先补这两项及其余精确恢复切点，整轮预算继续默认关闭。见 [跨进程核验](.dsh/activation/workflow-crash-recovery-matrix-20260917/verification.md)、[矩阵边界](docs/design/workflow-crash-recovery-matrix-v1.md)、[未闭环观察](docs/design/issues/crash-recovery-matrix-20260917.md)。

最新进展（2026-09-17）：在此前真实 Windows 进程隔离测试之后，已完成官方 **3080 真实模型的两项在线预算验证**：命令额度不足时第二条冻结检查未启动；累计有效时长到 120 秒时中断正在运行的检查，并核对测试进程及受控后代退出。二者都没有误记业务 PASS/FAIL、自动补额、重试或撤销代码，随后经原生门禁明确结束。恢复后全量 **321/321**、Host／客户端类型检查通过。

本次按用户授权建立两个独立测试会话并完成三次空闲重启，未在活动运行中强停 Host。配置已按原字节恢复，整轮预算仍默认关闭；原 18 条记录不变，新增两条完整留档，全部 20 条在恢复重启前后一致。插件运行时源码／构建／预设与 DSH 核心未改。当前官方 3080 PID **34440**。原生操作由助手代理，不能冒充独立用户体验验收；前期隔离测试和 I/O 失败证据继续保留。

同日后续显示修正已完成：已结束且确认停止的角色显示“已停止 · 本轮已结束”，旧处置建议收进原生“历史中断记录”；unknown/stopping 继续警示。新增 8 项回归，当前 **329/329**，真实 3080 宽窄界面及键盘展开 **12 项**通过。只改显示层，20 条记录、Host、配置和预设不变，无重启或模型任务。刷新页面即可加载。见 [显示修正核验](.dsh/activation/workflow-agent-terminal-ui-20260917/verification.md)。

整体仍是受控内部 Alpha、P2 可靠性补齐阶段，Gate C/D 未通过。下一步补活动中断、独立体验与发布验收；本组不等同于全部崩溃矩阵通过。见 [在线核验](.dsh/activation/workflow-budget-live-matrix-20260917/verification.md)、[问题闭环](docs/design/issues/budget-live-matrix-20260917.md)、[隔离矩阵与边界](docs/design/workflow-budget-process-matrix-v1.md)。

这是一个真实接入 DSH 的独立实验工作区，用于实现 Workflow Agent 预设及其只读运行面板：

1. 用户选择 `工作流 Agent · Signal Lab` 预设后，Agent 是否会先完成需求分析、补问、合并与显式确认，而不是不明不白开始执行。
2. 用户继续在原生输入框交流，通过与「对话／轨迹」并列的原生「工作流」页签查看记录；不在输入框上方添加独立卡片或重造聊天窗口。

## 边界

- 不修改 `F:\dsh\deepseek-harness`。
- 按用户确认，使用官方 `dsh web`、默认 Web Profile、端口 **3080**。原生会话由 DSH 保存；早期隔离 Profile 的文件保留，不自动迁移。
- 插件及新增工作流日志独立存放在本工作区；日志目录为 `.dsh/workflow-runtime`。不会把 `workflow/event` 塞入原生 Session 日志。
- 模型与凭据沿用用户现有配置，不复制或输出凭据；本版自动化测试使用脚本化模型，不调用付费模型。
- 所有需求表达、确认与纠偏继续使用原生输入框，没有第二套聊天 UI。**2026-09-03 已接入官方 3080，完成一轮真实文本交付**；不能把旧会话当作已有结构化授权的运行。随后完成的提示词／工具隔离修正已于当日 18:35 按用户授权重启加载；启动与只读页面检查通过，没有重复提交真实模型任务。

## 本轮进展 · 2026-09-15

已实现 **未知运行的受审计人工处置入口**：协调者逐项整理核实依据，用户通过原生门禁决定，批准后以 `ABANDONED / 人工结束` 结束旧 run。原 unknown、退出凭据和验收记录不改写，不自动续跑、重试或撤销文件；新目标仍须重新确认。

类型检查、构建与全量 **220/220** 通过（新增 13 项边界测试及 1 项官方原生问答／工具集成）。随后在真实模型、原生问答和官方 3080 上完成独立在线验证：实际 Host 中断后 unknown，拒绝后继续阻塞，明确确认后 ABANDONED，重启后完整留档，新目标重新确认而不继承旧批准。在线组未改变运行时构建，220 项为此前同一构建的证据，不重复计数。

**人工处置机制的本组在线路径已通过，三项通用显示问题也已修复。** 上轮独立测试先在 revision 43 人工结束并验证重启不变；随后新目标停在新的确认门禁、0 个新 Agent，收尾取消该未执行目标后 Session revision 55，前一人工结束和 unknown 历史均保留。本轮显示修正后，包含该测试的全部 17 条 Journal 内容摘要不变，受保护 unknown 保持 revision 35、业务 PASS 保持 revision 126。

新增原生 composer 的精确人工处置呈现，按钮直显「保持阻塞／人工结束本轮」，顶部直显「待人工处置／人工结束」；处置原因与每个 Agent 的完整核实依据可展开，不再拼入摘要。类型检查、构建、**224/224** 回归，以及真实 DSH 渲染器／官方 PendingQuestion 的只读回放通过；回放答案仅存测试浏览器，不向 Host 审批。3080 已提供新前端，无需重启 Host；DSH 核心未改。协议见 [人工处置入口](docs/design/workflow-manual-recovery-v1.md)、[原在线验收](.dsh/activation/workflow-manual-recovery-20260915/verification.md) 和[显示修复证据](.dsh/activation/workflow-manual-recovery-ui-20260915/verification.md)。下一步补整轮预算及其余 Gate B/C 矩阵，独立体验验收仍未完成；当前仍是受控内部 Alpha。

## 实现与验证记录（含历史阶段）

- Contract v1 已定义需求、设计、任务、验收与产物的版本化记录。
- `workflow/event` 的严格事件词汇、任务 DAG、门禁版本失效、Agent 续接边界和验收账本重放器已经实现并具备自动测试。
- 第二切片已接入插件独立 Journal：同一根会话串行提交、版本冲突检查、单行 SQLite 原子持久化、冷恢复和单 Host 写入者保护。
- 只读状态通过官方 Connection 的 `/workflow-runtime/snapshot` 获取。客户端已从聊天文本推断切换为结构化记录；同一会话的简短状态与原生工作流视图共享一次读取。
- 断线、读取失败或旧版本响应不能保留“已确认”的表象。旧会话没有新 Journal 时显示“尚未建立运行”，不伪造迁移或批准记录。
- 160 项自动化测试通过，覆盖协议、持久化、读取、受控文本与 L1 工程闭环、原生 UI 入口生命周期，包括实际官方 AgentLoop、角色工具隔离、Host 文件／命令证据、架构先行、并行测试与审查、模型侧源码隔离验收、同 ID 返工、用户门禁文件撤销、阶段投影、第一道需求理解门禁的精确选择／回执、原生决定来源审计、候选级沉淀修订、跨 run 保留产物来源列账、根协调响应单次自动恢复与二次停滞防循环、受控故障注入边界、文本预检与跨键重叠拦截，以及浏览器 bundle 的 Node 内置模块禁入。原生循环测试的模型与用户回答均为测试替身。
- 展示已改用官方原生页签、折叠组件、状态图标、主题与内容宽度；旧输入区卡片和自制浮层已撤回。另有 10 组浅／深色、宽／窄窗口及待确认／运行／失败／结束／已撤销状态的展示检查，不作为真实业务运行证据。
- 阶段下方直接标记完成／确认、并入其他阶段、本次无需、尚未接入、未执行等状态；交付有结论后显示结束标识，不再保留蓝色进行中。文本路径由 Host 核对已保存合同后识别，不从阶段位置或缺少记录推断“已跳过”。
- 新版源预设不继承原始 Crew／Standard 工具。协调 Agent 仅有工作流控制工具；L0 文本与 L1 工程子角色按任务包获得不同能力。实现 Agent 只有受控文件读写／检索工具，不获得 Shell 或检查清单；冻结工程检查和黑盒验收分别归独立测试与验收角色。
- **受控 L1 工程闭环已在源码与离线原生 AgentLoop 中通过**：可选架构评估 → 实现 → 工程测试 ∥ 代码审查 → 模型侧源码隔离的黑盒验收。Host 核对实际改写文件、当前摘要和冻结命令结果；工程测试、代码审查或验收的真实失败可在同一范围内返回实现一次，随后完整重跑下游波次。
- **L1 工程版已重载到官方 3080**：首次工程版实例 PID 31560 使用全局官方入口、默认 Web Profile 和本工作区；在线预设描述已返回 L0/L1 能力。真实页面只读回归显示插件加载一次、零插件输入框、一个原生输入框、页面错误为零。既有 74 个会话均未运行，Journal 逻辑内容未变；本次没有提交真实工程任务、调用付费模型或替用户批准。
- **真实文本试用已完成**：「工作流实测 · 维护通知」经补问、合并和原生门禁批准后，由内容 Agent 生成演示通知、独立 QA 完成 10 条验收，Journal revision=42、outcome=PASS。产物摘要核对一致；本轮没有返工，不能用它证明真实模型的返工质量。
- **本次隔离修正已构建并通过离线验证**：按本模式移除 Crew 的两个冲突提示贡献，最终模型工具列表严格区分协调者／子角色；保留安全、审批与执行守卫。实际加载官方 `report` 组件测试其隐藏与拒绝，并覆盖子 Agent 冷恢复、空白会话切入／切出本模式。未改 DSH 核心或全局 Crew 配置。
- **客户端修正已在真实页面核验**：完成后的两个角色显示「已完成」，不是「待续接」。重启后记录仍为 revision=42；只有一个原生输入框、零个插件输入框，无页面异常。
- **Host 更新已重启部署**：隔离修正和阶段只读投影于 2026-09-03 完成部署。2026-09-07 再次加载含 `latestReturn` 的只读快照协议时，将前一实例 owner 留存为 `writer.lock.retired-20916-20260907-v3-reload`，再以相同官方命令、默认 Profile 和 3080 启动 PID 3264；74 个会话均未运行，stderr 为空。
- **Product Signal v2 已完成，裁决为 `revise`**：S1 的需求澄清空态没有提供可判断信息；S2 的阶段位置更直观，但五秒识别、返工原因和明确复用意愿未达门槛。S1、S2 两个有效场景均失败。S3 因评估者在对照前泄露标准答案而按协议作废、不采分；即使重测通过也无法达到 `2/3`，因此不继续消耗用户观察。全程仍为 0 模型调用、0 批准、0 业务写入，Journal 与既有交付物不变。证据位于 `.dsh/evidence/product-signal-v2`。
- **Product Signal v3 已完成，裁决仍为 `revise`**：需求澄清的“是否需要我操作”已有明确直观增益，但五秒与复用意愿未达门槛；验证返工的来源、次数和原因虽已写入首屏，用户仍表示完全没有看出来。S1、S2 两个有效场景均失败；S3 因重复四问造成用户负担而立即停止、不采分。下一轮必须先改产品信息层级和低打扰评估方式，不能宣称 `proceed`。证据位于 `.dsh/evidence/product-signal-v3`。
- **v3 裁决后的显著性修正已完成**：返工次数、来源与目标阶段、原因、当前责任任务和重新验收路径已合并到“现在／接下来”的同一视觉焦点；“需要你”继续单独给出是否要操作。只读回放无页面错误，且 Journal 与产物未变化；本次不重开逐题问卷，也不据此改写 v3 的 `revise` 裁决。证据位于 `.dsh/evidence/workflow-return-salience-20260907`。
- **用户门禁文件撤销已部署并通过真实页面只读核验**：实现 Agent 每个文件第一次改写前保存二进制检查点；活动运行先停止，用户明确要求后按最新检查点展示恢复／删除清单并再次原生确认。摘要冲突整体拒绝，撤销后原验收仅作历史。当次部署实例 PID 41860 的端口、写入锁和 stderr 核验通过；10 组真实原生页面布局回归通过，“已撤销”同时出现于顶部终态、交付阶段和结束提示。该能力仅覆盖受控工作区文件内容，不补偿脚本的网络、进程、缓存或数据库副作用。证据位于 `.dsh/evidence/workflow-file-rollback-activation-20260907`。
- **第一道需求理解门禁已以 DSH 原生 composer 插件形式接入**：只精确接管“确认需求理解并允许只读规划”，明示“只读分析／不写文件／不运行检查”；不新增聊天框，第二道执行授权仍由 DSH 官方计划评审界面承载。一条真实 cross-module 任务已形成 revision 10 合同并停在第一道门禁，未放行、未实现、未运行检查。真实 3080 只读页面核验为 0 页面异常、0 禁止写请求、0 额外输入、0 水平溢出，证据位于 `.dsh/activation/workflow-requirements-gate-20260909/ui-first-gate`。
- **2026-09-10 闭环修正已验证并重载到官方 3080**：终态现在直接返回可用于 `workflow_learn` 的真实 `evidenceId`；实现角色已同时从模型工具视图、任务合同和 Host 最终守卫移除 Shell／工程检查能力；审计明确区分“通过原生用户权限门禁”与“可证明用户亲手点击”。当前官方回答协议不提供后者的来源证明。当时实例 PID 38892，监听与 writer owner 一致，HTTP 200、stderr 为空；99 个会话全部空闲，在线预设未损坏，只读页面 smoke 为 0 页面错误、0 禁止写请求。
- **2026-09-10 决定来源与沉淀治理已验证并重载到官方 3080**：新产生的确认、沉淀、停用和撤销决定会携带 `decisionAudit`，只声明用户权限、原生问答通道和 Host 关联 ID；由于官方回答载荷没有操作者来源，统一记录 `operator=unverified`，不再推断用户亲手点击或不存在代理。沉淀候选先做可证明的文本缺陷预检，再对本批及相关项目／预设活动规则做确定性高置信重叠检查；改换 `ruleKey` 不能绕过，选择“内容有误，退回修改”时整批不落盘。旧事件继续可读，但不会补造新版来源审计。当前实例 PID 26236、instanceId `c06be4a6-3471-4666-ab61-2489db38aee9`；监听、writer owner、HTTP 200 与官方命令一致，99 个会话全部空闲，stderr 为空。只读页面 smoke 为 1 个原生输入框、0 个旧独立界面、0 页面错误、0 禁止写请求，证据位于 `.dsh/activation/workflow-decision-learning-governance-20260910`。
- **2026-09-11 候选级沉淀修订已实现并通过全量回归**：选择“内容有误，退回修改”后，其他候选的采纳／不采纳决定立即保存；被退回项显示“待修订”，由原生输入框承载具体改法，随后只重开这一条确认。Journal 新增修订前后正文、原因和单调次数，旧日志仍可回放；没有新增聊天框或扩大权限。当前类型检查、构建与 142 项测试全部通过，真实 3080 重载状态见本次激活证据。
- **候选级修订已完成一轮真实闭环**：会话 `workflow-learning-item-revision-live-20260911-1603` 最终 revision 39、outcome `PASS`，6 项验收通过、0 失败。一条已采纳决定保持不变，另一条经原生门禁退回、原生输入修订后只重开该条并重新采纳；实现和验证阶段没有被错误重跑。该轮由代理在用户明确授权下操作，官方回答载荷仍只能记录 `operator=unverified`，因此证明机制路径成立，不把它写成“用户无帮助即可完成”的可用性结论。
- **首轮真实 L1 工程 Product Gate 已执行，判定为 `revise`**：会话 `workflow-production-l1-pass-20260911-1700` 的第一 run 两次真实工程检查失败，完成一次同 ID 返工和完整下游复验后按预算停住，以 `CANCELLED` 结束；第二 run 重新合并需求并取得两道原生门禁，工程测试、独立代码审查和模型侧源码隔离黑盒验收最终为 6 项硬标准通过、0 失败、0 豁免，outcome=`PASS`。随后三条经验逐项裁决，其中一条经原生输入单项修订后重新采纳。整体仍不升级：第二 run 继承了取消 run 留下的源码改动，Host 只把本轮再次触及的 2 个文件列为 delivery，尚缺从干净基线到完整交付的单 run 来源证据。Journal 最终 revision 192，详见 `.dsh/activation/workflow-production-l1-gate-20260911/verification.md`。
- **跨 run 保留产物来源列账已实现**：当前 run 的 `deliverables` 继续只表示本轮 Host 记录的产物；同一根 Session、同一工作区内仍与先前 run Artifact 摘要一致的文件改列为 `retainedPriorRunArtifacts`，并保留来源 run、来源 outcome 和摘要匹配证明。外部改写导致摘要变化时不会误报；黑盒 QA 只得到数量拆分，不得到源码路径。该修正已通过类型检查、构建和两项针对性回归，但不倒签首轮 Product Gate。
- **干净基线 L1 Product Gate 已通过，整体仍不升级**：会话 `workflow-production-l1-clean-pass-20260911-1810` 的 PASS run `42d3534d-4840-47d5-9b50-e338dcb2dfe7` 从干净 Git 基线完整产生 7 个当前 run Artifact，Host 摘要与磁盘逐项一致，前一取消 run 为 0 Artifact；工程测试 23/23、源码隔离黑盒验收 13/13、ledger 5/5，最终 revision 126。结合上一轮失败返回样本，Gate A 更新为 `pass`。本轮同时暴露 3 次需人工取消并从 Journal 续接的长时间根响应卡住，最长约 9 分钟，因此 Gate C 明确未通过，标签仍为“受控内部 Alpha”。沉淀候选经一次单项退回后改为条件化规则并采纳。令牌轮换重载后的实例 PID 1332、instanceId `8a9f712e-f8d9-43b9-94a4-7fcb609e0c89`，HTTP 200、129 个会话空闲，真实页面 1 个原生输入框、0 个插件输入框、0 页面错误。证据见 `.dsh/activation/workflow-production-l1-clean-gate-20260911/verification.md` 与 `.dsh/activation/workflow-post-clean-gate-20260911/ui-smoke/`。
- **P2-1 根协调响应有界恢复已取得真实 Host 需求入口证据**：普通根 turn 180 秒无进展、自动恢复 turn 120 秒无进展；等待 DSH 原生用户问答不计时。首次停滞只取消当前 turn 并保留 inbox，Journal 自动续接一次；恢复再次停滞、取消未收敛或恢复期间 Host 生命周期变化时转为「需要处理」，不再循环。官方 3080 上的精确测试会话使用 250ms 加速预算真实经过两个 turn，最终 Journal revision 2、attempt 2、`needs-attention`，且 run、批准门禁、子 Agent 均为 0；页面仅有 1 个原生输入框，无插件输入框、旧浮层、错误或写请求。测试后注入配置已移除并重启，最终 PID 13524、instanceId `67dce116-defe-455a-96d3-ae25a05f9e46`，131 个会话空闲，既有 PASS 会话 revision 126 回归通过。类型检查、构建和 160/160 自动化通过。该加速样本不等同于完整 Gate C，下一步是子 Agent lease 独立预算及其余阶段矩阵；证据见 `.dsh/activation/workflow-root-timeout-injection-20260914-b/` 与 `.dsh/activation/workflow-root-timeout-injection-final-20260914/`。
- **P2-2 子 Agent 独立预算与有界回收已实现**：每次派发分别限制接受、无进展、总时长、报告后退出与回收时间；超时立即撤权，只回收对应角色，其他已授权角色仍可收尾。Journal 与原生工作流视图明确区分正在停止、已停止·需要处理和未确认停止；迟到报告或旧 activation 结束事件不能结算新派发，运行中断不冒充验收失败。冷启动只识别未知状态、不自动续跑，旧 epoch 核验后的人工恢复入口仍待实现。全量 173/173、类型检查、构建通过；真实官方 AgentLoop 脚本化并行故障测试验证一侧超时、另一侧正常完成。3080 兼容核验保持既有 PASS revision 126。详见 [子 Agent 协议](docs/design/workflow-child-leases-v1.md) 与 `.dsh/activation/workflow-child-leases-20260914/verification.md`。
- **P2-3 冻结命令独立预算与退出核对已实现并激活**：默认命令上限 120 秒、退出宽限 15 秒，沿用官方原生工具与沙箱，按同一次 subprocess handle 核对托管范围退出；Agent drain 和退出码 0 不再单独作为检查成功／全部停止证明。运行异常不自动重试、升权或冒充业务 FAIL。前期类型检查、构建与 194/194 自动化通过，包含真实 Windows 命令与受控后代回收、官方 AgentLoop 脚本化集成；此前前置问答等待缺陷已修复，四类后续在线证据见下。协议见 [命令预算与退出核对](docs/design/workflow-command-budget-v1.md)。
- **2026-09-15 原生问答等待误取消已修复、激活并在线复验**：通过官方 `user-questions/request` 生命周期观察原生澄清和插件门禁，以精确 Agent 实例隔离等待；回答、取消、错误和卸载清理等待，回答后恢复完整执行预算。未延长生产超时、自动回答业务问题、放宽权限或修改 UI。先复现旧代码失败，再通过真实官方 AgentLoop／ToolRuntime 接线和全部 206 项回归；类型检查、构建通过。新 Host PID 49572 下，独立原生澄清真实等待 230479ms 后成功收到测试答案并退出，无误取消／自动续接、无正式 run 或工程动作。恢复 turn 等其他边界仍使用分层自动化证据，不能以单个在线样本声称所有分支通过。证据见 `.dsh/activation/workflow-question-wait-fix-20260915/verification.md` 与 `.dsh/activation/workflow-question-wait-activation-20260915/verification.md`。
- **2026-09-15 命令监管四类在线路径已验证**：正常退出样本 revision 49／PASS；超时约 5055ms、精确原生主动取消约 2111ms 完成结算，取得托管范围退出证明。用户授权的实际 Host 中断后，新 Host 将命令与角色保留「未确认停止」，revision 33→35，不自动续跑、不冒充业务 PASS/FAIL；其余 15 条工作流记录内容不变。两条被验收脚本误拦截、未实际中断的独立采样完整留档，不计通过。本组未改运行时构建和配置；前期 206 项全量证据不重复计数，另补 7 项验收脚本保护回归。证据见 [.dsh/activation/workflow-command-online-suite-20260915/verification.md](.dsh/activation/workflow-command-online-suite-20260915/verification.md)。
- **P2-4 人工处置机制已激活并完成独立在线路径**：先拒绝、再批准为 ABANDONED，保持原命令 unknown／exitConfirmed=false 与全部验收记录；第三次受控重启后 revision 43 完整保留，新目标另取新 run 与新门禁、未派发。原有 16 条记录不变；实际操作者仍为 unverified，不是独立用户体验结论。随后修复原生按钮、顶部状态和依据层级，224 项回归及原生渲染回放通过，全部 17 条当前记录不变。
- **尚未完成**：完整 Gate B/C 恢复与故障矩阵、任意非 Host 既有工作区改动的通用基线列账（当前只识别同根 Session 的先前 Host Artifact）、确认前自动只读勘察陌生项目、整轮预算、独立体验验收（含极窄宿主顶部多席位拥挤）、撤销事务的跨进程崩溃恢复、任意多任务 DAG、L2／L3 动作、OS 级读取／网络／进程隔离、选择性复验、通用后台进程存活核对、独立规则管理页／语义检索／全局规则。

当前部署（2026-09-15 本组验收收尾）：官方 3080，PID **20932**、instanceId `f2b3b30c-1106-4d56-b007-2e33e7427416`；默认 Web Profile、全局官方入口，DSH 核心未改。三次受控重启均有精确身份检查与前后备份，旧 owner 仅改名留存。16:35:41 审计的 162 条原生 Session 条目无运行／活动子角色／队列／作业；55 条非驻留历史 diagnostic 继续保留，不当作全库健康证明。最终业务 PASS 与旧 unknown 只读 UI 回归通过。证据见 [.dsh/activation/workflow-manual-recovery-20260915/verification.md](.dsh/activation/workflow-manual-recovery-20260915/verification.md)。

详细协议见 [`docs/design/workflow-control-plane-contract-v1.md`](docs/design/workflow-control-plane-contract-v1.md)。
官方能力核验与路线决定见 [`docs/design/workflow-host-integration-findings.md`](docs/design/workflow-host-integration-findings.md)。
第二切片的存储、恢复和验证边界见 [`docs/design/workflow-journal-v1.md`](docs/design/workflow-journal-v1.md)。

受控文本闭环及真实部署状态见 [`docs/design/workflow-native-text-pilot-v1.md`](docs/design/workflow-native-text-pilot-v1.md)。

受控 L1 工程闭环、角色权限与 Windows 沙箱残余见 [`docs/design/workflow-native-project-pilot-v1.md`](docs/design/workflow-native-project-pilot-v1.md)。

工作区文件检查点、用户门禁撤销和冲突边界见 [`docs/design/workflow-file-rollback-v1.md`](docs/design/workflow-file-rollback-v1.md)。

生产 v1 的支持边界、证据等级、五组硬门槛与分阶段执行顺序见
[`docs/design/workflow-production-readiness-v1.md`](docs/design/workflow-production-readiness-v1.md)。当前准确标签是“受控内部 Alpha”；Gate A 已通过，根响应、子 Agent、冻结命令及人工处置有各自分层与在线证据。人工处置显示修复已完成，下一步补整轮预算和 Gate B/C 其余故障矩阵，不扩张功能范围。

四类原生确认（需求理解、执行授权、规则停用／重叠清理、文件撤销）的统一确认卡信息合同、必填字段与 fail-closed 判定见
[`docs/design/workflow-confirmation-card-v1.md`](docs/design/workflow-confirmation-card-v1.md)。四类卡片现在由
`src/workflow-confirmation-card.ts` 的单一确定性渲染路径生成：首屏只含决策摘要，规则 ID、运行 ID、完整合同与证据留在
工作流记录与审计层；必填项缺失、卡片版本过期或保留项与当前结构化状态不一致时不会打开门禁。

原生界面调整及截图证据见 [`docs/design/workflow-native-ui-v2.md`](docs/design/workflow-native-ui-v2.md)。

## 启动

当前默认 Web Profile 已通过本地链接安装本插件。在 PowerShell 中使用官方启动方式：

```powershell
dsh web --no-open --port 3080
```

`start-lab.ps1` 是“构建插件 → 调用上述官方命令”的便捷入口，默认同样为 3080，不再设置 `DSH_HOME` 或创建另一个 Profile。若该端口已有 DSH，不要重复启动。

## 开发验证

```powershell
Set-Location F:\dsh\workflow-agent-signal-lab
.\scripts\link-dsh-dev.ps1 -DshSourceRoot F:\dsh\deepseek-harness
npm run typecheck
npm run build
npm test
```

链接脚本仅在本工作区创建开发依赖 Junction；若已有不同目标则停止，不替换用户依赖。当前验证版本是全局 DSH `0.1.5-rc.1`，本地兼容源码为 `183f08e9c6`；未声明对其他版本兼容。开发链接建立后应使用上方 `npm run ...` 命令，避免包管理器重新解析依赖并替换 Junction。

日志目录存在未知或遗留 `writer.lock` 时会拒绝接管。不要直接删除锁重试；先按实现记录核实旧 Host 已退出并备份，避免两个进程同时写入。
