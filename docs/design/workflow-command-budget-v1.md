# 冻结命令独立预算与退出核对 v1

状态：P2-3 已实现、完成分层自动化，并于 2026-09-15 在官方 3080 完成正常退出、超时、主动取消、实际 Host 中断后保留 unknown 四类在线验收。前置原生澄清等待误取消已通过 206/206 和默认预算在线复验。当前为受控内部 Alpha，不等于完整 Gate B/C；适用于 Windows L1 的工程测试与独立验收，不扩大角色工具权限。

## 行为与默认预算

每条已确认的前台检查命令有独立执行预算 120 秒，超时后的退出核对宽限为 15 秒。Host 的 `commandTimeoutMs` 和 `commandExitGraceMs` 可分别设置为 1000～120000ms 的安全整数；模型只能提出更短的命令时间，不能突破 Host 上限、续租或转成后台执行。实际采用 `min(请求时间, Host 上限)`，写入本次命令记录。

预算覆盖官方工具派发及其托管进程范围退出等待，不因 Agent 的日志／输出而重置。它与根 turn 无进展预算、角色 lease 接受／无进展／总时长预算并行生效，先发生的中止保留为原因。Journal 自身的故障恢复仍属 Gate B/C，不能把本命令计时器说成所有持久化故障已有界处理。

| 观察事实 | 处理 |
| --- | --- |
| 规范化前台命令返回、托管范围退出已确认 | 保存命令退出凭据，才可按退出码登记检查结果 |
| 退出码非零，但命令与托管范围正常结算 | 真实检查失败，可由既有业务返工流程处理 |
| 命令超时／取消／执行链路错误 | 撤销当前角色权限，终止该次托管范围；不伪装成业务 FAIL |
| 主命令返回 0，但托管范围仍存在 | 继续等待，不登记 PASS；预算到期则终止并核对退出 |
| 宽限期内仍不响应、观察失败或绕过托管接口 | unknown，不能称已停止、不能自动续跑 |

未知状态不会靠晚到的文本、原生 end、空子 Agent 列表或一次 no-op drain 清除。当前版本保守保留 unknown；后续 P2-4 的受审计人工处置只结束旧 run，不清除未知证据，也不会自动重跑命令、升级沙箱、进入返工或撤销文件。

## 官方接入方式

