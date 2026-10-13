# 当前桌面能力验证

日期：2026-10-12。验证用于当前 Windows Codex 桌面和本仓库实现；不代表其他版本。

## 只读接口结果

| 能力 | 结果 | 证据与处理 |
| --- | --- | --- |
| 工具目录 | 已读取 | 当前桌面有 `get_usage_limits`、`read_thread`、`list_threads`、`send_message_to_thread` 等工具。 |
| 五小时额度 | 可读 | 当前回执含 `ordinaryUsageAllowed`、`accountId` 和 300 分钟窗口；恢复仅以服务返回许可为准。 |
| 会话轮次 | 可读 | `read_thread` 返回 thread 标题/状态及最新 turn 的 id、status、error、时间和 items。 |
| 活动上下文占用 | 不支持 | `read_thread` 没有活动 token、实际上下文窗口或计量更新时间。累计用量不能代替该数值。 |
| 真实压缩 | 不支持 | 当前目录没有实际压缩操作，也没有压缩完成事件或压缩后用量回执。60% 协调器只保留了经验证 adapter 契约，不会生成总结冒充压缩。 |
| 连续上下文观测 | 不支持 | 当前没有轮次运行中的用量更新事件。 |

## app-server 控制面

执行了只读 `codex app-server proxy` 探测。它无法连接 `<Codex用户目录>/app-server-control/app-server-control.sock`，返回 dead network。未启动独立 app-server 来代替桌面控制面。该接口能力仍未验证。

## 结论

额度读取与会话快照可用于候选识别、状态复核和恢复许可判断。自动压缩及精确的 60% 阈值观测在当前桌面不可实现，因此 UI 明确标记“不支持”；恢复后仍可按原会话续跑。真实五小时耗尽/恢复、桌面 hook 信任、插件安装态与本机 GUI 完整操作均未在本次代码实现中验收。

## 2026-10-13 增补：rollout只读用量与原会话控制

通过精确白名单和 rollout 文件名定位后，observer 还会要求 `session_meta` 内部 id 与目标 id 完全相同，再配对同一 turn 的 `token_usage_record.payload.usage.total_tokens` 与 `event_msg.payload.info.model_context_window`。它忽略 `thread_token_usage` 累计值，不解析或返回对话正文；样本带模型、turn、时间及回执延迟，超过 120 秒标记为过期，压缩事件之后等待新的 usage 记录。实测仅核对数字与字段，不保留或输出目标 id 或正文。

当前桌面 renderer 的本地 bundle 中比例函数使用 `last.totalTokens` 与 `modelContextWindow`，按 `min(totalTokens, window) / window` 显示占比；observer 与该口径一致。该函数本身没有额外扣减 buffer。实际 60% 前置压缩仍未接通：renderer 内部 owner handler 能调用 `thread/compact/start`，但 Windows 插件可用的工具目录没有暴露这个 RPC；app-server 控制 socket 的本地 daemon 分支不适用于当前 Windows 连接。`send_message_to_thread` 把文本包装为普通 turn prompt，没有证据表明它解析 `/compact`，因此不通过它尝试压缩。

同样没有可从插件 worker 调用的原会话 `turn/interrupt` 接口。任务卡提供打开原会话的链接；需要立即停止时，请在桌面原会话中按“停止”。任务开关仅控制自动续跑，不宣称能中断已运行的 turn。此阶段完成了 observer 单测和实时只读取样，不代表压缩或即时 interrupt 已实现。
