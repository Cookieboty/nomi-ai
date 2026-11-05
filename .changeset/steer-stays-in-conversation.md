---
'@nomi-ai/ai-chat': patch
---

fix: 在 Nomi 对话里插入的补充消息交付途中切换到另一个对话时，交付失败的消息不再被放进新对话并自动发出（#254）。/ If you switch conversations while a message you inserted into Nomi's running turn is still being delivered, a failed delivery no longer moves that message into the new conversation and sends it there (#254).
