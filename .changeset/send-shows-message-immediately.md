---
'@nomi-ai/ai-chat': patch
---

fix(chat): 压缩上下文 / 召回记忆期间发出的消息会「消失」几十秒 —— 用户消息现在立刻上屏。

发送流程原来是：先探测后端，再跑发送前的上下文压缩（一次真正的模型请求，几十秒），再召回记忆，最后才把用户那条消息放进会话。压缩期间用户只看到摘要卡在跑，自己刚发的话一直不出现，看起来像输入框把消息吞了；等摘要跑完才突然冒出来。

- 用户消息在拿到文本的那一刻就上屏，后面的后端探测、压缩、记忆召回都在它之后进行，不再挡住它。
- 摘要卡插到这条新消息**上方**（`ADD_MESSAGE` 支持 `beforeId`）—— 摘要概括的是更早的对话，排在刚发的这句下面会读成「先说话再压缩」。
- 结尾那次写入改成按 id upsert，不会因为已经提前上屏而重复一条。
- 后台自动恢复跟进（`bgFollow`）仍然不造假用户气泡。

fix(chat): a message sent during context compaction or memory recall "vanished" for tens of seconds — the user message now appears immediately.

Sending used to probe the backend, run pre-send compaction (a real model call, tens of seconds), recall memory, and only then put the user's message into the conversation. While compacting, the user saw only the summary card running and their own message nowhere — as if the composer had swallowed it.

- The user message is dispatched as soon as its text exists; backend probing, compaction and recall all happen behind it and no longer block it.
- The summary card is inserted **above** that message (`ADD_MESSAGE` gained `beforeId`), because the summary covers the earlier conversation and would read backwards if it sat below.
- The final write is an id-based upsert, so the early dispatch cannot produce a duplicate.
- Background auto follow-ups (`bgFollow`) still do not fabricate a user bubble.
