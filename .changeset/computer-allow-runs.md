---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(computer-use): 桌面操作的确认卡片上点「允许」后，这个对话里后面的桌面操作自动执行；「始终允许」或设置里的「自动执行桌面操作」让以后所有对话都不再逐步询问。付款、发送、删除、系统设置里的改动和按坐标点击仍每次确认。/ Allowing a desktop action now runs the rest of that conversation's desktop actions automatically; "Always allow" (or "Run desktop actions automatically" in Settings) stops step-by-step confirmation in every conversation. Payments, sending, deleting, System Settings changes and coordinate clicks are still confirmed every time.
