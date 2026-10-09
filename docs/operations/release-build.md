# 可重复构建与隔离安装

适用基线：Windows x64、Node 26.1.0、pnpm 11.7.0、固定的 DSH 0.1.5-rc.1 组件集合。**构建候选不等于生产批准；默认停用安装不等于预设已能使用。** 当前状态见 [Production v1 清单](production-v1-status.md)。

2026-10-08：官方 0.2.0-rc.2 的 RC.12 已合回主工程；从主工程重新执行两次干净生产构建，各 588/588，220 个输入、43 个载荷及归档等于前序验收包。50 个测试文件，零失败／取消／跳过／todo。同包已有安装维护及三条工程运行证据，但完整同版资源与独立真实使用仍未完成。四项组合默认停用，启用政策不由安装替操作者决定。下列发行器可以从当前主源码复算 RC.12；它在仓库外安装依赖，不使用或覆盖主目录保留的旧 `lib`／开发链接。**主目录普通 build／typecheck 没有在旧依赖图上执行，不可将旧 lib 挂接生产 Profile。** 见 [主工程整合](../validation/2026-10-08-dsh-020-canonical.md)、[RC.12 维护](../validation/2026-10-08-dsh-020-maintenance.md)与[RC.11 原生准入](../validation/2026-10-08-dsh-020-installed-activation.md)。下方 fallback 及旧启动字段说明限于旧 SDK；新版使用公开进程内解析服务，不能调用已移除的旧修补 API。

## 构建候选

需要能读取 npm 上已锁定的依赖。无需 DSH 源码仓库、开发 Junction 或先构建本目录的 `lib`。源码包管理文件必须一起保留，不能只拿 `package.json` 重算依赖。

```powershell
# 在插件源码根目录执行；C:/work/evidence 必须已存在，输出子目录必须不存在。
pnpm run release:build --output C:/work/evidence/workflow-rc1 --version 1.0.0-rc.1
```

脚本会：

1. 将明确列出的源码、预设、测试、维护脚本和锁文件复制到仓库外的新临时目录，不读取机器上的 `cordis.patch.yml`、`.dsh`、凭据或既有构建。
2. 按 frozen lock 安装，禁止安装期脚本；确认直接依赖没有解析到临时目录外的开发链接。pnpm 自己的包存储链接正常保留。
3. 双端类型检查，以 `NODE_ENV=production` 构建并运行全量回归；依赖安装单独使用开发环境以取得编译工具。
4. 测试中的预设模块使用这次构建的普通文件副本，不通过祖先目录寻找开发插件。运行时真实的官方请求身份校验不放宽。
5. 只收集运行文件、预设、停用的组合层、资源候选、诊断入口、说明和第三方许可声明；不带源码图、测试目录、私有日志、数据库、锁或凭据。
6. 冻结输入及载荷摘要，再调用 pnpm 生成 `.tgz`。失败时不写通过回执，失败现场保留。

输出包括 `receipt.json`、各步骤日志、`package/` 和归档。回执记录独立临时源码目录，便于复查；这些本机证据不应直接上传。脚本不自动清理临时目录，不重建在线 `lib`，不启动／重启 DSH，也不执行发布。仅允许显式 `1.0.0-rc.N`，不能靠改参数冒充正式 1.0.0。

`pnpm-workspace.yaml` 固定官方源码基线 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` 的组件版本以及 Zod／React；`pnpm-lock.yaml` 固定实际依赖与完整性摘要。只固定 CLI 的版本号不够：官方 npm 包的范围依赖可能解析到更新的子包。这些固定值用于本工程和隔离验收，**不得复制到用户 Profile 后未经评估地覆盖其他插件依赖**。

## 包与 Host 的边界

私有 SQLite 后端随 Node 构建嵌入，来源仍是固定版本官方包；它只服务本插件的独立 Storage Context。共享 Agent、LLM、Session 和 Cordis 等仍为外部 Host 服务，不把它们再包进插件。共享 peers 在产物中标记为 optional，以便由 DSH 官方 Profile module fallback 提供，不能因此跳过启用前的存在性、版本及物理模块身份核对。

尤其是 LLM 的官方请求登记使用对象身份；同版本号的第二份模块也可能不兼容。浏览器的 React／原生共享 UI 则需在实际 Web 渲染器中验收，不能用 Host 的 Node 导入检查替代。

## 安装演练与正式启用

官方提供 `dsh plugin --profile <name> add <absolute-tgz>`、`remove <package>` 和 `--dump-config`。安装后的层默认停用，不复制配置／凭据、不更改默认 Agent，不修改旧运行额度或迁移历史。遵循 [固定版本官方安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/docs/user/develop/basic/publish.md)。

隔离演练必须使用仓库外的独立 DSH_HOME、版本锁定的官方 Host 和已核对摘要的归档；不能因源码目录的祖先存在 `node_modules` 而误用开发包。配置 dump 不启动 Host，亦不执行真正启动时的 module fallback；该官方步骤需单独核对，不能以“dump 成功”宣称运行接入成功。

RC.1 演练覆盖停用态安装、官方 fallback、已装文件摘要、Host 模块身份、写入测试 Journal 后关闭／冷开、移除／重装保留记录。其后 RC.2 增加首次 Profile 配置生成、启动 guard，以及真实 Web 启用和空闲停用；两个独立生产构建各 483/483、归档一致。安装层现有 guard／UI／engine 三项，仍全部默认停用。

首次启用操作见 [Profile 配置与启停](workflow-profile-activation.md)，证据见 [首次 Web 验收](../validation/2026-09-20-profile-activation.md)。该流程要求显式 startup 重载策略，保留默认 Agent、自定义 roots 及其他配置，拒绝已有非空数据的首次配置。

最新 RC.5 两次独立生产构建各 500/500，208 个输入、40 个载荷和归档一致；安装包新增离线检查点、已有数据重配置和编号 RC 升级／回退入口。真实隔离 Web 已核对保留升级后新记录的代码回退、配置复核、启动漂移拒绝和空闲停用；RC.6 仅为同源版本演练包。见 [维护流程](workflow-profile-transition.md)及[验收边界](../validation/2026-09-20-profile-transition.md)。**正式 1.0.0、活跃实例停用、旧原生历史处置及独立模型任务仍未验收**；不要在正在运行的 Profile 上试装。

发布还需要：最终 A–E 准入、版本清单及授权。当前产物为 `private: true`／`UNLICENSED` 候选，未替项目所有者选择开源许可证，也没有自动提交、推送、发 Release 或发布 npm。
