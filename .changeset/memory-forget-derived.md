---
'@nomi-ai/desktop-go': patch
---

fix(memory): 忘记是真的忘记。删掉一段对话摘要时，从它整理出的「关于我」条目一起删掉；之后再整理这段对话只看删除之后的新消息，删掉过的条目不会被重新整理回来（自己再写一条同样的内容则以你为准）。清空全部记忆同理。/ Forgetting now sticks. Deleting a conversation summary also deletes the "About me" entries extracted from it; later summaries of that conversation only use messages after the deletion, and deleted entries are not extracted again (writing the same entry yourself brings it back). Clearing all memory works the same way.
