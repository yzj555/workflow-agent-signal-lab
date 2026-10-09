# DSH 0.2 安装后准入、原生 Web 与重配置核验

后续增量：新版实际升级、保留新增数据的兼容回退与卸载重装已在 RC.12 演练，见 [维护验收](2026-10-08-dsh-020-maintenance.md)。下文保留 RC.11 当时的证据与限制，不把后续结果改写成前序包的验收。

结论：**RC.11 同归档的隔离安装、两阶段准入、原生工作流视图、停用历史回放、HMR 漂移拒绝和已有数据同版本重配置通过。** 两次干净生产构建各 582/582，归档一致。这不是生产 Profile 接入或 Production v1 批准；新版跨版本升级／回退、完整主工程整合和独立真实使用仍未完成。

用户选择的正式方案保持为独立生产 Profile、完整保留实验 Profile 和旧档案。本批只使用新建合成 Home、动态 loopback 端口和受控夹具；没有创建生产 Profile、操作 3080、迁移历史、调用真实模型、批准任务门禁或对外发布。

## 实际安装发现的问题及修正

固定 Windows x64、Node 26.1.0、pnpm 11.7.0、官方 CLI／完整 SDK `0.2.0-rc.2`；官方源码为 `639ed015397290b3745d163aafe02ffee4aa3f84`。RC.9 的安装采集结果仍成立，但其 Workflow Agent 启用并未验证，不能继续推断配置工具也适用新版。

1. 新版 Profile 不再提供 `patchReload`；往 manifest 写入旧 `startup` 字段不会冻结配置。候选改为核对官方组合中所有 HMR 行均显式停用，并在实际 Host 上再次确认没有 HMR 服务；存在、表达式未定或缺失策略时拒绝，不替操作者改变策略。停用 HMR 同时影响该 Profile 的配置与代码重载，设置变更需重启，不能描述为只影响工作流。[官方 Profile](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/src/profile.ts)、[官方 HMR](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/hmr/src/index.ts)
2. 新组合层使用 `patchPaths` 数组，而非单个 `patchPath`；全部输入纳入指纹。新版不再使用旧文件系统 fallback，离线检查／维护通过公开 `createRuntimeResolution` 与 `PluginPackages` 在自己的 Context 中建立作用域，完成或异常后以 `ctx.fiber.dispose()` 撤销；实际 Host 仍核对已经安装的官方服务及物理模块身份，不补开发链接、不绕版本检查。[公开解析服务](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/src/profile-resolution/service.ts)
3. 新版 Session 目录只管目录，已无 `current`。原生客户端包虽已加载，却未挂载工作流页签。现从公开 `uiSession.adapter.current` 读取主视图绑定，同时监听目录及绑定变化；缺失、非本预设、切换或卸载撤下页签。待确认状态改用 `useSessionStatus`，子 Agent 发现改用投影目录；采用公开 hook 类型和明确 Client transport face，不再用 `ctx: any` 隐藏这些接口差异。[Session UI 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-session/src/client/index.ts)、[官方目录类型](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/api/session-controller/src/client/sessions/service.ts)

SDK2 离线解析身份与正常／异常清理采用实际公开服务回归；目录／绑定切换与双订阅释放增加回归。真实安装和浏览器证据另列，不将替身测试当作真实使用。

## 最终发行与实际安装

完整源码冻结后，在两个不同仓库外目录按 frozen lock 重新安装、禁止安装期脚本，分别完成双端类型检查、production 构建、50 个文件的全量测试和打包。

| 核对项 | 结果 |
| --- | --- |
| 两次全量 | 各 582/582；失败、取消、跳过、todo 均为 0 |
| 输入与载荷 | 220 个输入、43 个载荷及归档完全一致 |
| 实际解包 | 列表符合载荷清单；全文件摘要一致 |
| 实际安装 | 官方 CLI 从同一 `.tgz` 安装至新 Home；全部安装载荷摘要一致 |
| 初始状态 | 四项组合默认停用；没有自动选默认 Agent 或打开工作流 |
| 启用政策 | 仅在受控合成 Profile 显式关闭 HMR；不修改生产或实验 Profile |
| 启动准入 | 身份／owner 核对及 controller 后预设子树审计通过，ready／verified 均成立；工作流预设健康且非默认 |

