---
'@nomi-ai/contract': patch
---

feat(contract): 定时 / 持续任务的 `cli` 执行者在档位模式（`presetId`）下可以不传 `cli`，执行参数由内核按触发时的当前档位解析；显式执行者仍要求 `cli`。补齐公开契约里 `newTabSource` 与 `helperModel` 字段的说明（新会话默认来源与后台辅助请求模型）。 Tasks with a `cli` executor can omit `cli` when `presetId` is set; the kernel resolves the current preset at trigger time. Explicit executors still require `cli`. Also documents the public `newTabSource` and `helperModel` fields (default source for new sessions and the helper model for background requests).
