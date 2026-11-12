---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(computer-use): 紧急停止会中止正在操作桌面的那一轮（Nomi 对话、编程助手标签）并撤掉确认卡，直到下一条消息前不再操作；灵动岛上不再常驻「正在操作」。只有图标的按钮、退出 / 关闭窗口快捷键在这个对话允许之前会确认；坐标点击先看落在哪个应用上；编程助手标签只能读自己的 token，标签关闭即作废。新手引导去掉换步动画。/ The emergency stop now aborts the turns that were operating the desktop (Nomi chats, coding-agent tabs) and dismisses their confirmation cards until the next message; the Dynamic Island no longer shows a persistent "operating" item. Icon-only buttons and quit / close-window shortcuts are confirmed until that conversation is allowed, coordinate clicks check which app is under the point, coding-agent tabs can only read their own token and it is revoked when the tab closes. Onboarding steps no longer animate in.
