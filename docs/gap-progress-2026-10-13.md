# 缺口补齐进度与证据

本页补充 2026-10-12 的验收记录，不把后来完成的工作计入早期验收。

## 已执行

- 安装缓存与当时源代码逐文件核对和同步，共 17 个文件；旧内容留存于 D 盘隔离备份。此后新增 observer 与路由器尚未再次同步，不能据此宣称安装态包含它们。
- 通过真实 Chrome 页面点击验收总开关、单项关闭、阈值保存、刷新后持久保留、人工核对请求，共 5 项通过；检查了截图。使用隔离数据，没有向真实会话发送或中断。
- 上下文 observer 初版与 engine、desktop、store、compaction 的相关测试共 36 项通过。但独立审查发现 timestamp-first 压缩标记、新轮次旧样本和缓存状态缺陷，因此仍在修复，暂不安装该初版。
- 新增原生协议路由核心 `scripts/native-router.mjs`。独立测试 4 项通过：相同请求 ID 的响应隔离、审批与通知原路转发、非法方法/目标拒绝、断连只报告一次未知结果。与现有压缩协调器一起运行 7 项测试通过。
- `git diff --check` 通过。源代码仍有未提交变更，这些结果不代表 GitHub 已包含新实现。

后续 Luna 修复了字段顺序、新轮次样本清理、缓存状态和多文件选择，主代理独立重跑完整仓库测试 42/42 通过。主代理继续审查发现：缺少 turnId 的 malformed usage 可能触发空 turn 异常，候选路径全部不可用时可能访问空选择。已交回修复，因此完整测试通过仍不足以批准安装 observer。

上述异常路径随后修复，主代理独立重跑全仓测试 45/45 通过（包含新增 stdio host 两项）。对当前原会话只读采样得到新鲜用量回执，未输出会话正文或身份字段。随后同步安装缓存 18 个明确文件，逐文件哈希一致；旧文件备份留在 D 盘。安全停止旧插件 watcher 并从安装缓存启动后，运行态确认当前目标样本可用、旧目标样本过期、开关保留、待续跑记录为零。该结果证明 observer 已进入实际运行链路，不证明真实压缩接口已接通。

原生 launcher 已有 Rust 源码和隔离 release 构建；Node stdio host 的模拟后端测试验证单后端、JSON 双向转发和退出码。桌面实际在 app-server 前传递全局 `-c` 参数，初版 launcher 未处理该顺序，已要求修复。包装器仍未设置为桌面 CLI，也没有执行真实会话操作。

新增 `scripts/native-events.mjs`，按当前 bundled CLI 生成 schema 的原生事件字段跟踪授权会话。同一 turn 的 terminal 状态才能确认停止；contextCompaction 完成后清除旧用量，等待新的单次 usage。模块不保留 item 正文，未知目标和其他 turn 的事件被忽略，已接入 stdio host；默认授权为空，尚未开放 IPC。主代理独立运行全仓测试 47/47 通过。

launcher 参数与退出码修复后，主代理独立运行 Rust 测试 5/5 通过，并核对隔离只读回执：按桌面实际 argv 经过 launcher、Node host、原 CLI 后，initialize 和 mcpServerStatus/list 都成功，退出码 0、无超时。状态返回 4 个 server，其 tools 字段是对象，按 key 统计 174 项（初次实现者按数组计数为零的结论已纠正）。测试没有创建聊天，也未更改桌面启动配置。

新增 `scripts/native-operations.mjs` 协调真实 RPC 的持久化占位和结果复核。请求接受而缺少完成及后续用量时进入 uncertain，恢复 sending 记录不自动重发；额度未许可或落盘失败不发送，旧 turn 不触发当前任务停止。它仍使用注入的桥接传输，未接生产 worker。实际压缩是否产生新 turn、完成事件与用量的关联顺序尚需真实接口验收，不能以当前模拟顺序当成证明。

新增 `scripts/native-service.mjs` 限制桥接命令为 snapshot、compact、interrupt，校验随机令牌与当前配置目标及准确 turn。压缩需要开关、额度和安全边界，异步额度检查后再次复核授权；手动 interrupt 不受自动续跑关闭影响。新增 `scripts/native-wire.mjs` 实现长度前缀 UTF8 JSON 帧、1MiB 上限、分片及合并处理，残缺或非法帧拒绝。主代理独立运行全仓测试 57/57 通过；这些模块尚未向生产开放 socket，Windows ACL 管道在开发中。

Desktop 支持显式注入已验证 native bridge，并生成绑定准确 thread/turn 的压缩 adapter；engine 仅在当前样本与原生 snapshot 的 turn 一致且安全边界成立时允许它。新增 adapter 回归两项通过。生产控制入口尚未传入 bridge，未验证桥接仍返回空 adapter。

