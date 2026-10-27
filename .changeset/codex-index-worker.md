---
'@nomi-ai/electron': patch
---

Codex 会话索引的 sqlite 查询移到 worker 线程，Codex 运行时打开历史列表不再在主线程上同步查询；并发刷新共用一次查询，查询失败时保留上一份索引。
