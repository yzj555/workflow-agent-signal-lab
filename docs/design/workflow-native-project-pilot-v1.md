# 原生受控工程闭环 v1

状态：工程闭环及用户门禁文件撤销已重载到官方 3080；2026-09-08 实现证据化沉淀与复用 v1、复杂工程任务的两段式授权和可展开完整计划；2026-09-09 又将第一道需求理解门禁精确接入 DSH 原生 composer。2026-09-10 收紧实现／测试角色隔离，并让终态返回可直接使用的沉淀证据 ID；随后补齐决定来源审计、候选文本预检和跨键重叠拦截。2026-09-11 完成候选级修订、确认文本保真、生产 P0 基线和首轮真实 L1 Product Gate；随后补充跨 run 保留文件的来源列账。当前类型检查、构建和 142 项离线回归通过。目标 DSH 版本：`0.1.5-rc.1`（源码 revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`）。本文件描述 `workflow-project-pilot/1` 的实际边界，不把路线设想写成已完成能力。

## 1. 使用方式与入口

用户显式选择 `工作流 Agent · Signal Lab` 预设后，仍只在 DSH 原生输入框交流。插件的「工作流」页签读取独立 Journal，只显示控制层已经保存的合同、阶段、角色、失败返回和验收状态；它没有输入框，也不能批准门禁或直接触发工具。

工程路径从门禁开始。协调 Agent 先合并目标、包含／排除范围、约束、假设、精确写入前缀、工程检查、独立验收检查和可检验标准。任何影响范围、命令或验收的不确定项必须先在原生对话中补问。`workflow_propose` 只保存草案，模型不能自称用户批准。

确认强度按合同结构确定，而不是由模型临场猜测：`localized` 任务使用一次执行授权；`cross-module` 与 `architecture` 任务先通过 DSH 原生问答通道确认需求理解，只放行一个不能写文件、不能运行检查的只读方案 Agent。方案记录完成且 Agent 正常停稳后，Host 必须停在第二道 execution gate，再经同一原生通道确认设计摘要、写入范围、冻结检查和返工边界，之后才可实现。原生确认卡只承载当下决策摘要；「工作流 → 完整计划」保存并展示全部范围、角色、权限、方案、依赖、验收标准和命令，不让大型合同挤进一张卡片。

协调 Agent 本身没有项目文件或 Shell 工具。因此 v1 不能在第一道需求理解门禁之前自行勘察陌生仓库来发现正确路径和命令；这些信息必须由当前对话已有事实或用户确认提供。跨模块／架构合同在第一道门禁后已有受限的只读方案角色，但它不能自行补写尚未确认的目标或授权边界。

## 2. 固定角色与责任隔离

| 角色 | 原生工具 | 责任 | 明确禁止 |
| --- | --- | --- | --- |
| 协调 Agent | 仅 `workflow_*` 控制工具 | 澄清、编制合同、发起原生门禁、按依赖推进、汇合与交付 | 读写源码、Shell、替角色报告、伪造门禁回答 |
| 方案／架构 Agent | `read`、`glob`、`grep` | 在跨模块或架构变更中分析影响、接口、执行方案和回滚路径 | 写文件、Shell、验收、批准 |
| 实现 Agent | `read`、`write`、`edit`、`glob`、`grep` | 在确认的写入前缀内实现，并报告 Host 实际观察到的文件 | Shell、运行工程检查或验收、自评通过、范围外写入、升权、委派 |
| 工程测试 Agent | `read`、`glob`、`grep`、合同冻结的 `pwsh` | 源码可见地重跑全部 `ENG-*` 检查 | 直接改写文件、替换命令、自报没有执行证据的结果 |
| 代码审查 Agent | `read`、`glob`、`grep` | 独立审查当前文件版本，区分阻塞项和建议项 | 写文件、Shell、自行修复后再审自己 |
| 独立验收 Agent | 仅合同冻结的 `pwsh` 加工作流报告工具 | 按 `AC-*` 逐项引用 `ACC-*` 黑盒证据 | 源码读取／检索、实现者对话、改写文件、自行豁免 |

每个角色使用独立 continuable Session。模型请求只暴露该角色的工具 schema；最终执行守卫仍会按当前任务包、工作区、路径和冻结命令再拒绝一次。工具隐藏是模型视图，不单独作为安全边界。

## 3. 实际推进图

```text
原生输入与补问
      │
      ├─ localized ── 执行授权 ───────────────────────────┐
      │                                                   │
      └─ cross-module / architecture                      │
             │                                            │
             ▼                                            │
       需求理解门禁（只放行只读规划）                       │
             │                                            │
             ▼                                            │
       方案／架构 Agent（read / glob / grep）               │
             │                                            │
             ▼                                            │
       执行授权门禁（此处硬停，等待原生回答） ────────────────┤
                                                          ▼
                                                       实现 Agent
                                                          │
                                          ┌───────────────┴───────────────┐
                                          ▼                               ▼
                                     工程测试 Agent                 代码审查 Agent
                                          └───────────────┬───────────────┘
                                                          ▼
                                              模型侧源码隔离的黑盒验收
                                                          │
                                              ┌───────────┴───────────┐
                                              ▼                       ▼
                                            PASS                  真实失败证据
                                              │                       │
                                              ▼                       ▼
                                             交付       同范围返回实现（最多一次）
                                              │                       │
                                              ▼                       └─完整重跑下游波次
                              沉淀：无候选结束／有候选一次原生裁决