任务列表新增 `/api/stop`，只在配置真实 onStop 时可用，默认返回 501；runningTurnId 不匹配返回 409。有效请求先持久关闭该 item 和 target 的自动续跑，再调用准确原会话/轮次停止。独立 HTTP 验收证明旧轮次不能调用、关闭选择先于操作保存、uncertain 不被显示为完成。页面按钮及实际 native onStop 尚待接通，不能将此接口验收解释为真实停止已可用。

主代理独立执行 Windows `pipe-acceptance`：实际创建受限 DACL 的管道，子进程连接后由操作系统取得 PID 并与预期匹配，UTF8 双向帧成功。实际读取 DACL 为 logon SID only，句柄不可继承；创建模式核对含 reject remote clients 与 first instance。此验收只证明本机正常路径及权限配置，不代表已实测远程客户端或另一个登录会话的拒绝效果。

新增 Node `native-channel` 只连接预建 Windows 管道，不以 Node 默认 DACL 创建 server；`native-client` 每连接发送一个带令牌命令，核对响应 ID，20 秒超时不会自动重试。独立模拟传输验证分片响应。全仓 Node 测试 61/61 通过、Rust launcher 测试 5/5 通过。Rust broker 仍需接好 host/worker 两条管道及生命周期，生产没有启用包装器。

随后 host 主入口接入 native channel/service，启动前校验 D 盘配置路径和令牌。host 仅开放内部 `account/rateLimits/read` 只读请求用于压缩前检查，未知窗口或任一窗口耗尽时拒绝压缩；worker 仍额外要求桌面 `ordinaryUsageAllowed` 为真。control 可从受信任 hook 环境登记桥接 descriptor，worker 认证连接后恢复原生操作记录，再注入 Desktop adapter。生产安装尚未包含这些新入口。

独立审查修复了原生操作并发请求在 await snapshot 前抢跑的问题：同一 requestId/目标/动作共享单一 Promise；不同身份复用 ID 拒绝。新增并发回归并重跑 Node 全仓测试 64/64 通过。broker 首次隔离运行挂起，实现者正在定位连接及退出流程；该运行未计作验收通过。

页面增加正在自动续跑任务的停止按钮，仅在启动面板时已认证 native bridge 可用才显示。control 将 onStop 接入同一原生操作协调器，未有桥接时保持 501。设置命令输出改为只包含阈值/调度设置，防止新登记的 bridge token 出现在标准输出。

新增 worker→framed client→service→router→原生事件状态的隔离端到端测试：身份认证成功，真实模块调用 compact，收到模拟完成与新 usage 后才确认 completed，同 requestId 第二次不再发 RPC。该测试通过，但后端事件是合成数据，不证明真实 CLI 压缩效果。

broker 实现者报告两个串行隔离 worker 请求已往返；主代理审查发现其 timeout 会杀 Node host，可能影响 renderer 后端任务，已要求改为只禁用 IPC 且保留 stdio/backend。此策略修复和生命周期回归未完成前不批准接入桌面启动器。

该超时策略随后修复。主代理独立运行真实 Rust broker + Node host/service/client/worker + 合成 backend：首次运行发现 worker 管道重建间隙导致下一请求连接失败，已修 NativeClient，仅在尚未 connect 且未发送任何帧时重试连接；发送后断连不重试。回归后完整隔离链路 5 项通过（认证、压缩/新usage、准确轮次停止、持久占位、自然退出）。

主代理独立执行 20 秒半帧超时用例，在收到管道实际关闭事件后再次通过 stdio echo，host 和 broker 自然退出 0。首次测试在 deadline 消息后立即退出，未观察到 pipe close，已修正观察顺序后重跑通过；没有把该第一次弱证据当作通过。主代理独立 Rust 测试 14/14、Node 全仓测试 66/66 通过。

实际 Chrome 页面重新点击验收 6 项通过，包含新停止按钮、准确合成轮次及先保存关闭选择；截图已独立检查。页面已按 bridge 能力调整提示文案。所有运行使用 D 盘隔离数据与合成后端，真实桌面仍未启用包装器；真实压缩通知顺序/turn关联、原会话信息延续、列表真实停止及自然额度恢复仍待验收。

安装准备方案仅在 D 盘新的明确目录生成代码、启动配置和令牌；准备时不写原 config/state，启动时引用明确传入的原配置及数据目录，保留已有开关、队列和历史。当前实际桌面主程序为安装包中的 ChatGPT.exe，不能按名字猜测以同包 Codex.exe 替代；正式启动路径须来自当前进程证据。脚本在开发与独立审查中，尚未启动桌面。

