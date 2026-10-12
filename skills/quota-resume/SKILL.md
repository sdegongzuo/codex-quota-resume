---
name: quota-resume
description: 启用、关闭或查看 Codex 桌面五小时额度恢复后的自动继续。用于用户希望额度用完后到点续跑原聊天，或查看待续跑记录时。
---

在当前 Codex 桌面聊天中运行本插件的 `scripts/control.mjs`。脚本路径相对本技能目录为 `../../scripts/control.mjs`，调用时解析成绝对路径；Windows 可用同目录的 `run.cmd` 选择 Codex 提供的 Node。

启用时先运行 `probe`，确认桌面额度接口和聊天读取可用；再运行 `enable` 和 `status`。用户请求启用即为对本聊天自动发送续跑提示的授权，无需重复询问。数据默认存于 Codex 用户目录下的 `plugins/data/codex-quota-resume`，源码版与安装版共用同一后台程序；使用 `--data-dir` 可指定目录，Windows 禁止写入 C 盘，遇到此错误应指定用户授权的 D 盘目录。

关闭运行 `disable`，查询运行 `status`。后台程序独立等待，不要让模型通过 sleep 等待额度恢复，也不要创建周期性模型任务代替它。

说明实际状态：`enabled` 表示开关，`running` 表示后台程序通过本机端口检查，`state.pending` 是等待或发送记录。`sending`、`uncertain` 不会自动重发，避免超时或崩溃产生重复消息。需要用户检查原聊天是否已收到提示。

只处理启用后、结构化错误为额度限制、同时观测到五小时窗口耗尽的失败。恢复必须得到后台 `ordinaryUsageAllowed: true`。不消费额度重置券、不购买额度、不换账号或模型。

启用后，已信任的 SessionStart 和 UserPromptSubmit hooks 会登记后续主聊天并更新应用重启后的连接。首次安装需要用户在 Codex 界面审查并信任 hooks；不能绕过信任检查。未信任时，手动调用本技能仍可启用当前聊天。

已完成、用户中断或已有新轮次的聊天不续跑。为避免误操作归档聊天，发送对象须在全部置顶聊天或最近 50 个非置顶聊天中；长时间等待的聊天建议置顶。应用关闭期间不发送，重启后的首次会话 hook 或重新运行 enable 可更新连接。

限制和验收见插件根目录的 README.md。不要把模拟额度测试说成真实五小时额度恢复验收。