RC.11 SHA-256：

```text
cac22bbdc314508aa52ec489d657dacb7bdb56193e0a9148ca04149672849c38
```

## 原生 Web、拒绝及维护

夹具只产生一条合成 Journal／一个 run，另写入无模型的原生合成会话。工作流停在未批准的需求门禁，未调用模型或执行任务。浏览器在安装后的实际官方 Web 上打开历史，不是自制对话窗口或静态预览。

| 场景 | 实际结果 |
| --- | --- |
| 已启用并选择工作流历史 | 客户端确已加载，原生“工作流”页签和持久记录 revision 6 可见；顶部状态和阶段说明显示 |
| 停用后打开同一原生历史 | 工作流包／页签不加载，原生对话仍可打开；不删除 Journal 或替换已保存预设 |
| HMR 策略漂移 | 工作流准入被拒绝，ready／verified／Journal 均未提供，预设不可用；未观察到 writer，数据字节未变，测试恢复原配置全部字节 |
| 已有记录离线 capture | 实际安装脚本持有正常 CAS owner 完成复制与回放，1 行／1 run；不回收旧 owner、不改原数据、不升级 |
| 同版本 reconfigure 后启动 | 新维护计划通过启动检查及同 owner 移交；回执为 `compatibility-accepted-not-task-authorized`，原生页签和原记录可见 |

三个浏览器场景各只有一个原生输入框、无水平溢出、零页面异常；受控 Host 均正常退出，未强停。需求／审批／发送等变更入口由探针拒绝；首次原生设置提示只在无凭据测试 Home 完成，并在生成准入方案之前完成偏好写入，不复制或配置密钥。

**数据证据必须区分：**已启用 Host 的正常 SQLite 关闭／检查点落盘会改变文件字节，因此两次启用后的“字节不变”均为 false；完整记录摘要、schema、回放快照和 run 状态前后相同。浏览器读取期间文件摘要未变，停用态前后文件字节也相同。不把 SQLite 物理变化说成历史事件变化，也不把语义一致冒充字节一致。HMR 拒绝证明工作流未准入，不宣称新版必须杀掉整个原生 Host；测试夹具在核对拒绝后自行正常退出。

## 保留的失败与未完成项

- RC.9 首次实际启用被旧重载策略检查拒绝。RC.10 中间方案清理使用旧 Context API，被实际安装检查拒绝；修正后的双轮 579/579 仍未解决原生页签缺失，不能作为最终 UI 验收包。
- 开发期间修改了正在构建的输入，发行器正确拒绝该构建，未以其绿测试发行。后续采用冻结副本。
- 原生欢迎偏好写入使旧方案指纹过期，启动保护正确拒绝；测试改为先完成合成环境首次设置再冻结方案，没有放宽配置指纹。
- 漂移夹具误认 JSON／YAML，以及误把工作流拒绝等同整个 Host 必须退出 1；浏览器夹具未等待延迟密钥提示，均保留为失败，未混入通过清单。

本批不覆盖新版跨版本升级和保留新增数据的代码回退，也未用同 RC.11 重跑全部运行／资源时长场景或独立外部模型任务。真实角色隔离、资源和恢复的既有证据按原版本保留，不能从旧 SDK 外推。未完成的新 SDK 整合不覆盖在线 `lib`；正式 Profile 创建与切换、独立参与者／真实任务及许可发布决定须各自取得相应范围。

本机证据：`.dsh/activation/dsh-020-install-source-20261008-v6`、`dsh-020-install-20261008-rc11-v1`／`v2`、`dsh-020-install-20261008/prepared-v7`、`web-enabled-v5`、`web-disabled-v1`、`drift-v3`、`maintenance-capture-v1`、`maintenance-plan-v1`、`web-reconfigure-v1` 和 `final-v1`。主工程 src／tests／scripts／preset／lib、package、锁与本批起点一致；RC.9 原归档摘要相同，官方源码工作树干净。没有读取或改写旧实验数据库来制造本批成功，也不重新宣称旧 I/O 根因已明。

最新整体状态见 [Production v1 清单](../operations/production-v1-status.md)；[RC.9 安装采集](2026-10-08-dsh-020-native-capture.md) 与旧维护验收均作为各自限定的历史证据保留。