```

同一波次的工程测试和代码审查并行；其他依赖保持串行。控制层先把整个波次的任务与角色分配原子写入 Journal，再逐个接入原生 Agent。任何接入失败都会形成失败记录，不把未启动伪装成正在执行。

execution gate 绑定当前需求、验收、设计和任务范围。批准后，Host 只允许给同一任务补充或移除运行时 Artifact 引用，以便下游验证及一次同范围返工；角色、依赖、可写前缀、允许／禁止动作或风险级别发生任何变化都会被事件层拒绝。需求、验收或设计版本变化会使授权失效。

## 4. L1 文件与命令边界

- 工作区根从根 Session 的真实 `cwd` 固定到合同中；写入范围必须是一个或多个工作区相对前缀，不能是整个根目录，也不能包含 `.git`、`.dsh` 或 `node_modules`。
- 实现 Agent 的 `write`／`edit` 参数会在执行前再次检查，工作区外路径、未确认前缀、升权字段和额外参数均被拒绝。
- Shell 不是自由命令行，实现 Agent 完全不获得 Shell。独立工程测试与验收角色只接受各自合同中逐字冻结的前台构建、静态检查或测试命令；命令、工作目录和超时都必须匹配。命令组合、绝对／父级路径、安装、发布、显式联网、后台运行和进程控制被拒绝。这两个角色没有直接文件改写工具，但获准的构建／测试脚本仍可能在工作区生成输出。
- 原生 DSH `sandboxPolicy`、受约束文件系统后端和 PowerShell 后端缺失时，工程角色拒绝派发。父会话若是 `danger-full-access`，角色仍会收窄到 `workspace-write` 或 `read-only`；已有更窄策略不会被放宽。

Host 现在会在实现 Agent 第一次改写某文件前保存二进制内容检查点，并在每次工具体结束后 CAS 记录当前摘要。用户要求停止仍只收回执行权、不改文件；只有用户明确要求撤销、运行已经结束并在原生撤销预览中再次确认后，`workflow_rollback` 才恢复已有文件或删除本轮新增文件。摘要冲突整体拒绝，更早检查点必须后进先出逐次确认。它不补偿冻结脚本造成的网络、进程、缓存、数据库或其他外部副作用。完整边界见 [工作区文件撤销 v1](workflow-file-rollback-v1.md)。

## 5. 证据与防伪造规则

- `write`／`edit` 在正式 `tools/execute` 缝中先留底、后观察；即使工具返回失败，只要文件实际变化也会被记录。实现 Agent 报告的文件集合必须与 Host 观察集合完全一致；遗漏、多报或范围外路径都会拒绝报告。
- 当前文件由 Host 重新读取并计算 SHA-256，作为下游测试、审查和验收共同绑定的版本化 Artifact。文件被外部改变后，后续检查不会继续沿用旧摘要。
- 新 run 若与同一根 Session、同一工作区内较早 run 的 Host Artifact 摘要仍逐字节一致，控制层将其单列为 `retainedPriorRunArtifacts`，包含来源 run、来源 outcome 与 `current-file-matches-prior-run-artifact` 证明类型。它不会并入本轮 `deliverables`；摘要不再匹配时不列入，也不把字节相同解释为可证明的物理作者身份。工程测试和代码审查可见这份来源提示，黑盒验收只得到本轮／保留文件数量拆分而不获得源码路径。
- `pwsh` 成功结果由 Host 记录命令 ID、执行角色、退出码、超时／中止／沙箱拒绝状态和有限输出摘要。角色报告的 PASS/FAIL 必须与该 Agent 自己的当前执行证据一致。
- 代码审查的 `PASS` 不能同时包含 blocking finding；`FAIL` 必须有 blocking finding。
- 验收必须逐条覆盖合同中的全部硬性标准，并且只能引用当前验收 Agent 亲自运行的冻结 `ACC-*` 证据。全部任务正常结束、硬性标准全通过且文件摘要仍匹配时，控制层才能保存 `outcome=PASS`。
- 终态 `workflow_advance` 直接返回 `learningSources`；后续 `workflow_status.learning.sources` 返回同一组来源。协调者只能逐字引用其中的 `evidenceId`，不能猜测 run、gate 或 check ID 来伪造沉淀来源。

原生问题回答会在 Journal 中形成 `actor.kind=user`，其含义是“决定经过用户权限门禁”，不是可验证的物理操作者身份。目标 DSH 版本的官方回答结构只有问题 ID 与选择值，不提供“用户亲手点击／经授权代理提交”的来源字段；因此当前实现不能也不会声称没有代理操作。模型对话中的口头同意仍不能生成这个 actor。

## 6. “源码隔离”的准确含义

独立验收是**模型侧源码隔离**：它的模型工具列表没有 `read`、`glob`、`grep`，任务包不含源码正文、实现者对话、自评或代码审查内部对话。它仍能运行用户确认的黑盒命令，并可能在命令输出中看到项目生成的路径或堆栈。

DSH 官方 Windows ACL 沙箱文档明确说明，其约束对象是文件写入；读取、网络和进程可见性不被隔离。因此本版不能声称 OS 级源码保密、网络隔离或进程隔离。工作流会拒绝 Agent 发起显式联网、后台或进程控制命令，但无法证明一个获准的项目脚本不会在内部间接联网、启动子进程或产生其他非文件副作用。Signal Gate 必须把这项残余风险展示给用户，只应冻结已知、本地、可重复的检查。

## 7. 失败返回

只有工程测试、代码审查或独立验收已经提交可复核失败证据，且同波次所有 Agent 都正常结算后，`workflow_return` 才能返回实现。返回记录固定包含来源阶段、目标实现阶段、责任任务、原因和 `attempt=1`，并复用原实现 Agent 的 Session。

当前实现采用保守的完整下游复验：返工实现完成后，重新运行工程测试与代码审查，再运行独立验收。它还没有按变更影响自动选择部分检查。第二次失败、范围扩大、风险升级或缺少真实失败证据时必须停下等待用户决定。

## 8. 尚未完成

- 第一道需求理解门禁之前，由独立只读角色自动勘察陌生项目；
- 撤销事务在进程被强制终止时的意图恢复，以及外部副作用补偿；
- 任意多节点 DAG、动态角色和 L2／L3 高风险动作；
- OS 级读取、网络和进程隔离；
- 基于变更影响的选择性复验；
- 后台 Agent 进程存活与 Journal 运行记录的实时核对；
- 首轮真实模型 Product Gate 已跑完，但仍缺从全新干净 Git 基线到完整交付的单 run 正常通过样本；现有行为 PASS 继承过 CANCELLED run 的部分文件，不能提前视为 Gate A 通过。

## 9. 相关实现

- `src/workflow-project-contract.ts`：工程提案、固定角色 DAG、检查语法与报告合同。
- `src/host/workflow-capabilities.ts`：角色工具矩阵、路径／命令守卫。
- `src/host/workflow-controller.ts`：波次派发、Host 证据、文件摘要、验收与一次返回。
- `src/host/workflow-artifacts.ts`：二进制文件检查点、安全恢复与 Journal 提交失败补偿。
- `src/host/workflow-control.ts`：官方 continuable Agent 接入、沙箱收窄、模型工具视图与生命周期。
- `src/workflow-learning.ts`：沉淀输入、作用域、确定性检索、冲突关闭与版本规则；完整边界见 [沉淀复用 v1](workflow-learning-v1.md)。
- `src/workflow-view.ts`、`src/workflow-run-projection.ts`：不含源码正文的完整计划只读协议与 Host 投影。
- `src/client/workflow-display.ts`、`src/client/workflow-stage-display.ts`、`src/client/workflow-surface.ts`：分层门禁、完整计划、角色、并行波次、阶段省略和返工来源投影。
- `src/workflow-ui-contract.ts`、`src/client/requirements-gate-contract.ts`、`src/client/requirements-gate-composer.ts`：第一道门禁的唯一标签、精确选择规则、原生回执和 composer 界面；第二道 execution gate 不被该选择器接管。

## 10. 官方 3080 重载与页面验证（2026-09-07）

重载前确认 3080 只有 PID 3264，完整命令为全局官方 Node 入口的 `dsh web --no-open --port 3080`，Journal owner 与 PID 一致；74 个原生会话全部 `running=false`，当前 stderr 为空。只停止该实例，确认端口释放后，将旧 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-3264-20260907-182442-project-pilot`，未删除数据库、会话或产物。

