# 已安装归档的首次 Profile 配置与启停

更新：2026-10-08。当前流程用于固定 DSH `0.2.0-rc.2`／插件 `1.0.0-rc.12`、官方 Node CLI、独立 Web Profile 与空私有数据目录；隔离安装验收通过不等于正式生产接入。已有非空数据请改用[离线重配置、升级与代码回退](workflow-profile-transition.md)，不要重新运行首次配置或对正在运行的用户 Profile 演练。RC.2／RC.5 的旧 SDK 差异在文末单列。

## 独立生产环境的准备顺序

独立生产 Profile 是用户已确定的方案，不是任意创建／切换许可。旧实验 Profile、原始档案、凭据和历史结局全部保留；不能复制旧运行冒充新环境任务，也不把隔离归档称作修复。各步的启动、模型调用及真实门禁按各自范围取得授权。

1. **仅离线准备**：获准后创建独立 Home／Profile，安装摘要已核对的归档；四项工作流安装行保持默认停用，不启动 3080、不复制旧数据或密钥、不生成活动任务。
2. **完成原生设置**：另获启动许可后，在工作流仍停用、没有启用 overlay 的状态下完成原生欢迎偏好及所需模型设置，然后空闲关闭。凭据由用户按原生方式提供，不写入证据正文、仓库或公开报告。模型连通性验证或任务调用需对应许可。
3. **离线冻结政策**：核对实际 CLI、Profile 和资源配置，明确停用该独立 Profile 中所有官方 HMR 行，再生成与核对新准入计划。HMR 政策影响整个 Profile 的配置和代码重载，不只影响工作流插件；工具仅核对／拒绝，不自动选择。
4. **受控启用**：按下文同一 Home、CLI、Profile 和原有 patch 顺序追加启用 overlay，获准后启动并验收。之后显式选择工作流预设才进入本模式，主要交流仍用原生输入框；不修改默认 Agent。

若只获离线安装许可，就停在第一步。不要为“提前准备好”而冻结尚未完成的原生设置，或把后续设置变化当作可以忽略的指纹漂移。

## DSH 0.2 的准入要求

RC.11 已在实际安装后的独立合成 Home 通过准入、原生 Web、停用和同版本重配置，见 [验收及限制](../validation/2026-10-08-dsh-020-installed-activation.md)。RC.12 已取得限定的[实际升级与兼容回退证据](../validation/2026-10-08-dsh-020-maintenance.md)，正式生产接入与独立验收仍待完成。

- 新版必须在离线、已明确选择的 Profile 中让所有官方 HMR 行显式停用；旧 manifest 的 `patchReload: startup` 已不生效。此政策影响整个 Profile 的配置和代码重载，不能默认修改共享环境。工具只核对／拒绝，不自动设置。
- 先完成原生首次欢迎偏好等已有配置，再生成准入计划；后续改变配置会使原指纹过期，需重新核查，不能删除校验或冻结旧设置掩盖变化。
- 离线检查与维护使用新版公开解析服务的临时作用域，结束即清理；实际 Host 仍校验物理模块身份。不要运行旧 fallback 修补函数或用开发链接填补依赖。
- 新版组合含四项默认停用行，启动按身份与 owner、controller 后预设子树审计两阶段封闭准入。HMR 拒绝发生在 Journal 打开前；后阶段审计失败会关闭已初始化 runtime 并释放 owner。不要把所有失败都描述成“从未打开数据库”。

## 前提

1. 按 [构建与安装说明](release-build.md) 准备固定组件版本的 Host，通过官方命令安装核对过摘要的 `.tgz`；不使用开发目录链接。SDK2 安装后声明、guard、UI 和 engine 四项行均停用。
2. 明确 DSH_HOME、Profile、实际启动 CLI 和私有数据位置。数据目录必须不存在或为空，且不能与安装／配置目录重叠；父目录必须存在。工具不会覆盖或创建已有 Profile。
3. 在完成原生设置、Host 空闲关闭后，**明确停用实际组合中每一项官方 `dsh-hmr` 行**，保留其他配置。行缺失、活动、动态表达式或嵌套 HMR 未停用都会拒绝；填旧 `patchReload` 字段不能代替此要求。不能未经同意修改共享环境。
4. 资源策略采用包内 `packaged-candidate`，具体额度见 [资源策略说明](workflow-resource-policy.md)。需要其他额度时先评审，不绕开生成摘要直接修改 overlay。

