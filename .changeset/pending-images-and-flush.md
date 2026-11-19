---
'@nomi-ai/ai-chat': patch
---

feat(chat): 待发消息支持带图片排队。运行中发带图的消息（或 Ctrl+Enter 排队）不再被拒绝或静默丢图：图片随消息进待发列表，本轮结束后连同原图一起发出，待发列表里显示缩略图与「+N」；Esc 合成发送时按图片上限（Nomi 6 张 / CLI 8 张）自动分批，不丢图；待发列表新增「停止并发送」，跑着的时候也能直接把列表发出去。/ Messages queued while a reply is running can now carry images instead of being rejected or silently dropping them: the images travel with the pending item, show as a thumbnail with a "+N" badge in the pending list, and are sent with the original data when the turn ends. Esc-to-send batches the merged list by each endpoint's image cap (6 for Nomi, 8 for a CLI) instead of dropping images, and the pending list gains a "Stop and send" action.
