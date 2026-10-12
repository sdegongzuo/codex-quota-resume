# Codex 五小时额度恢复自动继续

## 重新设计文档

2026-10-12 已确认的新需求与开发计划：

- [需求要点与验收标准](docs/requirements.md)：默认启用、可控制的待续跑列表、60% 提前压缩、两分钟恢复缓冲和原会话串行续跑。
- [开发方案](docs/development-plan.md)：现有差距、接口能力验证、状态与模块设计、列表面板、开发顺序和实机验收。

上述文档描述待开发行为。下文仍是当前 0.1.0 的使用与实现说明。

Windows 本地插件 `codex-quota-resume`，版本 `0.1.0`。后台 Node 程序独立等待额度恢复，不需要模型在限额期间保持运行。

## 工作方式

1. 启用当前聊天，记录启用时间；信任 hooks 后自动登记后续提交的主聊天。
2. 每 30 秒检查一次。只处理启用后出现的结构化额度错误，并且必须同时观测到五小时窗口耗尽。
3. 根据服务返回的 `resetsAt` 等待，到重置时间加 5 秒之后重新检查。
4. 后台返回 `ordinaryUsageAllowed: true`，且原失败仍是最新轮次，才向原聊天发送续跑提示。一般在重置后 5–35 秒内发起检查，接口延迟会影响实际时间。
5. 已完成、手动中断或被新用户轮次替代的任务不自动继续。发送前再读一遍状态，缩小与用户操作的竞争窗口。

续跑提示要求继续原用户任务；任务完成或需要用户信息时停止。插件不消费重置券，不购买额度，不切换账号或模型。周额度或其他限制尚未解除时继续等待。

## 使用

需要 Codex Windows 桌面应用、本机桌面工具命名管道和 Node.js 22 及以上版本。安装在 D 盘。插件使用当前 Codex 安装的本地桌面工具通道，此通道属于版本相关接口；升级后先运行 `probe` 验证。

本机源码目录：`D:\dev\codex-quota-resume`。安装界面可通过本目录 `.agents\plugins\marketplace.json` 打开本地插件，也可在 PowerShell 执行：

```powershell
rtk proxy codex plugin marketplace add "D:\dev\codex-quota-resume" --json
rtk proxy codex plugin add "codex-quota-resume@local-quota-resume" --json
```

安装后，在 Codex 的 hooks 管理界面审查并信任插件声明的 `SessionStart` 和 `UserPromptSubmit`。安装本身不会自动信任 hooks，这是 Codex 内置的信任机制，不能绕过。

在目标 Codex 聊天中说“启用额度恢复自动继续”，使用 `quota-resume` 技能。也可由该聊天的 agent 执行：

```powershell
rtk proxy node "D:\dev\codex-quota-resume\scripts\control.mjs" probe
rtk proxy node "D:\dev\codex-quota-resume\scripts\control.mjs" enable
rtk proxy node "D:\dev\codex-quota-resume\scripts\control.mjs" status
```

`enable` 必须从 Codex 桌面聊天的执行环境调用，才能取得真实管道和聊天 ID；不能在独立外部终端凭空推测这些值。未信任 hooks 时，显式调用 `enable` 仍能监测当前聊天。已信任 hooks 后，后续主聊天自动登记；从未启用过的插件不会仅因安装就发送消息。

默认数据目录由 Codex 用户目录推导，源码版和安装版共用。本机实际解析为 `D:\CodexHome\.codex\plugins\data\codex-quota-resume`。可以用 `--data-dir` 或 `CODEX_QUOTA_RESUME_DATA` 指定其他 D 盘目录；不能写入 C 盘。

查看状态、关闭整个插件的自动继续：

```powershell
rtk proxy node "D:\dev\codex-quota-resume\scripts\control.mjs" status
rtk proxy node "D:\dev\codex-quota-resume\scripts\control.mjs" disable
```

`running: true` 表示实际连通后台互斥端口。关闭后不再发送，后台程序在当前检查结束后的下一轮自行退出，无需杀进程或删除文件。再次启用只处理新的额度失败，不追溯旧任务。

## 运行边界

- Codex 应用须运行。应用关闭期间后台只记录连接失败，不发送；重启后的 SessionStart hook 更新连接。未信任 hook 时需在聊天中再次运行 `enable`。
- 为避免向归档或无法确认的对象发送消息，目标必须出现在全部置顶聊天或最近 50 个非置顶聊天中。长时间等待的聊天建议置顶；待续跑对象离开此目录会取消等待。
- 后台许可未知、缺少重置时间、账号改变或接口不可用时不发送。只耗尽周额度的错误不会登记为五小时恢复任务。
- 发送前持久化占位，发送超时或崩溃时停止自动重发。`sending`、`uncertain` 状态需要检查原聊天是否收到提示，不能承诺绝对一次投递。
- 桌面工具没有提供失败轮次的原子比较并发送接口，因此二次状态检查后到实际发送之间仍存在很短的用户操作竞争窗口。
- 电脑休眠时程序不执行。醒来后补检查已经登记的失败；如果整个耗尽及恢复期间都没有运行监测，插件不猜测过去的额度状态。
- hooks 是否被真实桌面加载和信任，以及自然五小时额度耗尽、恢复后的真实续跑，尚未完成实测。

## 验证

2026-10-10，在本机 Codex `26.1002.7124.0` 对应环境验证：

- 19 项单测通过，覆盖额度恢复许可、重复发送防护、用户停止、新轮次、账号切换、管道分片和损坏追加记录恢复。
- 将“许可未知不得发送”故意改坏后，两项断言按预期失败；恢复正常实现后全部通过。
- 真实桌面接口读取成功：五小时窗口为 300 分钟，返回 `ordinaryUsageAllowed`；当前聊天轮次读取成功。
- 本机 Codex 的 `plugin/read` 已识别本地插件清单、版本和技能；当前插件未安装，hooks 尚未完成安装态验证。
- 独立后台程序完整通过模拟命名管道链路：等待、额度恢复、向同一测试聊天发送一次、持久化 `sent`、重复启动互斥和关闭后自行退出。

模拟额度与模拟聊天只证明程序链路；没有向真实用户聊天注入测试消息，也没有把模拟结果算作真实额度恢复验收。

执行测试：

```powershell
rtk proxy node --test "D:\dev\codex-quota-resume\tests\engine.test.mjs" "D:\dev\codex-quota-resume\tests\desktop.test.mjs" "D:\dev\codex-quota-resume\tests\store.test.mjs"
```

官方依据：[插件打包与 hooks 信任](https://developers.openai.com/plugins/build/plugins)、[hooks 行为](https://learn.chatgpt.com/docs/hooks)。生产实现入口为 `scripts/control.mjs`；`scripts/rpc.mjs` 只是 CLI 控制套接字探测，不在交付 ZIP 中，也不参与运行。