## 生成与核对

以下是命令结构，尖括号均须替换为核对过的实际值。入口取自**已安装的包**；不是源码目录中的旧构建。

```text
node <安装包目录>/scripts/configure-workflow.mjs prepare
  --host-package <实际官方DSH包的绝对package.json路径>
  --home <独立DSH_HOME绝对路径>
  --profile <已有Profile名>
  --data <新建或空的私有数据目录绝对路径>
  --policy packaged-candidate
  --output <不存在的输出子目录绝对路径>
  [--patch <已有overlay绝对路径>]...
```

实际在终端输入时合并为一行，或使用相应 shell 的续行语法。`--host-package` 目前要求已经解析到真实文件的绝对路径：pnpm 顶层别名可能经过 Junction，不要直接猜路径；先核对运行 CLI 和其真实 package manifest。数据、配置与输出路径同样不允许链接。

生成器只写新的 `activation-plan.json` 和 `workflow-enable.patch.yml`。它通过官方组合算法保留原有预设字段、roots、默认 Agent 和其他插件配置；遇到不明确的动态结构、全局重复 ID、禁用父层或已有工作流配置时拒绝，不猜测合并。

```text
node <安装包目录>/scripts/configure-workflow.mjs check --plan <activation-plan.json绝对路径>
```

SDK2 的 `check` 使用官方公开解析服务建立临时作用域，对照 Host 和插件的 peers 版本与物理模块身份，完成后按 Cordis 生命周期关闭；不要求先启动用户 Host 来建立旧 fallback，也不创建持久开发链接。check 输出仅表示配置和模块核对通过，不证明空闲、用户授权、浏览器或模型可用。

## 实际启用

在取得对应启动权限后，以同一 DSH_HOME、同一已核对 Host、Profile 及同顺序的原有 `--patch` 参数启动；最后追加：

```text
--patch <workflow-enable.patch.yml绝对路径>
```

启动先核对 Profile／home／所有 bundle patch／overlay 指纹、已安装载荷、共享模块物理身份、实际 CLI 和最终组合，并取得同一 writer；controller 可用后再审计真实声明及其子树。最终审计通过前不绑定工作流根，UI 等待已核验状态；失败封闭执行并按对应阶段释放 owner。HMR 拒绝发生在 Journal 打开前，后阶段审计失败则可能已初始化 runtime，不能笼统说所有失败都未打开数据库。启动失败应保留原始日志，不能绕过 guard 启用。

不要手工打开安装层或删除依赖校验。生成后修改配置、安装包或 Host 会使原方案失效；已有数据不得为了重新通过首次配置检查而清空，需要另行评审重配置／升级。

选择工作流预设后继续使用 DSH 原生输入框。空白会话沿用原生首页，不显示多余状态卡；已有运行可在原生“工作流”页签查看。该页只读展示，不是第二个聊天窗口。

## 停用与保留

确认没有活动 Agent、待退出进程和未处理写入后，按官方方式空闲关闭 Host；下次启动省略最后的启用 overlay，保留原有其他参数。生成器不自动停进程。

停用不删除 Journal、检查点、原生会话或配置输出，也不迁移已保存会话的预设。需要恢复时只能使用仍匹配的原方案；配置发生变化则先评审。RC.2 首次配置验收证明合成 Journal 启用／停用后字节不变；其后 RC.5 另补了[编号 RC 升级回退与停用后原生历史验收](../validation/2026-09-20-profile-transition.md)，仍不支持运行中热卸载。

实际范围与失败证据见 [本批验收](../validation/2026-09-20-profile-activation.md)。正式启用仍须满足 [Production v1 清单](production-v1-status.md)，不能由一条 check 成功代替生产准入。

## 旧 SDK 的历史差异

仅限 DSH `0.1.5-rc.1`／旧 RC.2、RC.5 基线：当时要求离线明确设置 `dsh.profile.patchReload: "startup"`，安装为 guard／UI／engine 三项默认停用。旧 `check` 依赖已由官方启动建立的 Profile module fallback，单纯 `--dump-config` 不会建立。上述行为不适用于 SDK2，也不是将 RC.12 装到旧 Host 的兼容承诺；历史验收及失败保持原版本范围。
