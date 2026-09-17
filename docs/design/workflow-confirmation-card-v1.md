# 确认卡信息合同 v1（四类原生状态变更确认）

状态：已实现并补充回归测试。进入实现前已完成只读核实，核实结果见本文第 2 节。

## 1. 目的与范围

四类原生状态变更确认必须让用户先看懂同一组信息，再作决定：

| 确认类型 | kind | 交付面 |
| --- | --- | --- |
| 需求理解（文本交付 / 分层工程第一道门禁） | `requirements` | `workflow_confirm` 的原生问题卡 |
| 执行授权（工程第二道门禁） | `execution` | 同上 |
| 规则停用／重叠清理 | `rule-cleanup` | `workflow_learning_revoke` 的原生问题卡 |
| 文件撤销 | `rollback` | `workflow_rollback` 的原生问题卡 |

本版不新增聊天窗口、不新增自定义确认 UI、不替换 DSH 官方确认组件；四类确认仍然只经 DSH 原生问答通道
（`intent.kind = "plan-review"`），批准仍必须来自原生回答本身，模型转述不构成授权。

## 2. 写入前的只读核实（本次实现的准入条件）

核实时间：2026-09-11（本次实现写入前，只读）。

1. npm 脚本存在且与冻结命令语义一致（`package.json`）：
   - `scripts.typecheck` = `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json`
   - `scripts.test` = `node --test tests/*.test.mjs`
   - `scripts.build` = `node node_modules/tsdown/dist/run.mjs --config tsdown.config.ts`
2. 冻结验收命令引用的三个测试文件均存在：`tests/workflow-learning.test.mjs`、`tests/workflow-controller.test.mjs`、`tests/workflow-project-controller.test.mjs`。（仓库另有 `tests/workflow-project-contract.test.mjs`，它不在冻结验收命令的文件清单内，`node --test tests/*.test.mjs` 仍会加载它。）
3. 四类确认点的原接入位置（写入前，各自零散拼装 `detail`）：
   - 需求理解与执行授权：`src/host/workflow-controller.ts` 的 `confirm()`（`mode = text | project-requirements | project-execution`）。
   - 规则停用／重叠清理：同文件 `revokeLearning()`，文案来自 `src/workflow-learning.ts` 的 `learningRevocationPresentation()`。
   - 文件撤销：同文件 `rollback()` 与 `rollbackEntries()`。
4. 硬编码命中点：`src/workflow-project-contract.ts` 的 `learningSummary()` 内嵌具体任务专属文案与匹配
   （PowerShell 5.1 / `.ps1` / UTF-8 BOM），是本版唯一命中的硬编码点，已按 AC-4 移除（见第 6 节）。

结论：合同可实现，且无需新增外部数据源；确认卡字段全部由 Host 当前结构化状态与 Journal 记录确定性推导。

## 3. 单一生成路径与四类适配器

新增 `src/workflow-confirmation-card.ts`，对外只暴露一个渲染入口：

```ts
renderConfirmationCard(draft: ConfirmationCardDraft): ConfirmationCard
```

四个 kind 各自只有一个薄适配器，全部落到同一渲染路径：

| 适配器 | 位置 | 输入来源 |
| --- | --- | --- |
| `projectRequirementConfirmationCard(state, workspaceRoot, revision)` | `src/workflow-project-contract.ts` | 当前 `projectContract` |
| `projectExecutionConfirmationCard(state, workspaceRoot, revision)` | `src/workflow-project-contract.ts` | 当前 `projectContract` + 当前 design |
| `textRequirementConfirmationCard(state, revision)` | `src/workflow-pilot-contract.ts` | 当前 `pilotContract` |
| `learningRevocationPresentation(target, activeRules)` → `.card` | `src/workflow-learning.ts` | 活动规则集合（含保留规则） |
| `rollbackConfirmationCard(source)` | `src/workflow-confirmation-card.ts` | 当前检查点文件变化 + 预览清单 |

