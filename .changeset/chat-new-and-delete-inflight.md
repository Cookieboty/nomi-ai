---
'@nomi-ai/ai-chat': patch
---

fix(chat): 新建对话不再复用还在后台生成首轮回复的对话（之前会把旧回复又带回「新」对话）；在设置的「已归档的对话」里永久删除对话时，先停止它正在进行的回复，和侧栏删除一致。/ New chat no longer reuses a chat whose first reply is still generating in the background (the old reply used to reappear in the "new" chat), and permanently deleting a chat from Settings → Archived chats now stops its in-progress reply first, like deleting from the sidebar.
