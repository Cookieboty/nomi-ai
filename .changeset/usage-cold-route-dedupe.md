---
'@nomi-ai/desktop-go': patch
---

fix(usage): 早于约 2 个月、已挪进日文件的网关路由记录，重新扫到对应的 Codex / Claude 工具日志（换了路径、恢复备份、迁移等）时仍能认出是同一个请求，不再重复累计调用数、token 与费用（#270）。/ Tool logs for Codex / Claude requests whose gateway route record is older than about two months (already moved into day files) are still recognised as the same request when they are scanned again (new path, restored backup, migration), so calls, tokens and cost are no longer counted twice (#270).