与只读架构评估声明的 `buildConfirmationCard(state, workspaceRoot, kind)` 相比，实现改为「一个渲染器 + 四个显式
适配器」，原因是规则停用只能由跨运行的活动规则集合推导（单次 `WorkflowRunState` 不足以决定目标与保留规则），
且撤销卡需要已经算好的检查点预览；这两个输入无法从单个 run state 无歧义地重建。渲染器本身仍是唯一入口，
四类必填字段、校验与失败语义完全共用。

### 3.1 卡片结构

必填字段（四类完全一致，标签固定）：

| 字段 | 标签 | 含义 |
| --- | --- | --- |
| `whyNow` | 为什么需要决定 | 为什么此刻必须由用户决定 |
| `changes` | 确认后改变什么 | 批准后确定发生的变化（决策摘要） |
| `preserved` | 明确保持什么 | 明确保持不变的既有语义 |
| `impactAndNext` | 影响范围与后续动作 | 影响范围、冻结范围与后续流程 |
| `auditPointer` | 完整审计信息在哪里查看 | 与单次运行无关的固定稳定描述 |

除必填字段外，卡片携带：`headline`（唯一标题行）、`header`、`question`、`options`（第一个必须是批准选项）、
`approveLabel`、`extensions`（可选扩展字段）、`retained`（保留项快照）、
`binding = { revision, contractVersion, retainedSnapshotDigest }`。

首屏渲染顺序固定：唯一 `##` 标题行 → 为什么需要决定 → `> ` 决策摘要或变更块 → 明确保持什么 →
影响范围与后续动作（列表）→ 可选扩展字段（列表）→ 完整审计信息。该顺序由渲染器统一决定，四类不得各自拼装。

### 3.2 首屏与审计层分层

- 首屏（`headline` / `header` / `question` / `detail` / 选项标签与描述）只含决策摘要。
- `auditPointer` 是模块级固定常量（`CONFIRMATION_AUDIT_POINTERS`），与单次运行无关，只指向工作流记录与审计层；
  渲染器不接受适配器传入的审计指引。
- `runId`、`ruleId`、`ruleKey`、`evidenceId`、检查点标识、完整合同正文与证据正文一律不进首屏；它们只出现在
  Journal 事件、审计记录与只读工作流投影中。
- 记录文本与展示文本分离：需求快照里由 Host 注入的历史规则装饰（含 `ruleId@v<version>`）在持久记录与审计层保持
  原样，展示时经 `displayRecordedRuleText` 归一化为只保留作用域的形式；适配器同时把 `firstScreenIdentifiers(state)`
  交给生成器，使任何残留标识以失败关闭结束（见第 10 节）。
- 文件撤销卡按用户门禁要求展示恢复／删除清单（工作区相对路径），但不再展示检查点标识。

## 4. fail-closed 判定规则

### 4.1 必填项缺失、损坏或注入（`CONFIRMATION_CARD_INCOMPLETE`）

`renderConfirmationCard` 对每个必填项执行谓词校验，任一不通过即抛出 `ConfirmationCardError`，不生成卡片、
不打开门禁，也绝不回退为模型临场措辞：

1. 必须是由 Host 结构化状态生成的字符串（不是 `undefined`、不是非字符串）。
2. 去除首尾空白后非空（全空白视为缺失，而不只是存在性判定）。
3. 不含控制字符，不含不可见格式字符（`Cf`/`Cs`/`Co`）。
4. 不超长（单字段 600 字符；`impactAndNext` 最多 100 条，与 Host 检查点上限一致，不额外截断文件清单）。
5. 任何一行不得以 `#` 开头（防标题注入，保证首屏只有一行标题）。
6. 渲染后再做确定性后置校验：`detail` 必须恰好只有一行标题；五个字段标签必须都出现；首屏不得出现任何
   长度 ≥ 8 的运行／规则／证据标识（守卫输入由 `firstScreenIdentifiers(state)` 提供：运行 id、已生效规则的
   ruleId 与来源运行 id、以及需求快照记录文本中可确定性提取的规则标识；短于 8 的标识视为散文而不参与匹配）。

选项也必须非空（1–4 个）、标签唯一、`options[0]` 即 `approveLabel`；不可用时同样 fail closed。

### 4.2 可选扩展字段不影响必填判定

