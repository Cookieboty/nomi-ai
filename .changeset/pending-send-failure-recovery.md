---
'@nomi-ai/ai-chat': patch
---

fix(chat): 排队消息发送失败不再消失。运行结束后自动发出的队首消息，以前先删掉、写「已交付」再派发，图片导入 / 预检 / 来源被换掉时返回的错误被忽略，正文和图片一起没了、后面的消息还会乱序发出。现在内核收下才从待发列表移除；失败时整条（正文与图片）留在最前面，列表里显示可见原因与「重试」，不自动重试；重试 / 手动发送 / Esc 合成发送都能再发，重启后挂回的队列同样适用。自动发送途中标签状态提前回到空闲也不会重发同一条。/ Queued messages are no longer lost when delivery fails: a queued message is removed from the pending list only once the kernel has accepted it, and when image import, the send preflight or a changed source makes the dispatch fail, the whole item (text and images) stays at the front with a visible reason and a Retry action instead of retrying by itself. Retry, manual send and Esc-to-send all re-send it, restored queues after a restart behave the same, and an idle status arriving before the send resolves no longer dispatches the same message twice.
