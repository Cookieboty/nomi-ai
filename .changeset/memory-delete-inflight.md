---
'@nomi-ai/desktop-go': patch
---

fix(memory): 删除对话摘要或清空记忆时，正在进行的整理结果直接丢弃，不会把删除前的内容（摘要和「关于我」条目）写回来。/ Deleting a conversation summary or clearing memory discards a summary that is still being made, so content from before the deletion (the summary and "About me" entries) is not written back. (#289)
