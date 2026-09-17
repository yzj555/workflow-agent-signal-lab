# 未知运行的受审计人工处置 · P2-4

日期：2026-09-15。状态：源码、构建、隔离自动化、激活和独立在线机制验证已完成；三项通用显示问题已修复并通过技术回归。**原有 unknown 样本未处置，独立用户体验验收未完成**。整体仍为受控内部 Alpha。

## 决策

本版先落地最窄的恢复路径：核实后结束旧运行，再以新目标重新确认，不恢复旧 Agent 或重放旧命令。

| 记录 | 意义 | 不代表什么 |
| --- | --- | --- |
| `command/finished` / `agent/runtime-interrupted` | Host 实际观察到的退出事实；旧 Host 丢失观察时仍为 unknown | PID 消失、空列表或 accepted 不是退出证明 |
| `runtime/manual-close-requested` | 协调者整理的逐项核实陈述、证据来源、精确范围和处置原因 | 不是事实自动验证，也不是批准 |
| `runtime/manual-close-recorded` | 原生用户权限门禁采纳该陈述并明确人工结束 | 不把用户陈述改写成 Host 退出凭据 |
| `ABANDONED` / 人工结束 | 旧 run 结束；后续工作必须新建 run 并重新确认 | 不是 PASS、业务 FAIL 或已确认取消 |

`operator=unverified` 沿用官方回答协议的真实边界：证明原生用户权限通道与对应问题，不证明实际操作者身份。插件不自动验证用户／协调者给出的核实陈述是否真实。

## 用户流程与权限

1. 页面继续显示未确认停止；协调者读取 `workflow_status.reconciliation`，在原生输入框与用户交流，不要求用户拼接工具参数。
2. 用户明确要求处置后，协调者逐项整理旧 Agent、命令、可能产生的后台工作及外部影响的核实依据。仅有旧 PID 消失等有限观察时，应继续补查，不得编造完整证明。
3. `workflow_reconcile` 接受当前 revision、原因，以及每个 assignmentId／incidentId 对应的来源和观察陈述。Host 自行补入任务版本及所有 unknown 命令 ID，不能由模型省略。
4. 原生 composer 通过插件的精确人工处置选择器呈现；首屏显示标题、系统未独立验证的声明和处置后果，全部范围、依据及原因可展开核对。按钮「保持阻塞／人工结束本轮」逐字提交原 Host 选项，返回对话取消当前问题；不新增输入框，也不接管其他计划或批量问答。只有已核实旧执行及其后台工作不再执行、外部影响已明确，才选择人工结束。
5. 明确确认后，批准、人工处置、ABANDONED 三条事件在一次 Journal 原子提交中保存。当前事项注明「人工结束 · 退出证据仍未知」，顶部直显「人工结束」，原任务、Agent、命令与验收状态不改写。处置原因／审计和 Agent 逐项依据分别展开，不截断或拼入短摘要。
6. 不自动新建任务、续跑、重试、撤销文件或沉淀。只有新的用户目标经新 run 的需求／执行门禁确认后，才能开始新工作。

本版只允许处置**没有当前 Host 执行／回收凭据**的未知范围。若当前 Host 仍在执行、等待 admission、回收或持有该未知范围的凭据，入口拒绝；不能通过此工具绕过正在进行的回收。它不提供全局进程控制、搜索机器上任意进程或恢复旧句柄的权限。

## 正确性约束

- 全量范围绑定：必须覆盖每一个 unknown incident、assignment、任务版本及其全部 unknown command；遗漏、重复、跨运行、旧 incident 均拒绝。未分类的 running 范围或 stopping 兄弟角色也阻止处置。
- 版本绑定：准备时检查 expectedRevision；回答时重新检查 run、revision、范围和当前 Host 凭据。任何期间状态变更使旧回答失效，只关闭门禁，不能结束。
- 原生问答独占：不能覆盖另一个未完成的问题。拒绝、取消、插件卸载、旧 requestId、含糊或多个选项都不产生人工结束。
- 持久重放再次验证门禁种类、用户权限与 requestId、精确范围、事件顺序。人工结束必须紧接其专属批准，并紧接 ABANDONED；不能单独伪造终态或倒填审核。
- 原 unknown 观察不可替换为 exitConfirmed=true。普通 PASS／FAIL／CANCELLED 也不能隐藏已记录的未回收范围。写盘失败不发布成功快照。
- 冷重放保留审计和历史，重复启动扫描不重建旧 Agent，不再增加同一 unknown。`workflow_stop` 不把人工结束补写为已确认取消。
- ABANDONED 不提供自动文件撤销授权：本版保留拒绝，文件及外部影响需另行核实和明确授权。