首次重载的 Host、只读 RPC 和在线预设列表正常，但真实浏览器检查发现共享快照模块把 Host 专用 `node:path` 间接打入客户端，页面明确报告插件导入失败。该轮没有模型调用、批准或业务写入，不能记作通过。随后将平台无关的 profile／快照 schema 与 Host 合同识别投影拆开，并新增“构建后的浏览器 bundle 不含 Node 内置模块”回归；类型检查、构建和 108 项测试全部通过。

修复后只停止临时 PID 44760，并将其匹配的 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-44760-20260907-183537-client-fix`。当时的修复实例 PID **31560** 沿用相同官方入口、工作区、默认 Web Profile 和 3080；instanceId 为 `0f19794b-a34c-4675-bccf-893b0ec8de3f`，loopback 监听、owner 和命令行互相匹配，HTTP 200，stderr 为 0。

真实页面只读回归结果：插件样式只加载一次，没有插件失败提示或页面异常；原生「对话／轨迹／工作流」页签正常，工作流页没有输入框，原生输入框保持一个；既有文本 PASS 样本仍为 revision 42，两个角色均为「已完成」，七阶段标识与结束提示一致。探针阻止提交、创建、切换预设等写请求，实际命中为 0。前后 Journal 仍为 1 行，逻辑 SHA-256 均为 `e251e8a1dfc6533db8721a7a8dd9833946969b4291d0fbff062ebe36be8e6b4a`；74 个会话仍全部未运行。

文件撤销版本完成后，再次以相同的官方命令重载。当次 PID **41860**、writer owner PID 和 3080 监听一致，instanceId 为 `36908555-cd01-4aa2-83ea-b021e048446e`，HTTP 200，stderr 为 0；前一实例的 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-6208-20260907-rollback-ui-terminal`。真实页面再次只读核对了 revision 42 的 PASS 样本，同时对 10 组窗口、主题和状态快照执行布局回归；“已撤销”在顶部终态、交付阶段和结束提示中一致出现。页面错误、禁止写请求、插件输入框和水平溢出均为 0；Journal 仍为 1 行、revision 42，逻辑 SHA-256 仍为 `e251e8a1dfc6533db8721a7a8dd9833946969b4291d0fbff062ebe36be8e6b4a`。

