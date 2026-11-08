---
'@nomi-ai/desktop-go': patch
'@nomi-ai/types': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/renderer': patch
---

feat(chat): Nomi 对话里的确认少弹很多：读工作区与授权文件夹里的文件不再算外部内容；确认卡片上可以勾「这个对话里不再询问」，同一对话里同类操作（改文件、委派与追问等）之后不再问；同意过的委派，之后的追问不再逐次确认；读过外部内容后命令白名单只在当前对话暂停。删除等破坏性操作、「逐项确认」模式和设成「每次都询问」的工具照旧每次确认。/ Far fewer confirmations in Nomi chats: reading files in the workspace or granted folders no longer counts as external content; confirmation cards offer "Don't ask again in this conversation" for the same kind of action (file changes, delegating and follow-ups, etc.); follow-ups to an approved delegation no longer ask each time; after external content is read, the command allowlist pauses only in that conversation. Destructive actions, the Ask-every-time mode and tools set to always ask still confirm every time.