事件处理进一步前置过滤 notification method，正文流增量不会执行授权配置读取，也不会进入状态缓存。独立事件回归 3/3 通过。

安装准备独立复核发现并修复了 JS 模板中的反斜杠把 PS 路径变成换行/退格的问题；随后使用生成脚本真实启动隔离 mock exe，而非只做语法检查。最终准备结果 36 个清单文件哈希匹配（另有 manifest 文件），hooks/skills/README/docs 完整，参数原样保留，原配置哈希不变，实际 token ACL 为 protected、1 条当前用户 ACE、无其他 ACE；同路径已运行 mock 程序被拒绝；TEMP/TMP/TMPDIR 均为 D 盘包内目录。真实 Codex 未启动。

源代码按依赖顺序同步到既有 0.2.0 安装缓存，共 31 个文件哈希核对一致，旧内容留存 D 盘备份；插件 watcher 已安全停止再从安装缓存启动，确认 enabled/running/connection 正常，pending 为零。这只证明新代码已安装且原工具通道仍连通，不证明桌面加载了原生包装器。主代理独立 Node 全仓测试 67/67 通过。协调正常退出并由准备脚本启动桌面，是下一项外部步骤；未杀桌面进程、未改系统环境或 hook 信任。

下一轮核对桌面仍为原进程、没有 launcher/broker，配置未登记 native descriptor。补齐 native-channel 的 EOF 处理：异常关闭只通知一次，截断帧异常被隔离，主动正常关闭不误报。独立两项回归通过，Node 全仓 69/69、完整隔离 native stack 5 项通过。该补丁不改变桥接协议或先前生成的启动命令；真实桌面接入仍等待正常重启协调。

## 当前运行态

2026-10-13 用户授权正常重启验证后，独立接力程序等到原桌面正常退出，再执行已验收的启动脚本。实际进程链核对为桌面 → launcher → broker → Node host → 原 CLI；worker 认证成功，原聊天实时 snapshot 为 inProgress。另一条 exec-server 走 launcher 的原 CLI 直通路径。没有通过强制杀进程完成重启。

旧 watcher 的运行文件未随桌面退出自动失效，其旧端口停止请求返回 ECONNREFUSED。主代理通过保持既有开关和 armedAt 的注册入口刷新桌面连接及 native descriptor，再启动安装缓存中的新 watcher；确认总开关开启、连接 available、ordinaryUsageAllowed 为真、pending 为零。此处显式注册不能替代 hook 自动加载验收。

新任务列表服务已启动，并请求在原聊天的 Codex 浏览器面板打开。单项和总开关取消后续续跑；实际认证桥接可提供中止入口，但原聊天中止效果尚未操作验收。真实压缩完成事件、前后用量和信息延续仍未取得，不能因桥接接通而标记完成。

随后修正面板硬编码的旧能力提示：根据实际初始认证结果显示桥接及轮次元数据已接入，同时明确压缩/中止效果尚未验收。主代理重跑 Node 全仓测试 69/69 通过，diff 检查通过；同步安装缓存 31 文件哈希一致，变化文件旧内容留存 D 盘备份。实际认证面板 `/api/state` 返回 HTTP 200、nativeBridge authenticated、compaction connected_unverified、待续跑记录零、总开关开启。旧面板通过自身执行会话正常中断关闭，未中断桌面或聊天后端。本轮真实 native usage 为 58705/475000，约 12.36%，没有为测试强制发起压缩。

直接 exe 启动诊断出现 no-package-identity；更新器和框架身份识别兼容性仍待处理。已连通的聊天及工具通道不证明这些系统集成正常。

## 接入后的协议修复

当前实际 CLI 的 --version 为 0.162.0-alpha.17.2。对照该精确 tag 的上游实现发现两处旧模拟未覆盖的条件：[手动压缩任务](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/core/src/tasks/compact.rs) 会发送自己的 turn/started；[远端压缩](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/core/src/compact_remote_v2.rs) 在安装替换历史后先 recompute_token_usage，再发送 contextCompaction 的 item/completed。旧协调器要求同一 turn，旧事件缓存又在完成时清除 usage，可能把实际成功永远判成不确定。

新增经过认证的压缩预约及操作 ID，绑定原轮次、压缩新轮次和压缩 item。并发 frontend 输入、普通 item 或响应缺少操作关联时保留 uncertain，禁止重复请求；只有关联正确、压缩 item 完成、压缩轮次 completed 和新 usage 均具备才确认完成。事件仅留元数据，不缓存正文。其新轮次关联仍依赖同一个已包装的 renderer/backend 事件链；其他入口或跨客户端竞争的真实行为仍待验证。