工程闭环首次证据位于 `.dsh/evidence/workflow-project-pilot-activation-20260907/fixed`，撤销版部署、最终只读探针和布局矩阵位于 `.dsh/evidence/workflow-file-rollback-activation-20260907`。较早的失败探针保留为诊断过程，不是通过证据。这些只证明新 bundle、预设、旧记录和演示状态在真实页面正确加载；没有启动真实模型工程任务或对业务文件执行撤销，因此仍不证明真实模型的需求理解、工程质量或撤销时的人类体验。

## 11. 分层确认与完整计划重载（2026-09-08）

本次先将 `cross-module` 与 `architecture` 合同统一接入两段式授权：第一道 Signal Gate 只把只读方案任务列入 scope；方案记录形成并且该 Agent 正常结算后，`workflow_advance` 必须返回 `needsUser=true`，第二道 execution gate 才绑定当前需求、验收、设计和全部可执行任务。局部变更仍使用一次 execution gate。事件层还限制批准后的任务改版只能改变运行时 inputs，禁止借版本更新改变角色、依赖、写入范围、动作、风险或输出合同。

首次重载前，3080 的唯一监听、完整官方命令和 writer owner 均指向 PID **11972**。91 个原生会话中只有 `workflow-l1-port-pilot-20260908` 正在等待旧原生确认，没有后台子 Agent；先通过官方 `session.cancel` 关闭该问题，确认 91 个会话全部空闲后才停止精确 PID。遗留 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-11972-20260908-185403-layered-plan`，没有删除 Journal、会话、产物或项目文件。

第一次新进程 PID 4560 没有通过就绪检查：新执行门禁规则在冷重放时拒绝了历史上由旧版、明确覆盖全部工程任务的 Signal Gate，Host 未监听 3080 且没有取得 writer owner。错误日志保留在 `.dsh/activation/workflow-layered-plan-20260908/dsh.stderr.log`；该失败不能记为部署通过。修正采用窄兼容条件：只有旧 Signal Gate 本身明确把目标可执行任务列入 `scopeTaskIds` 时，才可重放其历史执行；新版复杂任务的第一道门禁只 scope `architecture`，因此不能借兼容路径启动实现。新增回归同时证明这两个方向。

修正后以完全相同的官方命令启动 PID **13336**，instanceId 为 `84de4aef-6c96-4318-90b4-443b3ca3d4ed`；唯一 loopback 监听、writer owner、进程命令和 HTTP 200 一致，启动 stderr 为 0，91 个会话均为空闲。随后又收紧方案门禁的 task scope，并把完整计划中的内部角色／冻结检查编码改成用户可读文案；在再次确认 91 个会话全部空闲后只停止 PID 13336，owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-13336-20260908-191020-layered-plan-final`。最终实例 PID **23184**、instanceId `20f555f6-b531-4b44-a07b-8926fa0e78c4`，仍使用同一官方命令、工作区、默认 Profile 和 3080；监听、owner、HTTP 200 一致，stderr 为 0。当前实验运行可无损读取为 revision 344，完整计划含 4 个角色任务、3 项硬标准和 4 条冻结检查。

