# 人工处置被原生评审卡显示为“确认执行”

状态：FIXED，2026-09-15 完成插件通用显示修正与技术回归；独立用户 Gate D 未通过。下文“实际观察”保留修复前证据，不改写历史记录。未修改 DSH 核心、历史卡片或 Journal。

## 实际观察

- 独立 Session：`workflow-command-online-manual-recovery-20260915`，run `807e066e-eeb3-47df-9b20-902f61012fb4`。
- `workflow_reconcile` 提供的问题是“已核实旧执行停止及其影响，结束本轮吗？”，选项是“尚未核实，保持阻塞”和“已核实停止及影响，人工结束本轮”。
- 真实 DSH 0.1.5-rc.1 的评审卡仍显示“计划待审”“拒绝”“确认执行”；问题正文仅在 section 的 `aria-label`，没有作为可见标题出现。处置范围与核实陈述在滚动正文完整保留。
- 证据：`.dsh/activation/workflow-manual-recovery-20260915/fixture/recovery-card/native-plan-review.png` 与 `fixture/recovery-keep-receipt.json`。第一次原生“拒绝”实际对应保持阻塞，revision 37→38、gate rejected，未形成任何结束结论。第二次“确认执行”实际返回完整人工处置标签，revision 40→43、ABANDONED；见 `fixture/recovery-close-receipt.json`。
- 最后一次重启后的真实页面进一步暴露两项信息层级问题：顶部状态仍标记“交付”，没有直接显示“人工结束”；Agent 行将全部核实依据拼入摘要，明显挤占主要阅读区。现在/接下来、阶段终态和结束说明的语义正确，但不能据此声称首屏全部状态已经明确。证据：`persistence/closed-ui/real-dsh.png` 与此前 `closed-ui/real-dsh.png`。

## 原因与范围

已检查官方 `packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx` 及 `contract/slots.ts`：`planReviewOf` 保留选项原标签，回调 `decide(review.approve.label)` / `decide(decline.label)` 也逐字传回，但界面按钮文本固定使用 `t('plan.approve')` / `t('plan.decline')`，顶部固定使用 `t('plan.header')`。

因此这是当前原生 presentation intent 的显示约束，不是本次会话文案随机生成错误。验收脚本明确记录“显示标签”和“原始裁决语义”的差异，不把没有显示的标签写成可见证据。

## 修复范围与验收

已通过官方 `conversation.composer` 链、原生 Button／DisclosureRow／MarkdownText 实现人工处置专用呈现。选择器要求 Session 归属、单问题、精确共享 header／question／intent、恰好两个原始选项；非匹配项仍走官方呈现。没有新输入框，返回对话只取消当前 PendingQuestion。

已覆盖：可见标题“人工处置”、按钮“保持阻塞／人工结束本轮”、顶部“待人工处置／人工结束”、首屏不停止进程／不撤销文件／不续跑。完整问题 detail 可展开，处置原因和审计单独留档，每个 Agent 的全部来源、观察及精确范围另行展开；不截断证据。

类型检查、构建和 224/224 回归通过。真实 DSH 原生页面以保存的 revision 40／43 记录只读回放，使用官方 PendingQuestion 验证两种选择、取消返回、错误重试、同帧重复点击、换请求后状态重置、旧请求迟到结算隔离，以及普通计划与首道需求门禁不受影响。浏览器答案只留在测试内存，不发送给 Host；不得将其当作又一次在线业务裁决。

证据：`.dsh/activation/workflow-manual-recovery-ui-20260915/verification.md`。现有 17 条 Journal 记录内容摘要全部未变，Host PID 20932 未重启，DSH 核心干净。1440／540／390px 下工作流内容和处置卡无横向溢出，长文末尾与操作按钮可达；390px 极窄宿主顶部多个插件席位仍有拥挤，作为整体响应式体验限制保留，未用全局 CSS 覆盖宿主。
