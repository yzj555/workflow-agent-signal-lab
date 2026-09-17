# 跨进程验证发现的未闭环边界

## 后续处置 · 2026-09-17

以下原始发现和失败证据保留，不倒签。两项已在 `workflow-basic-production-20260917` 批次实现修复并空闲激活至 3080，详见 [新交付记录](../../../.dsh/activation/workflow-basic-production-20260917/verification.md)。

- **R1**：正式 `workflow_propose` 创建 Run 前等待 DSH 公共 `sessionPersistence.flush()`；仅复用同一有效根实例的成功屏障，不跨新根共享；失败、15 秒超时、取消或根失效均不创建 Run。四项真实子进程强停测试已移除夹具提前 flush，全部通过；另加 7 项专项。该公共屏障会冲刷其他已打开的写句柄，并非私有的单 Session API。没有承诺 Journal 与所有原生事件尾部原子提交，也没有补造或自动修复历史孤儿 Session。
- **R2**：候选重复 B 再次失败，保留了逐阶段证据：5000ms 额度没有及时封闭，直到测试清理时新的生命周期事件才记账，超出 5704ms；不是单纯 ToolRuntime 结算慢。定位到浮点单调时钟与整毫秒定时器之间的提前唤醒分支：尚未到限时 `check` 返回，但不再设置观察。两项确定性回归在旧构建上 0/2；修复为向上取整延迟且未到限重新观察后 2/2。没有延长原测试窗口、预算或命令宽限；三类真实 PowerShell 预算检查连续 6 轮通过，最终两轮全量 342/342（第二轮为空输出目录重建）。
- **边界**：20 条线上记录无迁移、无改写，整轮预算仍默认关闭。新代码加载和只读 UI 已验证；未执行新的真实 Web 活动中强停，不宣称完整崩溃矩阵或 Production v1 通过。

## 原始发现（修复前）

日期：2026-09-17。来源：[隔离跨进程矩阵](../workflow-crash-recovery-matrix-v1.md)。本次只验证，不修改生产运行时、DSH 核心或线上配置。

## R1：工作流记录已落盘，原生新会话尚未首次落盘

状态：**隔离夹具已复现；真实 3080 原生入口的可达性及产品处置方式待确认。** 不直接定性为线上数据丢失，也不当作已修复。

- `second/tests.log` 的 child-model、root-time-cap、pending-gate 三例：强停测试 Host 后，SQLite 中有完整 Run、已用额度和预留；新的官方 AgentLoop `resume` 返回 `SessionPersistenceNotFoundError`。
- 官方 `session-persistence-jsonl/src/storage.ts` 的 `LIVE_WRITE_BATCH_MAX_DELAY_MS=200`，存活事件采用写后缓冲；`index.ts` 明确说明新 Session 在首次 append／flush 前可能只在进程内可见。`Agent.whenIdle()` 不构成落盘屏障。
- 本夹具为脚本化模型、自动回答和直接 ToolRuntime 调用，能在非常短的时间内建立并推进 Run；不能据此证明真实模型、人工确认和 Web 提交链路具有完全相同的可达窗口。
- 后续四项通过案例明确改为“原生会话已经持久化”的前提：仅在初始化消息结束、尚未建立 Run 时调用官方 persistence.flush；之后工作中断仍为真实强停，预算预留未人为结算。这个前置条件只在测试中存在，没有偷偷加进生产代码。
- 原失败目录不改写，也没有把失败样本补写成通过。需要补查原生入口的 Session 持久化与 Journal 提交顺序，以及已存在 Journal 但无法恢复 Session 时的可见处置入口；不能凭空重建会话、重放授权或重派角色。

证据：[首次跨进程失败](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/second/tests.log)、[子 Agent 样本](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/second/cases/child-model.json)、[根模型样本](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/second/cases/root-time-cap.json)、[待补额样本](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/second/cases/pending-gate.json)。

## R2：全量并行回归中一次真实命令回收等待超时

状态：**保留未闭环观察；原因未确定。** 不能归因于普通机器负载，也不能仅靠复跑转绿判定修复。

- 第一轮全量为 332/333；唯一失败是既有测试 `real PowerShell budget stops a running command while its parent waits, without stopping unrelated work`，等待本轮预算封闭并确认角色／命令收敛的 10 秒窗口超时。
- 本轮四个新增跨进程测试在该次全量全部通过。生产源码和构建没有改变；没有修改原测试的预算、等待窗口、断言或跳过测试。
- 独立重跑原有三个真实进程用例为 3/3；其中时长项观测到 5000ms 已计量、命令中断、`exitConfirmed=true`、`toolSettled=true`，无业务 FAIL，独立对照进程仍存活。
- 第一轮全量没有保存该原生用例的逐阶段 JSON，只有失败日志，因此无法从该样本倒推出未收敛的具体原因。后续运行器新增原有 `WORKFLOW_PROCESS_EVIDENCE_DIR` 接线，失败和成功都保存已有探针输出；未放宽验证条件。
- 后续两轮全量均为 333/333，结果单独保存，不能覆盖原失败回执。若再次出现，需要从计时封闭、命令退出、ToolRuntime 结算及角色 drain 四个边界定位，再决定是否修实现或测试。第二轮见 [regression-v3](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/regression-v3/result.json)。

证据：[原全量失败](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/regression/tests.log)、[独立复查](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/native-recheck/result.json)、[独立时长证据](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/native-recheck/native-cases/active-time-exhaustion.json)、[后续全量](../../../.dsh/activation/workflow-crash-recovery-matrix-20260917/regression-v2/result.json)。

## 准入影响

四项有限恢复机制的通过结论保留，但以上边界仍未闭环，Gate B/C 不能升级为 pass。继续保持受控内部 Alpha 和整轮预算默认关闭。不以本次测试代替长期负载、撤销事务原子性、真实 Web 强停、独立体验或发布回退验收。