`extensions`（例如「本次允许的写入前缀」「本次需求目标」）单独校验：标签或值不合法时被静默丢弃，绝不因此
阻止卡片生成，也不参与必填项的 fail-closed 判定。

### 4.3 版本过期与保留项变化（`CONFIRMATION_CARD_STALE`）

- 每个卡片在生成时绑定 `(revision, contractVersion, retainedSnapshotDigest)`。
  - 运行级三类（`requirements` / `execution` / `rollback`）绑定门禁 `gate/requested` 提交后的 revision；
  - 规则级 `rule-cleanup` 绑定被停用规则的版本 `version`。
- 保留项快照由 Host 结构化状态确定性推导，覆盖四项既有语义：权限隔离与写入前缀声明（含 `requirement` 版本
  与边界条数）、门禁语义、Journal 兼容（事件协议版本）、原生输入方式。摘要为固定键序的 SHA-256。
- 决定落盘前重算：`assertConfirmationCardCurrent(card, { revision, retained })`
  - 合同版本不一致 → 拒绝；
  - revision／规则版本不一致 → 拒绝（授权不被采纳）；
  - 保留项摘要不一致 → 拒绝。
- 触发后 fail closed：确认路径取消等待中的门禁并抛错；规则停用还会重新核对被停用规则与卡片中显示的保留规则
  是否仍是同一版本，任一变化即要求重新发起确认。

## 5. 保留项与审计语义

- `preserved` 字段用固定措辞说明「权限隔离、门禁语义、Journal 兼容与原生输入方式均保持现状」，并按 kind 追加
  各自不授权／不改变的范围（范围外写入、未列命令、系统级操作、外部副作用等）。
- `auditPointer` 四类各一条固定文案：指向「工作流 → 完整计划」或工作流记录与审计层；需要修改时引导回原生对话
  （例如「去聊天里说」）。
- 审计层仍以 Journal 事件为唯一事实来源：`gate/requested` / `gate/decided` / `learning/revoked` / `rollback/applied`
  继续记录门禁 id、规则 id 与版本、检查点 id、`decisionAudit`；本版没有新增事件类型，也没有改写既有事件语义。

## 6. 硬编码防护

- `learningSummary()` 原先内嵌「PowerShell 5.1 / `.ps1` / UTF-8 BOM → 固定文案」的分支已移除；历史规则现在只展示
  规则自身在 Journal 中记录的 `statement`（运行期数据，不是源码常量）。
- 通用实现（`src/workflow-confirmation-card.ts`、`workflow-project-contract.ts`、`workflow-pilot-contract.ts`、
  `workflow-learning.ts`、`workflow-ui-contract.ts`、`host/workflow-controller.ts`）不再出现任何具体任务名称、
  规则内容或规则 id 常量；测试与文档中的样本规则只作为样本输入，不参与通用判定。
- 只读架构评估曾把该分支列为高风险（可能承载真实编码安全不变量）。移除后，`statement` 仍逐字展示规则自身内容，
  因此不丢失规则语义，只去掉了任务专属的替换文案；`preserved` 中保留的“受控副作用”提示仍由通用关键词判分生成。
- 回归保护：`tests/workflow-project-controller.test.mjs` 直接读取上述源文件，断言不含任务／规则专属常量，并断言
  四个适配器都调用同一个 `renderConfirmationCard`。

## 7. 回归测试落点

新增断言全部落在冻结验收命令引用的文件中（因此 `node --test tests/workflow-learning.test.mjs
tests/workflow-controller.test.mjs tests/workflow-project-controller.test.mjs` 会执行它们）：

- `tests/workflow-controller.test.mjs`：文本需求卡的五必填字段、固定审计指引、无 runId／ruleId，以及
  `renderConfirmationCard` 缺项／空值 fail closed、过期与保留项变化拒绝、保留项摘要随权限边界变化，
  以及本次返工的记录／首屏拆分与泄漏守卫（见第 10 节）。
- `tests/workflow-project-controller.test.mjs`：四类确认（需求理解、执行授权、规则停用、文件撤销）在同一测试内
  产出，逐类断言五字段齐全、顺序一致、只有一行标题、使用固定审计指引、首屏不含标识符；并断言通用实现无硬编码。
