---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(computer-use): 桌面操作的确认卡片上点「允许」后，这个对话里后面的桌面操作自动执行，包括付款、发送、删除、系统设置和按坐标点击；「始终允许」或设置里的「自动执行桌面操作」让以后所有对话都不再逐步询问。还没允许时，这些操作的第一次仍会问。密码管理器和银行类应用仍然直接拒绝，紧急停止和审计日志照旧。/ Allowing a desktop action now runs the rest of that conversation's desktop actions automatically, including payments, sending, deleting, System Settings changes and coordinate clicks; "Always allow" (or "Run desktop actions automatically" in Settings) stops step-by-step confirmation in every conversation. Until you allow it, the first of those actions still asks. Password managers and banking apps are still refused, and the emergency stop and audit log are unchanged.
