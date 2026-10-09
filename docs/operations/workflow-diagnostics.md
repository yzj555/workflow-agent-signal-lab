# 只读一致性检查与脱敏导出

适用：Production v1 候选的维护诊断。此工具不启动 Host，不调用模型，不批准门禁，不修复数据、不取消进程、不恢复文件。它不替代发布准入或进程退出证明。

## 输入与调用

在与目标 DSH 精确基线匹配的预构建插件目录运行。旧 RC.7 为 `0.1.5-rc.1`；新 RC.9／RC.11／RC.12 为 `0.2.0-rc.2`，已有安装采集、原生准入、实际跨版本维护及[主工程整合](../validation/2026-10-08-dsh-020-canonical.md)的限定证据；完整同版资源与生产接入尚待完成。不能只替换全局 CLI 后沿用旧包，也不能用主目录保留的旧 lib 诊断新 Profile。检查需要以下输入：

- `--snapshot`：既有备份流程生成的一致性 Journal 副本，不要直接指定正在运行的库。
- `--data`：显式指定的插件对象目录，包含 `text-artifacts` 和 `workspace-checkpoints`。
- `--native`：原生只读目录采集。可省略，但结果将明确标为未检查原生引用。
- `--workspace`：允许读取的工作区目录及其真实子目录，可重复；没有列出的工作区不读取，也不会从 Journal 自动扩大范围。路径中的符号链接／Junction 不跟随。
- `--output`：一个尚不存在的 JSON 文件，父目录须已存在，且不能位于上述输入目录中。
- `--private-map`：可选的新文件，保存匿名编号对应的本地会话标识／路径；这是私密信息，不随脱敏报告分享。

所有路径必须是绝对路径。示例路径须换成当前备份与目录，不能直接照抄启动服务：

```powershell
node scripts/diagnose-workflow.mjs `
  --snapshot C:/DSHBackups/checkpoint/journal.sqlite `
  --data C:/DSHProfile/workflow-runtime `
  --native C:/DSHBackups/native/tree.json `
  --workspace C:/Projects/example `
  --output C:/DSHReports/inspection.json
```

需要定位具体会话／文件时，另加 `--private-map C:/DSHPrivate/inspection-map.json`；该文件和原始备份都不应上传公开仓库。代码中的文件权限参数不能当成 Windows ACL 隔离保证。

### 安装包中的原生采集入口

候选包含 `scripts/capture-workflow-native.mjs` 和固定版本 WebSocket 依赖，不需要 DSH 开发目录或浏览器。入口根据安装包精确 peers 选择契约，但不据此认证在线 Host 版本。旧 SDK 读取 `session/list`、递归 `subagents/list` 和 control baseline；新 SDK 读取 `session/list`／`session/control`、递归 `session/projections.values.subagentCatalog`，并对可观察目标两轮读取非激活 projections 和非消费 `job/list`。新版没有旧 `subagents/list` Remote，不失败回落。官方登录兑换之外仅调用读接口；不读签名密钥、不提交 prompt、不取消 Agent、不修复数据。

输入是**稳定的私密启动日志副本**，含目标 Host 当次输出的 `dsh web: http://127.0.0.1:端口/?token=...` 行；启动链接不能放进命令行、公开报告或仓库。使用日志中最后一条启动链接，不自动尝试旧令牌。只接受 `127.0.0.1` 或 `[::1]` 的字面 loopback HTTP 地址；拒绝重定向、非本机地址和额外 URL 参数。不自动启动或重启目标服务。

```powershell
node scripts/capture-workflow-native.mjs `
  --startup-log C:/DSHPrivate/startup-copy.log `
  --output C:/DSHBackups/native/tree.json
```

两个路径须为绝对路径；输出父目录须已存在，目标文件必须不存在，符号链接／Junction 不跟随。启动日志若超过 1 MiB 或读取期间变化，会拒绝采集。基线以目标安装包的完整组件集合为准，不只看 CLI 名称／版本；当前 3080 的实际 Profile 和插件绑定尚未重新核对，新版隔离采集通过不意味着其已加载新版。

采集上限：5000 个列表会话、10000 条子目录项、15000 个驻留／观察目标，新版每 Session 最多 15000 个任务行；单响应和输出各 8 MiB、累计传输 256 MiB，单请求 15 秒、整次 120 秒。子会话可能同时出现在列表中，以官方目录边归类，不将重复可见当作新根或循环。重复父属、循环、缺字段、超限、认证失败和范围／水位／输入／任务变化均保留未完成，同数量替换也检查；不截断后声称成功。新 SDK 没有可用于 job 读取的 Session 时返回 `job-coverage-empty`，不猜测无归属任务为空。

退出码 `0`／`no-activity-observed` 仅表示本次有界采集未观察到活动；`2`／`needs-attention` 表示运行中根／子 Agent、待处理输入、活动 job 或未归类驻留；`3`／`incomplete` 表示采集不完整；`1` 表示参数／导出失败。新版 job/list 仅覆盖可观察 Session 所属和无归属任务，不能证明其他 owner 的任务不存在；running／stopping 与终态分别计数，终态不等于 OS 退出。**任何结果都不是全 Host 原子空闲证明，也不证明 OS 进程树退出、在线版本、全库健康、历史可读或允许重启。**采集中的身份、父子关系和活动计数仍属私密信息；不导出会话标题、消息、job 标签／详情、原始错误、认证 URL 或 Cookie。Windows 文件权限参数不等同于 ACL 隔离。