最终实例上的真实 DSH 页面只读检查覆盖当前局部任务的默认折叠与完整展开两种状态：插件样式 1 份、插件输入框 0、原生输入框 1、页面异常 0、受阻写请求 0、工作流及计划区域横向溢出均为 0。另在同一真实 DSH 页面壳中仅重写浏览器收到的快照，回放复杂任务的视觉状态，确认三段标识为“需求理解／已确认、只读方案／已形成、执行授权／等待你确认”；该回放没有写入 Journal，也不代表真实模型运行。最终证据与截图分别位于 `.dsh/activation/workflow-layered-plan-20260908/ui-final` 和 `.dsh/activation/workflow-layered-plan-20260908/ui-layered-final`。

## 12. 需求理解 composer 与真实第一道门禁（2026-09-09）

第一道门禁不再借用“计划待审／确认执行”文案。插件以优先级 `-10` 注册 `conversation.composer` chain 候选，仅当官方 pending question 的 `intent.kind=plan-review`、批准标签、唯一选项和共享合同常量全部精确匹配“确认需求理解并允许只读规划”时才接管。它向用户展示“需求理解／只读规划”、确认后的能力边界和“返回对话修改”；不创建输入框，回执仍发给官方 question responder。执行授权、普通问题、多选问题均退回 DSH 官方 composer。