- `tests/workflow-learning.test.mjs`：规则停用卡的同一必填字段集、绑定规则版本、无 ruleId／ruleKey，以及版本与
  保留项变化时的 fail closed；另断言已生效历史规则进入第二轮需求卡时文字可见、规则标识只在持久记录里。

## 8. 工程检查顺序说明

冻结命令本身不得改写或替代。注意 `tsconfig` + `tsdown` 的构建产物 `lib/` 是测试入口：按仓库 README 记录的顺序
（`npm run typecheck` → `npm run build` → `npm test`）执行时，测试读到的才是当前源码构建出的插件；若先跑 `npm test`
再跑 `npm run build`，测试读到的是上一次构建产物，结论不能代表本次源码。该顺序属于既有约定，本版未改动任何脚本。

## 9. 回滚

- 本版只新增 `src/workflow-confirmation-card.ts`，并把四处零散拼装替换为适配器调用；删除的旧函数为
  `confirmationDetail`、`projectConfirmationDetail`、`projectRequirementConfirmationDetail`。
- 需要回退时按 Host 内容检查点恢复 `src`、`tests`、`docs/design`、`README.md` 中被改写的文件即可；
  第 6 节的硬编码清除可独立回退而不影响其余信息合同。
- 任一验证失败只在相同合同与写入范围内返工一次；再次失败、扩大范围或提高风险必须暂停并重新取得用户决定。

## 10. 返工记录：已生效历史规则的首屏标识泄漏（AC-2）

独立代码审查发现一条可达缺陷：Host 在把已生效历史规则折进需求快照时使用
`【已确认历史规则 ${ruleId}@v${version} · ${scope}】${statement}`（`WorkflowTextController.visibleLearningRule`），
该文本写入 `requirement` 的 `constraints`／`assumptions`；需求理解卡此前把这两项原样呈现到首屏，且适配器只把
`state.runId` 交给生成器，泄漏校验不可能发现 `ruleId`。持久记录必须保留规则标识（冻结行为断言
`requirement.data.constraints.some(item => item.includes(ruleId))`），因此修复必须在展示层与守卫层。

修复（记录／首屏拆分 + 守卫输入）：

1. `displayRecordedRuleText(value)`：把 Host 注入的规则装饰重写为保留作用域、丢弃标识与版本的展示形式
   （`【已确认历史规则 · 同类工作流】…`），只在生成器的显示路径上使用。应用位置：`summarizedItems`（项目需求卡的
   范围／约束／假设）、`materialExecutionNote`（执行卡的受控副作用提示）、`textRequirementConfirmationCard` 的
   列表与目标扩展字段。持久记录、Journal 与审计层完全不变。
2. `ruleIdentitiesInText(value)`：从记录文本中确定性地提取规则标识（含 `@v<version>` 归一化）。
3. `firstScreenIdentifiers(state, extra)`：把运行 id、`state.appliedLearning` 的规则 id 与来源运行 id、以及需求快照中
   记录的全部规则标识合成守卫输入；三类运行级适配器与文件撤销适配器全部改为传入它（不再是只传 `state.runId`）。
   因此只要记录里任何位置出现 Host 能证明的标识，首屏就会以 `CONFIRMATION_CARD_INCOMPLETE` 失败关闭，而不是静默泄漏。
4. 回归断言：`tests/workflow-learning.test.mjs` 在第二轮需求卡上断言规则文字仍可见、`ruleId` 与 `@v<数字>` 不出现、
   而持久记录仍带规则标识；`tests/workflow-controller.test.mjs` 断言展示重写与守卫提取的确定性，以及“带标识 → 失败关闭、
   经展示重写 → 正常出卡”。

残余边界：该守卫只能证明 Host 自己写入的标识。若任务文本里由模型自行写出某个字符串常量（既不是本运行的运行 id、
也不是已生效规则的 id 或快照装饰中的标识），Host 无从穷举，只能依靠装饰格式归一化与“已生效规则 id 全量入守卫”覆盖；
该边界与“首屏只呈现决策摘要”的其余部分一并记录在此，不声称能拦截任意未知字符串。
