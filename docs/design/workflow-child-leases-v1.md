# 子 Agent 派发凭据与有界回收 · P2-2

日期：2026-09-14。适配官方 DSH `0.1.5-rc.1`，不新增聊天界面，不改变用户权限门禁。

部署状态：主体与 Host 中断处理提示已在官方 3080 生效。2026-09-15 P2-4 人工处置入口完成 220 项构建基线、激活和本组独立在线机制验证，最终实例 20932；随后三项显示修正与 224 项回归完成，见 [人工处置协议](workflow-manual-recovery-v1.md)。

## 已实现的规则

每次派发对应独立的进程内 lease 对象；同 Session ID 的返工也会使用新对象、新时钟和新的官方 activation `runId`。模型不能修改预算、续租、选择运行身份或恢复旧权限。

| 计时范围 | 默认值 | 截止后处理 |
| --- | --- | --- |
| 原生派发接受 | 30 秒 | 中止本次 admission，回收该角色 |
| 已接受但没有可观察进展 | 180 秒 | 回收该角色，不取消并行兄弟 |
| 本次派发总时长，含接受阶段 | 20 分钟 | 不因持续输出而无限延期 |
| 报告提交后等待原生结束 | 15 秒 | 保留报告历史，但阻止其作为正常交付闭环 |
| 官方取消／回收收敛 | 15 秒 | 未收敛记为 `unknown`，不声称停止 |

这些是当前内部 Alpha 的保守默认值，不是已完成性能标定的 SLA。Host 配置可覆盖公共预算；`childRoleBudgets` 可以分别覆盖 architect、engineer、test_engineer、code_reviewer、acceptance_qa 的无进展与总时长。配置值必须是 1000～2147483647 毫秒的整数，总时长不小于无进展时长。缺失的角色字段继承公共值，不接受未知角色或字段。

进展只来自当前绑定实例的官方 `agent/status`、`session/event`、`agent/assistant-stream`。它表示可观察活动，不保证语义上取得成果，所以还必须有不可续延的总时长。报告之后的输出不重置退出期限。DSH 正常释放实例可能先于 `subagent/end`：释放时立即禁止再次使用该实例，但在短暂宽限内等待匹配结束事件，不直接判错。

## 超时后的事实链

1. 同步失效 lease、取消 admission、停止该对象的计时，后续工具和报告立即失去权限。
2. 在根 Journal 串行队列之外调用官方 `drainContinuableChildren(parent, [childId])`，仅处理精确直属子角色。
3. Journal 保存 `agent/runtime-interrupted`：原因、任务版本、incident ID、触发预算和实际耗时。界面显示「正在停止」。
4. admission 已结束、官方回收完成、本角色已进入的文件写入及必要补偿均已结束，才能写「已停止 · 需要处理」。
5. 回收超时或失败显示「未确认停止」。不循环重试；同一次回收若稍后成功，可以追加更强的停止证据。

派发函数即便不响应 AbortSignal，也不能永久占据协调调用；只读状态与其他已授权角色可以继续收尾。早先返回的空回收不证明后来才完成的 admission 安全，必须等待 admission 结束后再次回收。

同一波角色的 admission 并行发起。超时角色不派发替身、不进入下游验收，也不触发业务返工。正常并行角色仍可提交自己的证据。根协调的自动恢复看到子角色中断时保持需要处理，不绕过子角色故障继续自动推进。

## 持久记录与显示

- 正常运行不追加心跳事件，避免每帧放大 Journal。
- 中断只有一条身份不变的 incident 链：`stopping → stopped`，或 `stopping → unknown → stopped`；冷启动可直接为 `unknown`。不允许回退、换身份或重复结算。
- 只有 Host 的 system actor 可以记录此事件；任务版本必须匹配。原生迟到结束事件必须匹配本次 activation `runId`，旧轮次不能结算新 lease。
- 正在执行的任务转为 `blocked`；报告已提交但未正常结束的完成任务转为 `invalidated`。不伪造验收 FAIL，不删除历史证据，不消耗返工次数，不增加批准。
- Agent 行、顶部状态与当前事项均显示「正在停止／已停止·需要处理／未确认停止」，异常记录不再计入正常运行数量。已有通过记录不因新增显示字段被迁移或倒签。

明确停止请求也有收敛期限；权限先撤销，但回收未确认时不写 `CANCELLED`。本 Host 的停止已获证明后，可停止本轮并重新确认需求开启新运行。卸载时先撤权、清计时器，再有界等待回收、写入补偿与 Journal 队列；失败会抛错，不从控制器宣称已安全释放 writer。

## 冷启动的边界

启动时扫描 Journal 中没有本 Host lease 的历史运行态角色，只追加「未确认停止」记录，不启动旧 Agent，不补造批准，不把旧报告记成完成。重复扫描不增加 revision。

新 Host 的空 activation 列表或 no-op drain 不能证明旧 epoch 及其外部副作用已经停止，所以 `workflow_stop` 不会靠空回收把这种状态改成成功。本切片完成识别、展示和安全阻断；后续 P2-4 已实现 [受审计人工处置入口](workflow-manual-recovery-v1.md)，并完成本组独立在线机制验证。该入口只允许原生确认后记录 ABANDONED，不补造 Host 退出证明、不恢复旧执行。不允许用删除事件、手改 outcome 或释放未知 writer 锁绕过。

## 兼容性与证据

官方依据为本地对应版本源码：

- `packages/subagent/subagent/src/index.ts`：selected-child drain 与 scoped 生命周期；
- `packages/subagent/subagent/src/types.ts`：activation runId、接受／完成／释放语义；
- `packages/subagent/subagent/src/continuation-activation.ts`：先释放 handle 再发布 end，及精确子集回收；
- `docs/subsystems/subagent.zh.md`：continuable lifecycle，不把父 turn 取消当作子 Agent 已取消。

新增字段对旧快照是可选的，当前版本可以读旧 Journal。但旧插件不认识新增事件；回退插件必须同时使用停止服务后备份的匹配 Journal，不能让旧代码直接写新事件库。

自动化覆盖独立时钟、角色覆盖、迟到报告、admission 不响应中止、回收超时／迟到成功、同 ID 旧结束事件、冷启动幂等、事件伪造／倒退、停止不收敛、并行接受和迟到文件写入补偿。另用真实官方 AgentLoop、Spawn、ToolRuntime 和 SQLite、脚本化模型完成一侧超时另一侧正常收尾；这不是付费真实模型的长任务验证，也不是完整 Gate B/C。

P2-3 已补齐命令级预算与官方托管范围退出核对的源码、分层自动化和四类在线路径：正常退出、超时、精确主动取消、实际 Host 中断后的 unknown 与不续跑。原生澄清等待缺陷已通过 206/206 和默认预算在线复验，见 [workflow-command-budget-v1.md](workflow-command-budget-v1.md)。P2-4 随后用独立样本完成原生拒绝／人工结束／重启留档／新目标重新确认，当前 Host 为 20932；原有 16 条工作流内容不变，原真实中断样本仍 revision 35／unknown。人工处置显示修正现已通过 224 项回归和真实 DSH 渲染器／官方 PendingQuestion 的本地回放，全部 17 条当前 Journal 摘要不变，不产生新的 Host 审批。下一步补整轮资源预算、各阶段跨进程崩溃矩阵和长任务预算标定。整体继续标为「受控内部 Alpha」。