输入上限为 20 个中断范围，每项 1–5 条依据，每条来源／观察不超过 2000 字符。超过范围上限拒绝，而非自动截断。卡片陈述按纯文本转义，不执行用户提供的链接或 HTML。

## 实现与验证

- `src/workflow-reconciliation.ts`：输入、完整范围核对及原生问题。
- `src/host/workflow-controller.ts`、`workflow-tools.ts`：精确原生根 Agent 权限、当前凭据约束、问答生命周期与原子落盘。
- `src/workflow-events.ts`、`workflow-run-projection.ts`、`workflow-view.ts`：请求／裁决重放、ABANDONED 与只读审计快照。
- `src/client/workflow-display.ts`、`workflow-stage-display.ts`：人工结束与未知退出并存，阶段未完成不涂成完成；仍为原生输入、只读视图。
- `tests/workflow-reconciliation.test.mjs`：13 项测试，包含范围防伪、取消／卸载、竞态、落盘失败、冷重放、迟到凭据、新 run 不继承批准等。
- `tests/workflow-native.test.mjs`：增加 1 项真实官方 ToolRuntime、userQuestions、SQLite 与预设接线集成。旧运行历史和回答均为隔离夹具，不冒充真实在线 Host-loss。

实现阶段全量 **220/220**、类型检查和构建通过。证据：`.dsh/verification/workflow-manual-recovery-20260915/`。该实现阶段未调用付费模型、未重启 3080、未回答现有在线恢复门禁；以下在线阶段另行获得用户授权，不改写之前的证据边界。

随后完成真实模型与原生问答的独立在线验证（`.dsh/activation/workflow-manual-recovery-20260915/verification.md`）：

- 独立 Session `workflow-command-online-manual-recovery-20260915`，run `807e066e-eeb3-47df-9b20-902f61012fb4`。真实 ENG-1 命令及受控子进程已运行，精确中断 Host 并重启后 revision 35／unknown。
- 原生拒绝后 revision 38、outcome=null；再次明确确认后 revision 43／ABANDONED。原命令 unknown、exitConfirmed=false、任务／Agent／验收／返工／产物记录逐项不变，未发生停止请求、文件撤销或命令重放。
- 第三次受控重启后，完整事件和 revision 43 不变；原生 UI 的当前事项、未完成阶段和结束说明保持正确。
- 同一 Session 提出新文本目标后，新的 run `8d3a6e57-7927-4924-b698-f714b5248a69` 在 revision 51 等待新 signal 门禁，0 个新 Agent，不复用旧批准。收尾取消这个未执行目标，Session revision 55；人工结束的旧 run 完整保留。
- 原有 16 条 Journal 原始内容摘要全部不变：受保护 unknown revision 35，业务 PASS revision 126。DSH 核心未修改，最终官方 Host 20932；原生 Session 条目 162，当前活动／队列／作业为零。55 条既有非驻留诊断保留，非全库健康证明。

本组由代理依据明确验证授权操作，`operator=unverified`；不是独立用户可用性验收。实际发现的三项显示问题随后已修复，详见 [问题与修复记录](issues/manual-recovery-native-labels-20260915.md)。显示修复版类型检查、构建与 224/224 通过；真实 DSH 原生 PendingQuestion 回放检验两种选择、取消、异常与重复点击、替换请求隔离、完整依据和长内容，答案仅在测试浏览器内结算，不产生 Host 裁决。当前 17 条 Journal 摘要全部未变。

## 激活与下一步

激活和本组独立在线验证已完成。三次重启分别用于激活、真实执行中断、处置后持久化检查；均排除其他活动并备份，旧 owner 改名留存。现有 Host-loss 样本没有因本次验证而获得处置批准。

新增事件和 ABANDONED 对新版是可回读扩展，旧版不认识它们；不能把旧构建直接接入已产生这些事件的库。回退须使用停机备份中的匹配版本，不删除或改写新事件。

显示修复仅需新前端，3080 已提供匹配构建，Host 20932 未重启；服务内仍是上轮已验收的 Host 行为，源码端仅提取相同问题常量，不改变协议。记录见 `.dsh/activation/workflow-manual-recovery-ui-20260915/verification.md`。

此处只补行政处置入口，不宣称能够自动恢复旧执行、证明任意 OS 进程树退出或完成 Gate B/C。剩余重点：整轮资源预算、更多阶段与崩溃切点、撤销事务一致性，以及生产发布与独立用户准入。
