# DSH 0.2 隔离兼容核验（2026-10-08）

本页保留此前 38 项运行时候选核验的范围与结果。随后已增加声明式启动准入和恢复夹具适配，主源码因此有新接线；当前进展以 [后续核验](2026-10-08-dsh-020-declaration.md) 为准，不能将下文的“源码未替换”外推为后续仍无改动。

结论：**0.2.0-rc.2 运行时适配候选的类型、构建和 38 项原生回归通过；生产安装兼容尚未通过。** 候选只在仓库外临时目录构建，完整源码和日志已冻结到私密证据目录。主工程的运行时源码、预设、依赖锁及在线 `lib` 没有替换，新生产 Profile 没有创建。

## 官方基线与真实差异

核对官方干净源码 `639ed015397290b3745d163aafe02ffee4aa3f84`、CLI `0.2.0-rc.2` 及 npm 同版本元数据。隔离图固定全部 DSH 子包、Cordis 4.0.4、Schemastery 3.18.4、Include 1.0.9 和 Loader 1.0.5；不是只改 CLI 版本后继续使用旧模块。

新官方注册表不扫描预设目录，改由普通 Cordis 声明行注册；注册表默认值与用户已选默认值仍应保留。[固定版本官方注册表说明](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/preset/agent-preset-registry/README.zh.md)

声明中的 Loader 行 ID 和会话保存的 preset ID 不同，子插件的 `!!js` 延后到自身激活时求值，不能通过 JSON 改写丢失表达式。[固定版本官方声明说明](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/preset/agent-preset/README.zh.md)

| 原接口／做法 | 本次核查与候选处理 |
| --- | --- |
| `dsh-agent-presets` 目录注册 | 类型导入改到 `dsh-agent-preset-registry`；隔离原生测试真实加载 `dsh-agent-preset` 声明，不用模拟注册表 |
| 通用 `source.kind=plugin` | 新版要求生产者声明自己的消息来源；工作流使用类型扩展的 `workflow-control`，保留 notice 语义，不放宽工具权限 |
| Agent 创建回调隐式 void | 同步权限安装后显式返回 undefined，仍能在原生 Agent 发布前拒绝无授权绑定 |
| 旧尺寸后缀的图标导出 | 沿用新版官方 Medium 图标，保留本地导入别名；类型通过不代替页面渲染／尺寸验收 |
| 测试 Shell 替身 `run(spec)` | 改为官方 `execute(spec)` 与 `ShellExecution.result()` 生命周期；插件原生产执行包装没有因此改动 |
| control baseline 中的 queues／jobs | 新版 baseline 仅有 projections，inbox 已进入 projection；后台 jobs 须另取完整证据，不能删掉旧检查后宣称空闲 |

## 实际验证及范围

隔离依赖来自注册表 frozen-lock 安装、禁止安装脚本；直接依赖物理目录均留在隔离工作区。原生测试中的本插件为当前构建的普通文件副本，核对 Cordis、LLM、Session、注册表与测试 Host 解析到同一模块。**这不是从正式归档安装的 Web Host 验收。**

- 同一候选两轮 Host／Client 类型检查、production 模式构建及原生回归通过；55 个源码文件，7 个适配文件，23 个输出文件。两轮源码、测试夹具、预设、依赖锁、编译配置和 lib 摘要一致。
- 每轮全部 38 个原生用例执行：38 通过、0 失败、0 跳过、0 取消；逐项核对 TAP 名称和计数，不能把文件级 exit 0 当成执行了用例。
- 覆盖选择预设、模式进入／退出、根工具视图与最终权限 guard、子角色隔离、原生确认、串并行、同 ID 返工、人工处置、模型／命令额度、取消与回收。真实 PowerShell 和 SQLite 写锁用例也执行。
- 模型为本地脚本化适配器，确认由测试回答者提供；不冒充外部模型、真实用户授权或独立使用验收。
- 新增 4 项验证报告回归，拒绝无匹配、部分筛选、重复名称、跳过／取消／失败和截断输出。它们不计入原生 38 项，也不宣称重跑了旧 RC.7 的 528 项全量。

