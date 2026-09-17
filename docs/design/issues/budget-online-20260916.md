# 最小预算在线验收的开放问题

状态更新（2026-09-17）：**1～3 已修复并通过原生回放；4 已实现新备份路径并通过隔离测试与当前停机源文件的只读取证，原 I/O 错误底层根因和原强停现场仍未复证。** 本次收尾不等于完整生产门禁通过。下文保留 2026-09-16 的原始观察与建议，不改写旧失败回执；未编辑任何历史 Journal 或当前门禁。

## 1. 顶部缺少明确的预算原因

真实快照已 `blocked.resource=root-model`、used=2/2，工作流正文准确说明“本轮累计请求预算耗尽 · 不再自动推进”，但原生顶部及工作流主状态仍显示通用“待你确认”。`workflow-display.ts` 已产生“预算耗尽” badge；`workflow-surface.ts` 的 badge 白名单未纳入预算类别，随后由 `needsUser` 覆盖。

后续应修通用状态映射，统一覆盖请求耗尽／时长耗尽／补额待答／补额后等待继续，并保留未知停止、人工处置等更高风险事实。不能只改这个测试 Session 的文本。

## 2. 已结束却虚示正在整理经验

预算确认结束后 outcome=CANCELLED、recovery.closed=true、两个任务均 cancelled、0 Agent、原生 running=false。重启前后界面仍显示“待沉淀”“交付已结束，正在整理可复用经验”，把“尚未记录沉淀决定”表述为活动事实。源码 `learningNotReviewed = run.outcome !== null && !learningReviewed` 未区分预算明确结束与实际沉淀活动。

后续应优先显示明确结束事实。“未整理”“可由用户以后发起复盘”与“正在整理”必须分开；不能通过虚构 `learning.reviewed`、补写规则或自动触发模型来消除视觉状态。实际有沉淀活动／待答时再展示对应状态，既有正常 PASS 后沉淀、人工结束、撤销历史保持正确。

## 3. 预算卡沿用计划卡动作词

预算原生问题原文为“是否增加本轮执行额度？”或“是否结束本轮工作流？”，冻结选项为“确认增加本轮额度”或“确认结束本轮，不继续执行”；真实卡片却显示“计划待审／确认执行”。完整额度／原因正文可读，实际返回原选项且正确落盘，但可见动作语义不够直接。

后续参考已有人工处置的精确 native composer 呈现：选择器绑定原生 Session／问题归属和共享结构，显式显示补额或结束，不造第二套聊天 UI。确认必须绑定同一冻结 requestId；不改默认计划卡、不把旧问题回答移用到新问题。按钮含义、完整详情可达、拒绝／返回／重复点击／换请求都需回归。

## 4. 停机后的备份读取失败

第二次空闲重启在 Stop-Process 确认旧 Host 退出后，只读 SQLite 查询报 `disk I/O error`，`errcode=1546`；`restore-after` 备份未完成。脚本保留 failed 回执，finally 恢复服务。重启前一致性备份有效；恢复后新增 `restore-recovered-live` 备份，现库和这两份备份的 18 条记录 SHA-256 一致，SQLite integrity_check 正常。不能将“服务恢复、记录一致”改写为“停机后备份成功”，也不能据此推断所有崩溃切点安全。

原因未在本轮证明。后续先在隔离目录验证 Host 退出后的 SQLite/WAL 取证策略，分别记录服务恢复、记录完整性和各备份步骤；不得删 WAL、替换现库、伪造 writer，或吞掉错误直接标绿。修复后如需再次中断真实 3080，另行说明范围；不追加本轮第三次重启。

## 证据与建议顺序

证据根：`.dsh/activation/workflow-budget-online-20260916/`。`resumed-blocked-workflow.png` 为预算正文／顶部不一致；`topup-approved-before.png`、`end-approved-before.png` 为原生卡；`ended-after-restore-workflow.png` 为结束后虚示活动；`restore/restart.json` 为失败但服务恢复的不可覆盖回执；`verification.json` 为分项核验结论。

建议先合并处理 1～3 的通用呈现规则并做只读回放，不需要再耗真实模型或中断 Host；并行准备 4 的隔离备份测试。上述项关闭前不扩大在线预算矩阵，也不标记生产 Gate C/D 通过。

## 2026-09-17 收尾结果

| 项目 | 处理与证据 | 当前边界 |
| --- | --- | --- |
| 顶部状态 | 统一读取 projection 的明确 badge；预算耗尽、时长耗尽、待补额、待结束、等待继续均可见 | 不覆盖根协调恢复、unknown／stopping、人工处置和撤销 |
| 结束与沉淀 | CANCELLED 正常显示结束／无需操作；缺少整理证据显示“未整理”；正常 PASS 也不靠缺少事件推测活动；真实候选保持待决定 | 无 Journal 改写、无自动模型调用、无伪造 reviewed |
| 预算卡 | 精确匹配 Session、问题原文、冻结动作、原 PendingQuestion；使用官方按钮和 Markdown 呈现完整次数／时长额度及权限边界（不是费用账单） | 不改通用计划卡、不新建聊天框；确认仍由 Host 核验 requestId，实际操作者不推定 |
| 停机备份 | `scripts/lib/journal-backup.mjs` 区分 online／stopped。停机前后复核 owner 与文件摘要；原始 DB/WAL/SHM 保留，仅副本恢复；最终快照做 integrity_check、记录摘要和业务校验 | 原失败原因未确证；未再中断真实 DSH。不是任意并发写环境的文件快照或全部崩溃切点保证 |

类型检查、构建、318/318 全量回归通过；12 项新增测试（7 项预算呈现／契约，5 项备份），原阶段展示测试按“无证据不声称正在整理”的新规则更新，实际候选／撤销／人工处置路径继续回归。真实 DSH 0.1.5-rc.1 渲染器与官方 PendingQuestion 本地回放 20 项检查通过：6 个状态、12 组宽窄／深浅卡片、长内容与交互生命周期。回答只存测试浏览器，不向 Host 提交。

原 18 条 Journal 内容摘要完全一致，原预算会话日志字节不变；PASS revision126、unknown revision35 和已结束预算 revision10 的真实界面保持正确。用户仅授权正常启动与只读验收；本轮正常启动 3080，无模型任务、无真实批准、无 Host 强停。新证据：[收尾核验](../../../.dsh/activation/workflow-budget-cleanup-20260917/verification.md)。

备份策略依据 SQLite 官方 [WAL 生命周期与只读限制](https://sqlite.org/wal.html)、[Online Backup API](https://sqlite.org/backup.html)：WAL 可能仍含已提交数据，不能只复制主库；SHM 是可重建索引，本次仅在隔离恢复副本上重建，源 sidecar 不删除。`backup.json` 分别报告 backup／integrity／sourceUnchanged；重启脚本另列 backupBefore／backupAfter／serviceRestored，服务恢复不能掩盖备份失败。
