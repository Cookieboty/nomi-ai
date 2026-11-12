---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(chat): Codex 和 ACP 的提问也用输入栏上方的问题卡。Codex app-server 的 request_user_input 与表单式 MCP elicitation、ACP 的 elicitation/create 都在这张卡上答，答完、跳过、取消或超时按各自协议回写；命令和文件的允许 / 拒绝仍走原来的卡片。Codex 退回 exec 时没有来回通道，问不了。/ Codex and ACP questions use the card above the composer. Codex app-server request_user_input and form-mode MCP elicitation, and ACP elicitation/create, are answered there, and the answer, skip, cancel or timeout is written back in each protocol's shape. Command and file allow / deny stay on the existing card. Codex's exec fallback has no channel back, so it cannot ask.
