---
'@nomi-ai/ai-chat': minor
'@nomi-ai/desktop-go': minor
---

feat(chat): 侧边聊天可以同时开好几个（标签栏「+ → 新侧边聊天」总是新开；「在侧边聊天中提问」在当前是侧边聊天时加到它上面，否则新开一个），每个各有编号和独立内容，和子任务标签一样有状态点、悬停卡片、拖动排序、拆分、铺满和在新窗口打开，也会列在会话详情的 Agents 里；侧边聊天的输入栏换成主对话同一套（图片附件、排队、停止、重新生成、编辑后重发），模型选择和思考深度也和主对话同一个选择器，只是选的模型只用于这个侧边聊天；侧边聊天仍只由 Nomi 只读回答，内容不保存，重开应用后不恢复。/ Several side chats can be open at once ("+ → New side chat" always opens a new one; "Ask in side chat" adds to the current side chat or opens a new one), each numbered with its own content, and they get the same tab controls as sub-tasks: status dot, hover card, reorder, split, maximize and open in a new window, and they are listed under Agents in the session details. The side chat now uses the main composer and conversation view (image attachments, queueing, stop, regenerate, edit and resend) and the same model and thinking-depth picker as the main chat, with the choice applying only to that side chat. Side chats are still answered by Nomi alone with read-only tools, are not saved, and are not restored after the app restarts.
