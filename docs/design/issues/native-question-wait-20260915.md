# 原生澄清等待被根响应监控误取消

状态：已修复并完成默认预算在线复验，本缺陷关闭。类型检查、构建和全量 206/206 通过；2026-09-15 新 Host PID 49572 上，原生澄清等待 230479ms 未被取消，提交测试答案后正常结束。原优先级 P1，首次失败来自 DSH 0.1.5-rc.1 的旧 Host PID 3008；该历史样本保留。P2-3 工程命令验收尚未完成，不因本缺陷关闭而升级整体结论。

## 事实与范围

独立测试 workflow-command-online-normal-20260915 中，模型数秒内已返回并调用 workflow_status，随后执行原生 ask_user_question。用户答案未到达时，180 秒根预算触发取消，原生问题返回 ASK_ABORTED；自动续接再次提问，120 秒后再次误取消，最终 needs-attention。没有创建正式 run、批准门禁、子 Agent 或执行命令。

这不是模型无响应，也不是 P2-3 命令退出核对失败。根监督的等待豁免漏接了原生澄清路径，已登记的插件确认门禁不应一概判为失效。以该缺陷阻止当前验收继续，不通过自动回答或放大时限绕过。

## 因果定位（修复前）

- src/host/workflow-controller.ts 的 isAwaitingUser 仅检查 this.questions.has(agent.id)。
- 此 Map 在插件自己的确认、沉淀和撤销调用前设置。
- 官方 packages/interaction/tool-ask-user/src/index.ts 直接调用 ctx.userQuestions.ask，经过 user-questions/request scoped waterfall；该路径没有进入上述 Map。
- src/host/workflow-root-watchdog.ts 在预算到期时依据 isAwaitingUser 决定豁免；漏识别导致对实际等待答案的 turn 调用 cancel。
- tests/workflow-root-watchdog.test.mjs 的等待豁免样本直接 stub isAwaitingUser=true，仅验证计时分支，没有验证官方问答与 Controller 的接线。

## 修复验收要求

1. 使用当前官方问答生命周期识别精确 live root 的等待，兼容插件自有门禁和直接原生澄清；不同 Agent／实例不能互相豁免。
2. 在真实问题等待期间暂停执行无进展判定；答案返回后重新建立正常预算。取消、错误、dispose 必须清理等待凭据，不能永久关闭监督。
3. 不依赖模型声称“正在等用户”、UI 文本或一个伪造工具名称来免除预算；不放宽执行权限或自动批准。
4. 增加真实官方 tool-ask-user／UserQuestionService 接线测试：跨预算待答不取消、答复后恢复计时、异常清理、多个会话互不影响、插件确认门禁不退化。保留真正停滞的最多一次续接测试。
5. 新版激活后在独立会话观察真实问答跨越预算仍可回答，再续跑冻结命令，取得 command/started、command/finished 和对应退出证明。

完整记录：.dsh/activation/workflow-command-activation-20260915/verification.md。失败样本保留，不追改为通过。

## 本次修复与验证边界

- Host 使用官方 `user-questions/request` scoped waterfall 的 `global + prepend` 监听包装真正的 answerer；既覆盖原生 `ask_user_question`，也覆盖插件确认、沉淀和撤销请求。不改变答案、取消原因、原生 UI 或官方服务。
- 新增 `WorkflowQuestionWaits`，按精确 Agent 对象维护并发请求；不以可复用的 Session ID 共享等待凭据。回答、拒绝、请求 signal 中止、Agent dispose 和插件卸载均释放观察状态；取消不必等迟到的 answerer 返回。
- Controller 在实际 Host 中以该原生观察结果为准，避免已中止的问题被内部门禁 Map 再次豁免。内部 Map 同时改用精确 Agent 对象，仅在没有原生观察器的 Controller 测试／嵌入场景提供回退。
- Watchdog 在问答开始和结算时重置无进展起点；回答后无需等待下一条工具事件即可获得完整执行预算。等待中不会产生误取消或自动续接，真正执行停滞仍有界恢复。生产 180 秒／120 秒预算未修改。
- 新增 12 项测试：6 项真实官方问答／ToolRuntime／AgentLoop 集成、4 项等待生命周期、1 项答复后重新计时、1 项同 ID 新旧 Controller 根实例隔离。原有 194 项一并通过。
- 先用旧代码执行真实原生澄清接线样本，得到等待识别断言失败；修复后同一样本跨越测试预算仍待答，回答后正常退出。该集成使用脚本化模型和测试回答，不调用外部模型，也不等同于 3080 默认 180 秒在线复验。

验收要求 1～4 已有分层自动化证据；要求 5 的激活和默认预算在线问答部分已完成，后续冻结命令属于 P2-3 独立验收，仍待完成。新测试 Session `workflow-command-online-question-wait-20260915` 最终 revision 0、run=null、无恢复／批准／命令事件，133 个会话均空闲；该测试由代理操作，不作为用户无帮助体验证据。既有失败 Session 保留 revision 2、`needs-attention`，没有清除异常或重开门禁。源码证据见 `.dsh/activation/workflow-question-wait-fix-20260915/verification.md`，激活和在线证据见 `.dsh/activation/workflow-question-wait-activation-20260915/verification.md`。
