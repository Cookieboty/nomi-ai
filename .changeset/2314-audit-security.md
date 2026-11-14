---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(security): 修复 2.3.14 审计中的权限与自动执行问题：`harness.messageAgent` 只允许向当前标签已发现的子代理发消息（拒绝主线程和未登记的 thread id），驱动层同样拒绝；没有系统沙箱时（Windows / Linux）L3 任务不再切到 auto，命令保持逐条确认；命令审核在发给辅助模型前打码密钥、令牌和本机路径，并在审核卡片与设置里写明会发送命令全文。另外去掉标签栏「+」里用不上的「本会话的 Agents」项（会话详情里的 Agents 列表仍在）。/ Fix 2.3.14 audit findings: harness.messageAgent only talks to a discovered sub-agent of the current tab (rejects the main thread and unregistered thread IDs), and the driver rejects them too; without an OS sandbox (Windows / Linux), L3 tasks no longer switch to auto and commands stay per-step confirmation; command review redacts credentials, tokens and the home path before sending to the helper model, and the review card and settings say the full command is sent. Also remove the unused "Agents in this chat" item from the side-tab + menu (the Agents list in session details stays).
