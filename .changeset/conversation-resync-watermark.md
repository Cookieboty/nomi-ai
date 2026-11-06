---
'@nomi-ai/ai-chat': patch
---

fix(chat): 会话写入失败后改为整份重写时，等待内核回复期间新发的消息或替换不再被当成已写入而丢掉，重启后历史与界面一致（#266）。/ When a failed conversation write falls back to rewriting the whole conversation, messages or replacements that arrive while the kernel is still answering are no longer treated as already saved and dropped, so history after a restart matches what you saw (#266).
