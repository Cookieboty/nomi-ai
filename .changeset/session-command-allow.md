---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(confirm): 跑命令的确认卡片上新增「本会话始终执行」：这个对话里再跑同一条命令（同一工作目录）不再询问；读凭据、发布这类命令不提供，「逐项确认」模式下不生效。/ Command confirmations add "Always run in this chat": the same command in the same working directory runs without asking for the rest of the conversation; not offered for credential or publishing commands, and ignored in step-by-step mode.
