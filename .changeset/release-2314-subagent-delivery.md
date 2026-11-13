---
'@nomi-ai/ai-chat': patch
---

fix(chat): 子任务待发消息不再因关闭或切换侧栏而丢失，关闭后仍会在任务空闲时交付；追问失败保留原文和附件，提供手动重试而不静默丢弃；接续 Claude 子代理会话的侧栏补齐权限审批和沙箱授权卡片。/ Sub-task pending messages survive closing or switching the side panel and continue delivery when the task becomes idle. Failed follow-ups retain their text and attachments with explicit retry instead of being silently discarded. Resumed Claude subagent conversations now show permission approval and sandbox authorization cards in the side panel.
