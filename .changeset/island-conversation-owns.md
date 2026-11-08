---
'@nomi-ai/desktop-go': patch
---

fix(island): Nomi 在对话里委派出去的任务做完、结果已回到来源对话后，由对话接着处理，灵动岛不再列为「等你验收」；调试页按 `Esc` 关掉后再放样例也能弹出。/ Tasks Nomi delegated from a chat are handled by that chat once their result is back there, so the Dynamic Island no longer lists them as waiting for review; debug samples show again after closing the island with `Esc`.