将采集 JSON 作为上方离线诊断的 `--native` 输入。离线报告检查一致性，不是空闲证明；其 `no-conflicts-observed` 不能覆盖采集中的活动或未完成状态。旧开发脚本 `check-dsh-tree-idle.mjs` 只保留为历史验证工具，不再作为安装入口。安装验收和失败记录见 [新版 RC.9 采集](../validation/2026-10-08-dsh-020-native-capture.md)及[旧基线采集](../validation/2026-10-08-native-capture.md)。

## 结果如何理解

| 结果／检查 | 含义与操作 |
| --- | --- |
| `no-conflicts-observed` | 在本次列明的检查范围内未发现冲突；不代表业务通过、全库健康或后台已退出 |
| `needs-attention` | 存在警告或明确不一致；先看具体检查项，不自动处置 |
| `incomplete` | 有输入缺失、过期、访问不获允许、读取失败或超限；不能作为通过证据 |
| `journal-row-invalid` | 当前解析器不能验证该行；保留原件，不能清空、重置或手工补写 |
| `native-child-binding-mismatch` | 原生父子目录关系与角色绑定不同，需检查对应记录和采集时间 |
| `native-child-unreadable`／`native-catalog-*` | 官方目录无法给出可读角色项；分类不是根因证明，不等同于仍在运行 |
| `role-exit-unverified`／`command-exit-unverified` | 原记录仍缺少退出证据；即使目录中 inactive／查无此项也保留未知 |
| `immutable-object-mismatch`／`immutable-missing` | 引用的内容对象或原始检查点摘要不符／缺失，可能影响恢复；保留现场 |
| `workspace-diverged` | 当前文件与某一历史运行的记录不同；可能是后续正常编辑或其他运行修改，不能直接判为损坏或覆盖恢复 |
| `workspace-not-authorized` | 本项根目录不在显式读取范围内；需先决定是否追加范围 |
| `rollback-unfinished` | 撤销事务未收尾；检查点可读不等于文件已撤销、已清理或批准可复用 |

每项同时有固定中文说明和匿名编号。退出码 `0` 表示所查范围未发现冲突；`2` 表示需要处理；`3` 表示未完成检查；`1` 表示调用／导出未完成。任何非零结果都不能被包装成“全部通过”。

### 原生目录可列出，不代表历史可读取

DSH 的目录读取可能只验证 header；`unavailable` 也不保证是临时错误。2026-09-20 已核实本机 24 项关联告警来自旧 `v0` 会话的 `descriptor v2` 不被当前 DSH 迁移器支持，见 [原因与影响核验](../validation/2026-09-20-native-history.md)。

升级验收必须另查原生正文的实际读取，不能仅依赖本工具的目录覆盖标记或插件 Journal 回放。受影响运行的旧 PASS／CANCELLED 保持为历史事实，同时保留原生对话不可读的告警；不能将文件改名、修改版本号、清掉目录项或沿用旧批准继续执行。若要恢复可读性，应先在副本验证专门迁移方案，不自动修改原件。

## 读写与隐私边界

- Journal 通过有界普通文件读取复制到新建临时目录，再在副本上开启 SQLite 只读事务。即使原备份带有空 WAL／SHM，也不在原目录打开 SQLite 或修改旁文件。非空 WAL／回滚日志必须先走一致性备份流程，不能忽略。
- 临时副本可能由 SQLite 产生自己的旁文件。结束后只删除本次创建的明确临时文件和空目录，不递归清理；清理未确认时单独告警，原始输入保持不动。
- Journal 协议／事件链使用插件的正式解析器；原生检查只覆盖已采集的目录身份、父子关系和活动观察，不宣称解码了所有原生历史日志或核验了 OS 进程树。
- 对象仅从显式对象目录按合法摘要定位。记录中的 locator 不跟随、也不认证其路径；工作区文件仅在显式允许的范围内检查。已完成撤销按 Journal 的实际顺序和 Windows 规范化路径键比较撤销前镜像。
- 只检查已引用对象，不扫描整个磁盘或删除“未引用文件”。当前限额为 1000 行 Journal、20000 项检查明细（另加超限提示）、256 MiB 累计读取预算、单对象／文件 16 MiB、原生采集 8 MiB；超限保留未检查结果，不截断后声称通过。
- 可分享报告采用字段白名单，不包含会话／run 原 ID、任务内容、文件正文、命令、原始错误、绝对路径和内容摘要。仍有检查类别及数量等元数据；分享前应人工审阅。私密对应表绝不能拼回公开报告。
- 原生采集、Journal 副本和文件检查不是跨系统原子快照。采集完成超过五分钟或存在失败会标为未完成；时间字段不证明当时或现在的进程存活。

此命令不更改任何工作流状态。修复、重新确认、取消、撤销、重启、升级或发布均仍遵循各自既定权限边界。