重载前核对唯一 3080 监听、writer owner、进程命令和 91 个会话均无活动执行；只停止精确 PID **23184**，并将旧 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-23184-20260909-requirements-gate`。新实例 PID **33528**、writer owner PID 和 3080 监听一致，instanceId 为 `e59d074b-15ac-4650-821a-f50c578d7598`，官方命令仍为 `dsh web --no-open --port 3080`，HTTP 200，stderr 为 0。

随后使用真实模型创建一条 `cross-module` 任务，合同修订为 revision 10，并由控制层真实发起第一道门禁。会话当前仍是 `running=true`，原因是等待 DSH 原生问答通道返回；只读方案 Agent、实现、检查和第二道门禁都尚未发生。只读浏览器探针阻止所有 respond／prompt／cancel 等写路由，实际命中 0 次；它确认插件样式 1 份、官方 PlanReview 0 份、额外输入 0、水平溢出 0、页面异常 0，并准确显示“返回对话修改／确认理解并开始只读规划”。证据与截图位于 `.dsh/activation/workflow-requirements-gate-20260909/ui-first-gate`。

## 13. 角色隔离、终态沉淀出口与审计语义修正（2026-09-10）

真实工程试用暴露了三个闭环缺口：终态 `workflow_advance` 未返回证据 ID，协调者只能猜测而被 `workflow_learn` 正确拒绝；实现 Agent 同时持有 `pwsh` 与 `ENG-*` 清单，会形成“实现者自测”的责任混叠；原生问答事件被表述为可证明用户亲手点击，而官方回答载荷没有该来源字段。

修正后，文本与工程终态都返回 `learningSources`，并与随后 `workflow_status.learning.sources` 的 `evidenceId` 一致；沉淀回归只使用该返回值，不再直接窥读 Journal。实现 Agent 同时从角色工具矩阵、任务 `allowedActions`、运行时任务包和最终守卫移除 Shell／检查能力，工程检查只归 `test_engineer`。Journal 继续保留 `actor.kind=user` 以表示用户权限域，但文档和提示词明确不把它解释成物理操作者认证。

类型检查、构建和全部 126 项离线回归通过。重载前确认 3080 仅由 PID **33528** 监听、writer owner 一致，99 个原生会话全部 `running=false`；只停止该 PID，旧 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-33528-20260910-closure-fix`。新实例 PID **38892**、instanceId `613a71cb-df1f-4c1a-9bc6-8a866dd80dc5`，继续使用官方 `dsh web --no-open --port 3080`；监听、writer owner、HTTP 200 与命令行一致，stderr 为 0，在线预设存在且 `broken` 为空，99 个会话仍全部空闲。只读真实页面 smoke 显示插件样式 1 份、原生输入框 1 个、旧独立界面 0、页面错误 0、禁止写请求 0。部署与页面证据位于 `.dsh/activation/workflow-closure-fix-20260910`；本次未创建任务、回答门禁、调用模型或改写业务产物。

