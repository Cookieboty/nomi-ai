---
'@nomi-ai/ai-chat': patch
---

fix(chat): 回复还在跑时排队的消息、以及已经插入这一轮的句子，应用重启后不再丢失。待发列表按会话存在元信息和本地，重开后挂回；已经交给模型的插入记在元信息里，打断后补到对话里（可重试，重试仍带着它）。正常结束时它们只留在回复的轨迹里，不会重复出现，也不会把整段对话重写一遍。

Queued composer messages and mid-turn steers now survive an app restart. The pending list is stored per conversation in session metadata and locally, and is restored on relaunch. Steers already delivered into the turn are kept in metadata and, if the turn was interrupted, shown in the transcript after the original user message (retry still includes them). On a normal finish they stay only as trace events, with no duplicate and no whole-conversation rewrite.
