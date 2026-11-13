---
'@nomi-ai/desktop-go': patch
---

fix(sandbox): 沙箱授权只保存权限并让旧进程在本轮结束后退出，不再冒充用户发送「已允许，请继续」，也不会在停止或完成会话后自动开启新一轮。/ Sandbox grants update permissions and recycle stale CLI processes without injecting a user follow-up or starting another turn after completion or cancellation.