## 14. 决定来源与沉淀准入治理（2026-09-10）

新产生的需求／执行确认、沉淀、规则停用及文件撤销决定携带同一结构的 `decisionAudit`。该记录只证明 Host 从 DSH 原生问答通道取得了用户权限域内的回答，并用关联 ID 绑定对应 actor；`operator=unverified` 明示官方协议不能证明实际是谁操作。旧 Journal 事件保持兼容，投影显示为旧版来源信息缺失，不反向补造身份。

沉淀候选新增两层准入：先拒绝可机械证明的文本缺陷和无法支持的操作者身份断言，再对本批及作用域相交的活动规则进行确定性高置信重叠检查。同键、同文和明显语义重叠在打开原生卡片前即关闭，改换 key 不能绕过。2026-09-11 起，用户选择“内容有误，退回修改”时，其他候选的采纳／不采纳结果立即独立保存；仅该候选进入 `revision-required`，由原生输入框给出改法后记录前文、后文、原因和次数，并只重开该条。运行时规则复用仍保持精确触发，不把该准入信号扩张成模糊语义检索。

## 15. 首轮真实 L1 Product Gate 与跨 run 来源修正（2026-09-11）

真实会话 `workflow-production-l1-pass-20260911-1700` 在独立 Git fixture 上先后形成一个 `CANCELLED` run 和一个 `PASS` run。第一 run 的错误测试期望造成两次真实工程检查失败；控制层完成一次同 ID 返工、完整下游失效与复验，并在预算用尽后停住。第二 run 重新合并需求、重新通过两道门禁，随后工程测试、代码审查和模型侧源码隔离验收形成 `6 PASS / 0 FAIL / 0 WAIVED`。三条经验逐项裁决，其中一条经原生输入修订后只重开该条；Journal 最终 revision 192。

该次试验同时暴露来源缺口：第二 run 的行为 PASS 继承第一 run 留在工作区的源码，但 Host 终态只列出第二 run 再次触及的两个文件。交付 Agent 虽主动披露，控制器本身此前没有结构化列账。修正后，当前 run 的 `deliverables` 保持原义；仍与较早 run Artifact 摘要匹配、且不被本轮同路径 Artifact 覆盖的文件单列为 `retainedPriorRunArtifacts`。该列表不依赖 Git，不把先前 `CANCELLED`／`FAIL` 文件洗成本轮交付；外部改写导致摘要不一致时立即消失。新增回归覆盖保留命中、来源 outcome、QA 数量隔离和外部改写不误报。

这项修正提升交付诚实度，但不改变 Product Gate 判定。独立干净 fixture 的单 run 正常通过样本完成前，Gate A 仍为 `revise`，产品仍是受控内部 Alpha。完整记录见 `.dsh/activation/workflow-production-l1-gate-20260911/verification.md`。

类型检查、构建和全部 130 项离线回归通过。重载前再次确认 PID **38892** 是 3080 的唯一官方 DSH 监听，writer owner 一致，99 个原生会话全部空闲；只停止该 PID，旧 owner 保留为 `.dsh/workflow-runtime/writer.lock.retired-38892-20260910-decision-learning-governance`。新实例 PID **26236**、instanceId `c06be4a6-3471-4666-ab61-2489db38aee9`，监听、writer owner、官方命令与 HTTP 200 一致，stderr 为 0，99 个会话仍全部空闲。在线预设正常列出；只读真实页面 smoke 显示插件样式 1 份、原生输入框 1 个、旧独立界面 0、页面错误 0、禁止写请求 0。部署证据位于 `.dsh/activation/workflow-decision-learning-governance-20260910`；本次没有创建真实任务、回答新门禁或调用模型。