当前真实桌面 read_thread 返回 active/activeFlags。修复等待审批或用户输入的识别，并在用户等待时保留自动续跑槽位，直到明确解除等待且轮次结束。面板允许仍占槽位、具备准确 runningTurnId 的用户等待任务请求停止；已离开槽位的旧等待记录不能据此中止其他轮次。

实现代理对主代理本轮 diff 作独立只读审查，指出缺失 operationId 的旧确认回退及等待类型的槽位释放边界；主代理随后修复并补回归。最终 Node 全仓 74/74、真实 Windows broker 加合成 backend 5 项通过。首次完整链路检查因增加操作 ID 持久记录，旧断言误把两条 sending 日志当成两次发送；改为核对不同 requestId 的持久占位后重跑通过。真实 Chrome 页面在 running 与 needs_user 两种合成场景各通过 6 项点击检查，截图已查看；这些结果不代表真实聊天中止。

安装包身份调查核对了当前 manifest、桌面 ASAR 的本地 CLI override 来源及 Microsoft 包激活接口。没有找到已证实可同时保留包身份并传入独立桥接环境的公开启动路径；未改包调试、注册表或系统环境。仍保持此项未完成，不能把只读调查写成修复。

独立启动原 CLI 的只读 hooks/list 返回 4 项用户来源 hook，未返回本插件的 hook；插件 CLI 清单则显示本插件已安装且开启。独立 server 结果不能证明桌面当前线程是否加载同一组选定插件，自动登记仍待真实桌面回执。没有更改 hook 信任。真实压缩和中止的专用验收聊天授权已请求，回复前不创建聊天或操作其他聊天。

本节原生协议补丁尚未加载到当前桌面 host；安装缓存和已运行 host 的身份必须分别核对，新包准备及真实操作验收仍是后续步骤。

## 实际漏登记与错误识别

用户指出一个实际额度中断聊天未自动续跑，并明确要求不要再次触发。只读核对确认：该聊天不在此前的 targets 中、待续跑列表无记录，实际最近轮次 failed，错误为官方额度耗尽提示但不含 codexErrorInfo。主代理保存该目标 enabled=false，再确认失败轮次未变化、没有任何 waiting/sending/sent 动作记录；该关闭选择后续不能由 hook 注册覆盖。没有向该聊天发消息或启动新轮次。

自动登记缺口的根因在该精确 CLI 版本 [插件 loader](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/core-plugins/src/loader.rs#L896-L906)：AgentPlugin 格式被直接赋予空 hook 列表，虽然其 manifest parser 已解析路径。新增 Codex 专用 Legacy-only 分发生成器，保留源码根 manifest 和旧安装文件，仅在全新的 D 盘目录生成兼容布局。主代理独立核对 31 个资源哈希，并用真实原 CLI 的只读 plugin/read 解析出 sessionStart 与 userPromptSubmit 两项 hook。候选尚未安装进真实用户配置，也未信任或执行 hook，不能据此宣称自动登记已经恢复。

错误识别另有缺口：原检测只接受 typed codexErrorInfo，会漏掉当前桌面的实际错误形状。隔离回放先证明不入队，再修为仅在 typed code 缺失时接受精确后端额度错误前缀；初次收集仍需官方 300 分钟窗口耗尽及服务端 resetAt。已知非额度错误、引用文字和仅周额度耗尽不收集，不从错误文案解析恢复时间。实现代理独立只读审查后补充目标/任务关闭的回归，最终全仓 77/77 通过。真实用户聊天未用于恢复发送测试。

任务列表和手动前台启动的 watcher 在新的用户输入到来后已退出，先前 URL 因此失效。主代理重新用独立后台子进程运行两项服务，随后核对两个实际 PID、监听端口、列表 HTTP 200 和认证 native snapshot。仅队列与面板边界修复已同步到当前 0.2.0 缓存并恢复运行；新压缩协议及 Legacy 自动登记仍待匹配安装升级。所有旧文件备份留在 D 盘，未更改系统环境或 Windows 包身份。

## 尚需完成

1. observer 已完成本轮修复、回归与安装运行态核对；仍需在真实压缩前后核对样本更新和过期处理。
2. 原生 exe 包装器、受限 IPC 与原聊天认证读取已接入；还需检查直接 exe 启动的安装包身份兼容性。
3. worker 接入真实压缩与列表停止，取得原后端完成事件和操作后状态。
4. 桌面正常启动接入已通过，原会话压缩及中止真实效果仍待验收。设计见 [原生桥接方案](native-bridge-plan.md)。
5. 自动登记 hook 的信任及实际加载验收，不能以手动 enable 代替。
6. 自然五小时额度耗尽和恢复完整观察 3～5 次，验证提前压缩、原会话续跑、串行、防重复及关闭选择。

这些缺口未通过之前，整体目标仍未完成。
