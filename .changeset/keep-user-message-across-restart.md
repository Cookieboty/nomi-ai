---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(chat): Nomi 对话的用户消息发出就先存进对话记录，不再等这一轮回复结束才一起落盘。之前回复还在跑时应用重启（比如装更新），刚发的那句话会整句消失。现在重开后它还在对话里，后面跟一张「这一轮被重启打断」的卡，点「重试」就从这条消息重新发送。这张卡只在界面上显示，不写进记录。之后带上记忆、委派对象，或中途插进压缩摘要时，按消息 id 再存一次，不会多出一条，顺序也还是「摘要 → 问题 → 回复」。没变化的轮次只追加，不整份重写。智能标题照常生成。

Nomi chats now save the user's message as soon as it is sent instead of waiting for the reply to finish. Before, restarting the app mid-reply (for example to install an update) dropped the message entirely. Now it is still in the chat after relaunch, followed by an "interrupted by a restart" card whose Retry button sends it again. The card is display-only and never written to history. When the message later gains recalled memory or a hand-off target, or a compaction summary is saved mid-turn, it is re-saved by id, so there is no duplicate and the order stays summary → question → reply. Turns with no such change still append only, without rewriting the whole conversation. Smart titles still run.
