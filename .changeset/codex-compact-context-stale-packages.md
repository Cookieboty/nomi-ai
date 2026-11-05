---
'@nomi-ai/desktop-go': patch
---

fix(cli-sdk): Codex app-server 驱动在压缩完成后、没有新的占用上报就结束这一轮时，用量里写 `contextTokens: 0`（压缩后大小未知），不再合入压缩前的旧值。Node 与 Go 版一致（#217）。
