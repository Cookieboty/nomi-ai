---
'@nomi-ai/contract': patch
'@nomi-ai/i18n': patch
---

feat(contract): `gateway.upsertProvider` 的 `keys` / `newKeys` 可带 `note`（Key 备注，最多 200 字，空串清除）；补上 Key 备注、Agent 看板关闭标签与批量关闭空闲进程、提醒合并分隔符的中英文案。/ `gateway.upsertProvider` `keys` / `newKeys` accept `note` (a key note, up to 200 characters, empty clears it); zh / en copy for key notes, closing tabs and idle processes in bulk on the Agent board, and the merged-reminder separator.
