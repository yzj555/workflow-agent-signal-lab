# DSH 0.2 安装后的只读采集与 RC.9 复现

结论：**新版原生采集已在实际安装的 RC.9 中通过，最终两次干净构建各 574/574，归档一致。** 本批只验证独立测试环境的采集入口；没有启用 Workflow Agent，不能替代同包启动准入、Web、升级回退或生产验收。

正式接入继续采用用户选择的独立生产 Profile，完整保留实验 Profile 和旧档案。本批没有创建生产 Profile、迁移旧记录、操作 3080、调用真实模型或对外发布。C/D/E 尚未整体通过。

后续实际启用发现旧重载检查和主视图绑定不适用新 SDK，已在 RC.11 隔离候选修正，安装后准入／Web／同版本重配置取得新证据。本文 RC.9 采集结论不变，不把后续结果倒填到 RC.9 或据此关闭完整 Gate E。见 [RC.11 实际安装核验](2026-10-08-dsh-020-installed-activation.md)。

## 固定基线与接口修正

Windows x64、Node 26.1.0、pnpm 11.7.0、DSH `0.2.0-rc.2`，官方源码提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。归档清单保持精确共享 peers、默认停用的四项组合和准入／维护协议；官方 CLI 仅加入发行工程开发依赖，用于独立安装验证，不进入运行时 dependencies。

按实际官方契约适配，而非在新版上猜测旧接口：

- `session/control` baseline 只提供 projections；从 `values.inbox` 读取待处理输入，不能沿用旧 queues／jobs。缺少提供者或不合法水位时保留未完成。[官方 Session 类型](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/session-controller/src/types.ts)
- 对每个可观察 Session，读取非激活的 `session/projections` 和非消费的 `job/list`；两者 Remote 参数均为 `{request: {sessionId}}`，不是平铺参数。job 列表覆盖该 Session 所属及无归属任务，不等于整个 Host 的任务清单。[官方 Job 类型](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/job-controller/src/types.ts)
- 新 SDK 没有旧 `subagents/list` Remote 入口；通过 `values.subagentCatalog` 递归核查子目录。缺少目录能力、未知模式和变化都不默认为健康或空列表。[官方子目录投影类型](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/subagent/subagent/src/projection-types.ts)

每个目标进行两轮独立读取，并核对开始／结束的驻留范围、输入、目录和任务指纹；同数量替换也能识别变化。仅保留计数与变化指纹，不输出正文、标签、任务输出或认证信息。新旧契约分开解析，没有失败后回落旧接口或补写空值。

## 最终构建与安装证据

第二轮从冻结源码启动；两轮都在不同仓库外目录重新安装 frozen-lock 图，禁止安装期脚本，进行生产模式双端类型检查、构建、全量回归和打包。

| 核对项 | 结果 |
| --- | --- |
| 类型检查、构建、全量测试 | 两轮各 574/574；50 个测试文件；失败、取消、跳过和 todo 全部为 0 |
| 输入与载荷 | 220 个输入、43 个载荷文件及归档一致 |
| 实际解包 | 归档列表符合清单；新临时目录中解包后的全部文件摘要相符 |
| 停用与协议 | 四项组合默认停用；准入协议 1、维护协议 1；不自动迁移 |
| 实际安装 | 官方 CLI 0.2.0-rc.2 在独立空 Home 安装同一归档；从安装目录调用脚本，核对其摘要 |
| 环境保护 | 主工程 src／tests／scripts／preset／lib、package 和锁与本批起点一致；RC.8 归档保留；官方源码工作树干净 |

最终 `local-workflow-agent-signal-lab-1.0.0-rc.9.tgz` 的 SHA-256：

```text
3e5982d9a9c01f748a5d05bd852f0643663b4fc70411c5aab7f1405d06261dbd
```

实际测试 Host 使用动态 loopback 端口，不占用 3080。测试夹具在自己的独立包中声明正确 peers，使用官方 Session、JobRegistry 与持久化接口；模型调用被禁止。测试任务是受控合成任务，不冒充真实外部命令的退出证据。

| 安装后场景 | 采集结果 |
| --- | --- |
| 已有 Session，无待处理输入／活动 job | 未观察到活动，退出码 0 |
| 无归属活动 job | 需处理，活动数 1，退出码 2 |
| 再增加所属活动 job | 需处理，可见活动数 2，退出码 2 |
| 两个 job 进入终态 | 未观察到活动；仍保留任务总数，不据此证明 OS 退出 |
| 待处理输入 | 需处理，待处理数 1，退出码 2 |
| 夹具清空输入后再次采集 | 未观察到活动，待处理数 0，退出码 0 |
| Agent 已释放，Session 冷读 | 未激活 Agent；读取成功，驻留集合为空 |

七个场景采集前后的输入、任务状态、模型调用及取消计数一致；真实模型调用和取消均为 0。无任何 Session 可用于 job 读取时返回 `incomplete`／`job-coverage-empty`；错误认证返回 `incomplete`／`authentication-rejected`。这些非零结果是预期拒绝，不包装为空闲。最终测试 Host 正常退出，code 0、signal null。

## 结果能证明什么

这是**有界、可见 Session 的观察**，不是跨接口原子快照。报告明确记录 `atomic`、`wholeHostJobsProven`、`processExitProven`、`hostVersionVerified` 和 `restartPermission` 均为 false。

采集入口根据安装包 peers 选择期望契约；这不是对任意在线 Host 版本的认证。本批实际测试 Host 的版本由独立启动环境另行核对，不外推到当前 3080。两轮稳定读取、任务终态或退出码 0 均不能证明未知 owner 的任务不存在、OS 后代已退出、旧历史完整可读或有权重启。

上限保持有界：5000 个列表 Session、10000 条目录项、15000 个观察目标及每 Session 15000 个任务行，单响应／输出 8 MiB、累计 256 MiB，单请求 15 秒、整次 120 秒。缺失、漂移、超限、错误状态或越属行保留未完成；不截断后声称成功。

## 失败记录与未完成项

最初两轮虽已全量 574/574、归档一致，但实际新版安装探针发现平铺 Remote 参数和旧目录入口不适用，采集返回未完成；**这两个早期归档不计为最终验收对**。首次实际夹具因文件位于旧清单工程内而被官方版本检查拒绝，随后在独立测试包正确声明 peers，没有使用版本豁免。测试中的 owner 构造、目录一致性替身及最终审计说明匹配错误也已修正，保留失败现场，未放宽权限、容量、退出或变化检查。

完整 SDK 与采集工程仍冻结在私密候选，未合回主工程或覆盖在线构建。后续须对同一归档完成 Workflow Agent 启动准入、配置漂移拒绝、实际 Web、停用、升级和保留新数据的兼容代码回退；再按独立生产 Profile 方案取得实际创建／切换许可，进行独立真实使用和正式交付。历史 I/O 根因未知和旧原生格式不兼容继续保留，不通过本批采集“修复”。

本机证据：`.dsh/activation/dsh-020-capture-source-20261008-v3`、`dsh-020-capture-20261008-rc9-v3`／`v4`、`dsh-020-capture-20261008/installed-v4`、`dsh-020-capture-repro-20261008-v1`。这些私密原始记录不进入公开载荷。前置 [RC.8 发行验收](2026-10-08-dsh-020-release.md) 保留，最新整体状态见 [Production v1 清单](../operations/production-v1-status.md)。