## 失败证据不覆盖

第一次筛选误用了 `^real preset hides coordinator`，实际名称以 `official` 开头，未执行目标用例；该文件级成功不计为通过。准确名称重跑后实际通过，再运行不带筛选的完整 38 项。

第一轮完整原生测试为 **35/38**。三项工程命令测试超时，其中实际保存的诊断为 `ctx.shell.execute is not a function`。原因是测试替身仍使用旧 `run()`；按官方新版句柄接口更新后，三项专项通过，再完整回归通过。没有提高生产超时、关闭额度／退出证明检查或将 unknown 改成成功。首次结果保留为工具输出观察摘要，**不伪称保存了未捕获的整份首轮原始日志**。

随后 v1／v2 使用了 release 构建配置，但采证脚本设置 `NODE_ENV=development`，不能将这两轮命名为生产模式。脚本已修正，并新增明确的 buildMode／各阶段 nodeEnv 回执；v3／v4 在 production 模式下类型／构建／38 项全量原生回归均通过，同候选摘要一致。旧模式的成功现场保留，不篡改其环境含义。

## 接入前仍必须完成

1. 将验证候选与新依赖图一起整合；移植崩溃恢复测试夹具及其余旧 Shell 调用，重新执行全量矩阵，不能把旧版本 A/B/C 结果直接外推。
2. 发布层加入默认停用的声明式预设，首次配置与升级／停用／回退生成器改用声明行；保留默认 Agent、无关插件和用户表达式。
3. 启动校验改为检查声明／实际组合，不能继续读取已删除的 `trust/path`，也不能简单移除校验。官方注册表的诊断可能等待整个 Host Loader 结算；不得在 Host 行自身激活期间 await roster 而形成启动死锁。
4. 只读采集适配新 inbox 和独立后台 job 证据；缺失证据仍应返回 incomplete，不能产生空闲或退出证明。
5. 制作新固定版本预构建归档，重新验收实际安装、共享模块身份、官方 Web 渲染与升级停用。之后按已选方案准备独立生产 Profile，保留全部实验档案；真实切换和模型任务需各自授权。
6. 独立真实使用及最终 Gate D/E；当前 3080 的进程内版本／Profile／插件组成仍待认证。本批只观察到原监听 PID 72752 保持，不据磁盘版本声称在线适配生效。

本轮没有启动／重启真实 3080、安装到生产 Profile、迁移旧记录、读取私密签名密钥、发送真实模型任务、批准真实门禁或发布。RC.7 仍是旧 Host 基线的归档；新增兼容工具使当前开发输入集发生变化，不能声称当前全目录仍逐字等于 RC.7 的 211 个冻结输入。

## 证据与复查

私密证据位于本机 `.dsh/activation/`，不进入公开源码或发布包：

- `dsh-020-compatibility-20261008-v1`：固定官方源码／依赖图、原始及机械导入替换后的编译失败、首次原生失败观察。
- `dsh-020-native-20261008-v1`：类型、构建、38 项完整日志、候选源码／预设／测试／lib 和各文件 SHA-256；主工程 src／tests／preset／lib 及官方 checkout 前后不变。
- `dsh-020-native-20261008-v2`：与 v1 同候选的 development 模式重复类型／构建／完整原生核验及字节比对。
- `dsh-020-native-20261008-v3` 与 `-v4`：明确 production 环境的类型／构建／38 项原生回归与候选快照；`-v4/comparison.json` 核对两轮输入及 lib 一致，旧 manifest／锁／策略／发布层和 RC.7 归档仍匹配冻结摘要。

`scripts/check-dsh-compatibility.mjs` 只生成隔离探针并报告失败，不自动适配生产代码。已审阅的隔离候选可用 `scripts/verify-dsh-runtime-compatibility.mjs --probe <探针回执> --official-source <同一干净官方源码> --output <新的绝对路径>` 复查；固定 38 项清单变化需要重新审阅。验证脚本不操作服务或生产 Profile，候选快照不是可直接部署的发行包。
