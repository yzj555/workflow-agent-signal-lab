# 原生历史目录告警：原因与影响核验

日期：2026-09-20。结论：**24 项关联告警的原因和影响范围已确认；未迁移历史，未将数据健康改为通过。**

本次使用当前官方 3080 的只读历史接口、受影响原始文件的独立副本及固定版本的官方格式读取器。未重启、调用真实模型、批准门禁、更改预算或修改 DSH 核心。

## 发现

| 项目 | 确认的事实 |
| --- | --- |
| 原目录结果 | 55 项 diagnostic 中，24 项关联工作流；这 24 项原先都只显示 `unavailable` |
| 具体拒绝 | 官方历史接口和离线格式读取器均拒绝 `v0` 会话中的 `subagent/descriptor v2`；固定 DSH `0.1.5-rc.1` 的迁移器不支持这种组合 |
| 文件证据 | 24 份原始文件均可逐帧解压、解析 JSON；header 为 v0，descriptor 为 v2／continuable，没有更高 generation；原始内容及目录未变化 |
| 时间与范围 | 2026-09-03 至 09-09 建立，涉及 3 个根会话、8 个已有结局的运行（5 CANCELLED、3 PASS）；没有落在仍待结束的运行上 |
| 解释边界 | 不是从 `unavailable` 字样猜出的原因，不是暂时无响应或 Journal 解析失败；也不等于所有历史语义均正确、旧对话已恢复或相关 OS 进程已获退出证明 |

官方依据固定在源码提交 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`：

- [`session-format-v0-to-v1/validation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/session/session-format-v0-to-v1/src/validation.ts)：`assertReleasedEventPayload` 明确拒绝 v0 中非 v3 的 descriptor。
- [`subagent/list-children.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/subagent/subagent/src/list-children.ts)：观察失败可被目录归入 `unavailable`，该标签不是具体根因。
- [`session-controller/history.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/api/session-controller/src/history.ts)：`page` 是不激活 Agent 的历史读取；本次以真实父子关系及原存储的 continuable 模式复查。

仍有 31 项非本插件根会话下的目录告警未在本批解释。原记录的未知退出与历史文件差异不因本次分类而消失。

## 历史 SQLite I/O 的边界

2026-09-16 停机后备份失败的回执仍保留。原记录的扩展码 `1546` 对应 `SQLITE_IOERR_TRUNCATE`，表示 VFS 调整文件大小时失败，不能由此确定具体文件、占锁进程、驱动或硬件原因。参见 [SQLite 官方错误码](https://www.sqlite.org/rescode.html#ioerr_truncate)。

本批再次确认：故障前、恢复后以及当前的这 **18 条原始 Journal 内容摘要全部相同**；当前共 20 行。没有发现该次事件造成这些记录的内容丢失，但现场已不完整，物理根因仍未证明。现有停机备份的“保留原件、只在副本恢复”测试保留；不为重现旧错误而强停线上 Host 或操作真实 WAL／SHM。

格式不兼容与 SQLite I/O 是两件独立事项，不能互相解释。

## 本批改动与验证

- 增加 4 项原生持久化回归，覆盖原始 JSONL 与多帧 Zstandard：目录 header 可列出但旧正文拒绝；当前 continuable 正文可以冷读；读取不改原文件、不发布后继。只挂载持久化组件，不创建 Agent 或调用模型。
- 诊断工具不再将 `unavailable` 描述为必然“暂不可读取”；明确提醒历史格式不兼容也是可能原因。没有把错误字符串自动解析成可放行的健康结论。
- 专项 4/4；同一候选连续两轮全量 **442/442**，均无失败、跳过或取消，双端类型检查通过。冻结 53 个运行时源码、55 个测试／夹具、67 个维护文件和 24 个构建输出；与前批相比，运行时源码及构建摘要相同。
- 原运行时源码及构建没有新改动；此前容量／故障处置候选仍未在线激活。
- 最终线上 20 条 Journal 内容、24 份受影响原生文件及目录、部署构建、预设、配置和 Host 精确身份均不变。原生根会话 172，运行／活动子项／驻留诊断／未分类驻留／读取失败均为 0；55 项历史目录告警保留。

私密证据位于本地 `.dsh/activation/workflow-native-catalog-20260920/`：在线只读回执、原始副本、匿名影响表、保护检查；全量日志位于相邻的 `workflow-diagnostics-20260920/native-history-v1/`、`native-history-v2/`。真实路径、会话 ID、原始错误和对话内容不进入公开仓库。初始取证脚本的首帧解压错误保留：Node 单次 Zstandard 解压只得到第一个帧，已改为按实际消费字节逐帧有界读取，不能把该夹具错误归因为日志损坏。

## 对正式版准入的影响

已关闭的是“24 项关联告警根因不明”，不是“旧原生对话兼容已修好”。Journal 回放、原生目录枚举和原生完整历史读取必须分开验收。

若要宣称现有 Profile 无损升级，必须另行解决或明确处置这批不兼容历史；不得改写版本字段、绕过验证器或复制一个假当前 generation。迁移适配，或保留原始档案并另设生产 Profile，均需明确方案与对应授权，本轮没有替用户作此选择。Gate C/E 不据本批转绿。

后续决定（2026-10-08）：用户选择独立生产 Profile、保留全部旧档案；这里只确定方案，没有执行创建、迁移或重启。旧原生格式仍不兼容，不宣称已修复或原 Profile 无损升级。后续验收需同时证明新 Profile 独立可用和旧档案完整保留，见[正式接入方案](../operations/production-v1-status.md#正式接入方案已确定2026-10-08)。
