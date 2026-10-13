# 原生桥接准备与接入

状态：安装准备脚本已通过独立隔离执行验收；2026-10-13 经用户授权正常重启后，真实桌面已加载包装器，worker 认证及原聊天实时轮次读取通过。本文不代表实际压缩、中止和自然额度恢复验收已完成。

## 准备阶段

`scripts/prepare-native-install.mjs` 只准备文件。它要求明确的桌面主程序、原 CLI、Node、release launcher、release broker、原配置文件路径，以及新的 D 盘目标目录。生成的启动脚本要求 PowerShell 7；额外应用参数通过 `-AppArgumentsJson` 传入 JSON 字符串数组，默认 `[]`。

桌面主程序须从当前运行进程取得，不能根据同一包里某个 exe 的名字猜测。CLI 路径也须来自当前后端进程。首次准备不修改注册表、系统环境、hook 信任、现有配置或任务历史，不启动桌面。

准备结果必须包含包装器、broker、Node runtime 模块、插件声明及对应资源、启动脚本和哈希清单。随机令牌单独保存并限制当前用户读取；不要把令牌或整个本机安装目录上传到公开仓库。源码包不携带运行令牌或用户配置。

已有配置文件只被引用，启动环境中的数据目录是它的父目录。不能通过创建一套默认配置替代用户的原开关和队列。准备脚本拒绝覆写已有目标；旧准备结果保留。

启动脚本只为新桌面进程设置 D 盘包内 `tmp` 目录作为 TEMP、TMP、TMPDIR，系统环境保持原值。

## Codex Legacy hook 兼容探针

Codex CLI `0.162.0-alpha.17.2` 的上游 loader 会解析 Agent Plugins 根 `plugin.json` 中的 `extensions.com.openai.hooks` 路径，但随后对所有 `AgentPlugin` 格式直接返回空 hook 列表。Codex 的 `.codex-plugin/plugin.json` 兼容格式仍会进入 hook loader。详见该版本的 [loader 分支](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/core-plugins/src/loader.rs#L896-L906)。因此本仓库保留可移植的根 `plugin.json`，并用下列脚本另外生成一个 Codex 专用 Legacy-only 探针包；生成包内没有根 `plugin.json`，版本和插件名从当前源文件校验，不覆盖源目录或已有安装：

```powershell
rtk proxy node "D:\dev\codex-quota-resume\scripts\prepare-legacy-plugin.mjs" --prepare-only
```

脚本默认使用随机唯一目录 `D:\dev\codex-quota-resume\.test-evidence\legacy-plugin-probe\<UUID>`；也可通过 `--target` 指定一个全新的 D 盘绝对路径。它会在目标根生成 `.agents/plugins/marketplace.json`，其 local source 指向同一新目标内的 `codex-quota-resume` 子目录；插件目录只包含 `.codex-plugin/plugin.json`、hooks、skills、运行脚本和文档，并在 `generation-manifest.json` 列出每个文件的版本和 SHA-256。此探针只供 standalone `plugin/read` 与 `hooks/list` 只读验收，不执行 hook、不信任 hook，也不安装进真实用户配置。真实安装或升级仍需由维护者另行协调并确认。

## 独立验收要求

### 2026-10-13 安装与信任更新

0.2.1 已按原插件 ID 安装 Codex 专用 Legacy 格式；实际 CLI 的 `hooks/list` 识别出两项插件定义。经用户明确授权，使用官方 `config/batchWrite` 对 `hooks.state` 保存这两项定义的当前可信哈希，并以配置版本防止覆盖并发改动。复读结果均为 trusted，其他四项用户 hooks 没有变化，任务配置哈希保持一致。此过程未执行 hook，也未发送聊天消息；真实自动登记及额度恢复验收等待下一次自然额度耗尽。

安装 CLI 意外清理旧版本缓存，随后已从旧版本源码快照补回旧目录；这不是旧缓存逐字节恢复的证明。任务数据位于独立目录，未受影响。当前机器不重复执行安装命令；以后升级须先核对安装器的旧文件保留行为。

0.2.1 worker 仅在认证 host 返回协议版本 2 时开放压缩适配器。当前桌面旧 host 未切换，压缩仍不可用；普通额度监测和恢复队列不依赖该压缩协议。没有把安装成功计为真实压缩成功。

1. 目标及真实父路径留在 D 盘，现有配置/历史文件未改。
2. 清单中的所有文件哈希匹配，插件声明引用的 hooks、skills 和脚本都存在。
3. 令牌 ACL 的实际回执受限，日志与标准输出不包含令牌。
4. 启动脚本在 PowerShell 7 中解析和执行，通过隔离 mock 应用验证参数与子进程环境。
5. 桌面仍运行时启动脚本拒绝接入，避免旧单实例进程接收请求却未加载 CLI override。
6. 真实启动前核对运行中的任务，协调正常退出桌面；不得批量杀桌面或 CLI 进程。

## 正式接入之后

只有完成准备验收并协调桌面重启后，才能执行生成的启动脚本。它仅给新桌面进程设置 CLI override 和桥接配置。接入后核对实际进程链为桌面 → launcher → broker → Node host → 原 CLI，后端仅一份，原聊天 ID 保持不变。

继续核对 hook 实际登记、worker 认证连接、原上下文用量、原生压缩完成事件及后续用量、原会话任务信息延续，以及列表停止当前轮次。合成后端的成功结果不能代替这些检查。压缩在真实后端是否启动新轮次、事件先后顺序，须以回执确认后修订协调器。

本次真实重启通过当前用户的独立接力程序等待正常退出，再运行已验收启动脚本；未强制终止桌面或后端。已核对桌面 → launcher → broker → Node host → 原 CLI 的实际进程链，另一个 exec-server 为启动器直通路径，不应计作第二个聊天后端。认证 snapshot 返回原聊天的 inProgress 轮次。旧 watcher 的运行文件留有过期 PID 和端口，停止请求连接被拒绝；随后通过保持原开关和 armedAt 的注册入口刷新连接并启动新 watcher，桌面工具连接恢复。此操作是显式配置刷新，不能当作 hook 自动加载的证据。

直接运行安装包内 ChatGPT.exe 的启动诊断报告 no-package-identity，更新器及框架识别可能受影响。当前聊天和工具通道已连通，但包身份与原入口兼容性仍需进一步处理。

最后进行自然五小时额度耗尽与恢复的完整观察。阈值仍从 60% 开始，恢复缓冲 120 秒；试运行 3～5 次后再依据效果调整，不自动改值。

## 回退

正常退出这次由脚本启动的桌面，再通过原入口启动，便不再使用此次子进程环境中的 override。保留安装目录、配置、队列和证据。回退无需删除文件，也不把旧记录清空。