固定依据：DSH `0.1.5-rc.1`，commit `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。

- `packages/core/tools/src/index.ts` 的 `ToolDispatchExecution` 与 `tools/execute`：允许在委托期间替换 signal，原生调用者 signal 仍由 registry 合并，finally 还原。
- `packages/shell/tool-pwsh/src/index.ts`：原生工具、展示、规范化结果与 sandbox policy 解析保持不变。
- `packages/shell/pwsh-local/src/index.ts`：`runArgv` 等待 `SubprocessHandle.done`，这个主命令／stdio 结果本身不是范围退出证据。
- `packages/subprocess/subprocess/src/types.ts`、`index.ts`：`terminate()` 请求终止当前 handle 的托管范围；`waitForExit(signal)` 的 true 才是同范围退出确认，false／reject 不构成证明。
- `vendor/cordis/src/context.ts`、`utils.ts`：公开 `ctx.extend()` 和服务调用上下文追踪。预设的 `workflow-pwsh` 在扩展上下文上加载原封不动的官方工具，只提供当前调用的 subprocess 委托；不修改全局服务／原型，不新建 shell executor，不重写 argv、cwd、env 或沙箱策略。

运行归属由 Controller 持有的 AsyncLocalStorage 实例关联到精确命令调用；不同打包入口通过同一 Controller 服务取得该实例。后台／终端接口关闭。命令作用域在取消或结算时同步封闭，即使执行器迟到，也不能再次调用真实 spawn。

默认命令类型仍只接受已冻结的构建、静态检查和测试命令。Shell、文件与沙箱供应方继续由现有 Host 配置提供。本插件没有新增网络／任意命令／全局进程操作权限。

## 记录与防伪

`command/started` 是持久化的执行意图，发生于原生派发之前，**不单独证明 OS 进程已经创建**。保存 commandId、assignmentId、任务版本、checkId 与实际预算。`command/finished` 保存 elapsedMs、processCount、toolSettled、exitConfirmed、exitCode 和可用的错误摘要。

运行命令只有一次结算：completed、interrupted 或 unknown。只有 Host 能写入；旧版本、重复身份、状态与退出事实矛盾的记录被拒绝。检查证据还必须具备同一次原生规范化结果的进程内凭据，模型不能通过拼出相同 JSON 或旧成功报告伪造。新检查开始时失效该项旧凭据；命令尚未结算时不能提交角色报告。

角色回收同时等待原生 drain、已进入的文件写入／补偿及命令结算。任何命令范围 unknown，都不能标记该角色 stopped 或整轮 CANCELLED。冷启动把没有当前 lease 的开放命令记为 unknown；elapsedMs=0、processCount=0 表示新 Host 没有观察数据，不表示旧进程没有执行。重复扫描不增添记录。

现有视图沿用「正在停止／已停止·需要处理／未确认停止」与具体检查编号，不增加聊天框。详细命令身份与预算保存在记录、验证证据和 `workflow_status.commandExecutions`，不把长 UUID 塞入顶部提示。

## 能力边界

`waitForExit(true)` 只证明官方 provider 可管理、可观察的范围为空，不是任意 OS 进程树的绝对保证。Windows Job 的正常继承、弱退化范围、观察通道丢失、逃逸及宿主崩溃边界以该固定 provider 的官方说明为准；不能由此宣称新增了 OS 级读取／网络／进程隔离。

已验证真实 Windows 挂起命令和受控后代的超时／主动取消回收，并以实际 Host 中断验证失去旧执行观察后的 unknown 与禁止续跑。该样本只覆盖一个冷恢复切点，没有验证跨进程任意崩溃、整轮预算、所有阶段的故障矩阵、任意自定义 provider 或长任务时长标定。模型质量和产品独立可用性仍需另验。

## 测试与部署

前期类型检查、构建与全量 **194/194** 通过；包含真实官方 AgentLoop 的脚本化模型、真实 PowerShell／subprocess 进程样本，以及假时钟／内存与 SQLite Journal 分层验证。这组自动化没有调用外部付费模型。具体命令与结果见 `.dsh/activation/workflow-command-budget-20260914/verification.md` 和 `tests.tap`。

2026-09-15 用户停止旧进程后，完成停机备份，按官方入口启动当时 Host PID 3008、instanceId `2ba7a941-6b20-45d5-a9d7-e0e4d788853d`。131 个既有 Session 和 PASS revision 126 回归正常，原生输入框 1、插件输入框 0、页面错误 0；新测试的 workflow_status 已返回 commandExecutions。独立在线测试调用了当前配置的真实模型，但在原生澄清处被错误取消，未开始工程命令。新增会话后 132 个 Session 均空闲，测试保留 needs-attention；不能把页面回归或新状态字段当作命令监管通过。证据见 `.dsh/activation/workflow-command-activation-20260915/verification.md`。[原生澄清等待缺陷](issues/native-question-wait-20260915.md) 随后通过全量 206/206，并在当时 Host 49572 完成默认预算问答复验：等待 230479ms 未取消，测试答案正常返回，无正式 run 或工程动作，当时 133 个会话均空闲。该问答激活证据见 `.dsh/activation/workflow-question-wait-activation-20260915/verification.md`；后续命令在线验收结果见下一节。

新代码可读取旧 Journal；旧代码不认识新增命令事件。回退时不得让旧插件写入已有新事件的库，必须使用停止后备份的匹配版本。整体标签仍是受控内部 Alpha，Gate B/C 未通过。

### 2026-09-15 在线命令验收完成

真实模型、原生预设／门禁、官方 pwsh 与持久 Journal 取得以下证据：正常工程／黑盒命令分别 608／660ms 退出、exitConfirmed=true，正常 run revision 49／PASS；5000ms 请求预算下 5055ms 超时结算；精确原生子 Agent 中断后 2111ms 取消结算。超时与取消都先观察到 fixture 与受控子 PID 存活，再在 30 秒保险前观察到退出，不把 accepted 或 idle 当作退出凭据。

受控 Host-loss 样本在一致备份后停止 49572、官方重启到 21284，停机约 8 秒。新 Host 仅给该 run 追加 command unknown 与角色 host-restart／unknown，revision 33→35；约 116 秒后重复读取不变，不重派、不产生业务 PASS/FAIL，其他 15 条工作流记录内容摘要不变。原生页面明确显示未确认停止，原业务 PASS revision 126 保留。此前两条由验收脚本误拦截、没有中断的采样不计通过，错误与更正均留档。

完整证据见 `.dsh/activation/workflow-command-online-suite-20260915/verification.md`。该在线验收组未修改运行时构建或 Profile，只新增验收脚本／fixture／文档；206 项全量为此前证据，另有该轮 7 项验收脚本保护回归。

后续 P2-4 已实现 [受审计人工处置入口](workflow-manual-recovery-v1.md)，通过 220/220、类型检查、构建、激活与本组独立在线机制验证。新样本先拒绝保持阻塞，再明确确认 ABANDONED；保留命令 unknown、不生成退出证明、不重放命令，第三次重启后完整记录不变，新目标另行确认。原有在线未知样本未处理，原有 16 条工作流内容摘要不变，最终 Host 20932。随后修复处置按钮／顶部状态／依据层级，224/224 与原生渲染本地回放通过，当前全部 17 条 Journal 摘要不变，Host 未重启；不能代替独立体验验收。之后仍需整轮预算及其余 Gate B/C 矩阵，不能手改 Journal 清除 unknown。
