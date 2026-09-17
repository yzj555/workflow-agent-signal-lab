# Workflow Host 接入核验

日期：2026-09-03。状态：用户已确认 A 路线（不改核心、插件独立日志）；独立 Journal、冷恢复和只读传输已落地。原生自定义 Session 事件路径仍不可用，没有绕过官方守卫。受控 Agent 执行尚未接入。

## 1. 核验范围

- 当前全局 `dsh` 的 Junction 指向 `F:\dsh\deepseek-harness\apps\cli`，包版本为 `0.1.1-rc.2`。
- 官方源码 HEAD：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`；核验时该源码工作树干净。
- 探测调用该源码目录现有构建产物的真实 Session、JSONL、SQLite 与 Session Projection 实现，不是模拟持久化后端。
- 原生事件兼容探测只创建临时数据；后续集成启动官方 3080，并打开已有实验会话检查 UI。未向现有业务会话发送消息、追加工作流记录、读取凭据内容或修改 DSH 核心，未启动业务模型执行。

## 2. 可复现探测

在实验工作区运行：

```powershell
node scripts/probe-session-event-compat.mjs F:\dsh\deepseek-harness
```

脚本使用已构建的实验协议 `lib/index.js`，校验有效的 v1 `run/created` 数据；分别创建原生 `todo/write` 基线会话和自定义 `workflow/event` 会话，执行 append、flush、销毁上下文、用新上下文冷恢复。

| 检查 | JSONL | SQLite |
|---|---|---|
| 原生事件冷恢复基线 | 通过 | 通过 |
| 自定义事件 append | 通过 | 通过 |
| 自定义事件 flush | 通过 | 通过 |
| 事件不进入模型对话表面 | 通过 | 通过 |
| 自定义事件冷恢复 | **拒绝** | **拒绝** |

两者均抛出 `SessionFormatUnsupportedError`：`workflow/event` 不在已知类型集合中，且不是可忽略事件。探测输出 `status: BLOCKED` 并以非零状态退出；这不是通过了持久化集成验收。

该探测的临时证据保留在 `C:\Users\Administrator\AppData\Local\Temp\workflow-session-compat-kzPAMN`。当时第一切片及既有守卫为 20/20；独立路径完成后完整回归为 51/51。原生事件探测依然是 BLOCKED，不能把独立路径的通过记到原生路径上。

## 3. 原方案的两处错误假设

### A. 类型声明不等于持久化事件注册

官方说明明确写明：当前版本的已知事件清单由仓库内声明生成，仓库外插件的运行时注册接口尚未交付；未知类型允许写入，但第一方读取器会拒绝恢复。`Session.append` 也尚未提供写入 `ignorable` 的接口。

依据：

- [官方会话格式说明](F:/dsh/deepseek-harness/.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md:23)
- [生成清单及仓库外限制](F:/dsh/deepseek-harness/packages/core/session/src/known-event-types.ts:9)
- [两个后端共用的读取守卫](F:/dsh/deepseek-harness/packages/session/session-persistence/src/coordinator.ts:1061)

实验工作区早期 Contract 接入计划把“注册 log-only SessionEvent”列为直接可实现的下一步，未核对冷恢复能力，这个判断不成立。不能修改导出的已知类型集合、冒用其他事件或将关键授权状态视作可忽略数据来绕过该限制。

### B. append 后 flush 不会自动延迟官方投影

`Session.append` 同步通知观察者；官方注册表直接监听 `session/event`，因此可能在调用者等待 flush 前更新并发布 view。探测确认其观察回调在任何 flush 调用之前已经发生。这里的内存日志提交不能等同于磁盘持久化成功。

此外，官方投影约定携带状态的事件包含变更后的全量值；当前协议是领域增量事件，仍需显式适配，不能只注册现有 reducer 就宣告符合官方契约。

依据：[同步 append](F:/dsh/deepseek-harness/packages/core/session/src/index.ts:569)、[投影监听点](F:/dsh/deepseek-harness/packages/session/session-projection/src/index.ts:188)、[全量值及同步计算规则](F:/dsh/deepseek-harness/packages/session/session-projection/README.zh.md:24)。

## 4. 路线决定与接口实测

| 路线 | 保留什么 | 代价与边界 |
|---|---|---|
| A：纯插件独立日志（用户已选，已实施本层） | 不改 DSH 核心；继续用原生输入框和插件只读可视化 | 工作流事实由插件存储负责，以 Session ID 关联；原生会话导出或 fork 不会自动携带插件状态 |
| B：补充 DSH 正式扩展能力（未选、未实施） | 将根 Session 日志作为工作流事实源 | 需要额外授权修改核心，并承担读取兼容、插件缺席、投影提交边界与升级维护 |

A 使用官方 `storageDomain` + `storage-sqlite`，在插件私有 Cordis Context 中组合，不改变主 Host 的全局存储路由。领域写入先持久化，再更新内存；官方没有跨表事务或跨 Host 保护。本实现因此把同一根 Session 的全部事件放在一行 KV 中，并自行提供原子创建 owner 标记、串行提交、revision 比较、全批校验和故障冻结。

客户端早期尝试 Typert 只读 Remote，但当前外部插件构建方式不能直接完成符号发现：生成器只收集 `root/packages` 下的项目注册，`Remote` 等标记还要求识别到注册的 protocol 包或声明模块。外部依赖声明在该组合中未被识别，生成报错。没有手写伪描述符、修改生成器或改核心来绕过它。这是本次外部构建路径的限制，不等于 DSH 不支持外部只读插件。

实际选择官方通用 Connection 扩展：Host 使用 `ctx.connection.rpc.handle('/workflow-runtime', ..., { authority: 'loopback' })`，Client 使用现有 `ctx.connection.rpc.call`。只开放 `snapshot`，请求与响应共用严格 Zod schema；没有写端点，没有独立 Web Server。

传输采用按根 Session 合并的短轮询：有运行记录时 2 秒，空记录/读取失败时 5 秒；同一会话的多个组件共享单个进行中请求。连接 generation 变化会清空已显示的状态并取消旧请求。它不是架构基线中的长轮询/change journal，也没有声称获得自定义推送。官方浏览器下行载体是 WebSocket，不是 SSE。

依据：[Storage Domain](F:/dsh/deepseek-harness/packages/storage/storage-domain/README.zh.md:5)、[SQLite 原子写入及限制](F:/dsh/deepseek-harness/packages/storage/storage-sqlite/README.zh.md:11)、[Connection 与 generation](F:/dsh/deepseek-harness/packages/client/connection/README.zh.md:5)、[官方通道注册](F:/dsh/deepseek-harness/packages/client/connection/src/rpc-host.ts:107)、[Typert 注册发现](F:/dsh/deepseek-harness/packages/typert/generator/src/analyzer.ts:455)、[Typert 符号识别](F:/dsh/deepseek-harness/packages/typert/generator/src/analyzer.ts:1805)。

## 5. Journal 切片交付与当时的剩余边界

- 51 项测试通过，包括新 Node 进程冷恢复、两个进程竞争写入者、真实 SQLite 写入失败、官方 HTTP RPC、跨站/伪造 Host 拒绝、客户端断线和迟到响应。
- 已在官方 3080 页面只读打开“第三轮可回滚Crew回归测试”，验证插件加载一次、一个原生输入框、没有插件聊天输入、没有页面异常。证据在实验目录 `.dsh/evidence/slice2-web-session`。
- 旧原生会话没有新 Journal 时显示“尚未建立运行”；保留原生 Agent 观察，但不据此推断门禁。新日志中的 Agent `running` 也只能称为“运行记录”，不能冒充已完成重启存活核对。
- 无法读取权威记录时不能凭聊天文本恢复批准；崩溃 owner 不自动替换。删除、备份、fork 与插件缺席边界详见 [Journal v1](workflow-journal-v1.md)。
- 这些是实验工作区“第二切片”的存储/读取成果，不等于架构基线 10.7 所称“切片 2”的串行实现、验证返回和性能准入已完成。
- 下一步是受信 Controller 与原生输入桥接、受控派发/续接/报告。当前还不能阻止旧 Crew 工具绕开新 Journal，也没有实现 QA 工具权限强隔离。

## 6. 后续实现注（2026-09-03）

受控文本闭环现已实现，并在官方 Loader、AgentPresets、AgentLoop、Tools、Subagents 和 persistence 上用脚本化模型通过端到端测试。新增预设不继承 Crew 工具；子 Agent 在 unpublished setup 中完成工具限制、完整系统段和动态上下文隔离。原生问题必须由实际 questions provider 回答，模型不可自称 user。

本版使用 `childCtx.agent` 读取官方 Agent 关联，它是 Context 自有属性，不是 `ctx.get('agent')` 服务。角色报告落盘后使用 `ToolRunContext.concludeTurn()`，而非臆造 Agent 的同名方法。官方原生结束通知早于插件 Journal 提交，因此另外发送已持久化的控制层通知。

**在线接入更新（2026-09-03）**：首次热切换／重启受阻并回退后，用户明确要求代为重启；本次已核验空闲旧实例并重启官方 3080，新版引擎与预设完成原生空白会话挂载检查，只读界面回归通过。没有改核心、删除历史或提交模型任务。原生挂载与页面回归的证据范围不同，不据此宣称真实用户闭环通过。实现、72 项历史测试及本次部署证据见 [原生受控文本闭环 v1](workflow-native-text-pilot-v1.md)。

官方依据：[用户问答](F:/dsh/deepseek-harness/packages/interaction/user-questions/src/index.ts)、[工具最终守卫与 concludeTurn](F:/dsh/deepseek-harness/packages/core/tools/src/index.ts)、[子 Agent 的 unpublished setup](F:/dsh/deepseek-harness/packages/subagent/subagent/src/activation-setup-registry.ts)、[完整提示词和动态上下文约束](F:/dsh/deepseek-harness/packages/core/system-prompt/README.zh.md)、[预设作用域与生命周期](F:/dsh/deepseek-harness/packages/preset/agent-presets/README.zh.md)。

## 7. 真实试用后的接口补充（2026-09-03）

真实演示通知已完成原生问答门禁批准、内容生成与 10 条独立验收，详见 [文本试用记录 7.4–7.5](workflow-native-text-pilot-v1.md)。门禁记录证明通过用户权限通道，不证明物理操作者身份。本次复核修正了三个不能仅凭先前 API 名称推断的边界：

- `tools.restrict()` 明确只过滤继承工具，子作用域随后注册的 `report` 仍会显示；使用官方最终 `system-prompt/assemble` 精确作用域投影过滤模型 schema，执行拒绝继续由单调守卫承担。
- `AgentRegistry.roots()` 描述运行时所有权，continuable 子 Agent 也可能在其中；协调者判定还必须排除持久子来源／委派深度，不把冷恢复子角色当根角色。
- 原生空白会话选择预设通过 `recompose` 重连作用域，保留同一个 Agent，并在提交 `agent-preset/selected` 后通知；插件必须处理切入绑定与切出清理，不能只监听首次创建。

官方源码依据：[工具限制与守卫](F:/dsh/deepseek-harness/packages/core/tools/src/index.ts:1064)、[提示词组装](F:/dsh/deepseek-harness/packages/core/system-prompt/src/index.ts:466)、[运行时根节点](F:/dsh/deepseek-harness/packages/core/agent/src/index.ts:607)、[子 Agent 的持久来源](F:/dsh/deepseek-harness/packages/subagent/subagent/src/child-agent.ts:102)、[原生预设切换](F:/dsh/deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:2984)。Crew 两个贡献名另外核对当前安装 v0.10.0 的 `host/crew.js`；没有宣称其他版本也使用相同名称。

独立插件修正已通过 84 项自动测试，真实完成页面显示也通过。随后用户授权重启，18:35 在相同官方 3080／默认 Profile 上启动新 PID 36488；新 owner、日志回读、内容摘要与真实页面检查正常，详见 [部署记录 7.6](workflow-native-text-pilot-v1.md)。没有再次提交模型任务；部署回读不是新一轮模型验收。DSH 核心、原生会话与历史数据未修改。
