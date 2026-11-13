---
'@nomi-ai/contract': minor
'@nomi-ai/i18n': patch
---

feat(contract): `tasks.trace` 列出每次执行（`attempts`，追问的原话在 `note`）和正在跑的那次写到一半的快照（`live`）；新增 `tasks.steer`（运行中插话）、`tasks.followUp`（结束后追问）和 `tasks.live` 事件（正文增量、工具步骤、插话）；补上侧栏追问与实时更新的中英文案。/ `tasks.trace` lists every attempt (`attempts`, with the follow-up text in `note`) plus a snapshot of the running one (`live`); add `tasks.steer` (interject while running), `tasks.followUp` (follow up after it ends) and the `tasks.live` event (text deltas, tool steps, interjections); zh / en copy for side-panel follow-ups and live updates.
