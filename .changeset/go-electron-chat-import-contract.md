---
'@nomi-ai/contract': patch
'@nomi-ai/core': patch
---

feat(contract): 新增只在对话窗口可用的 `migration.chatHistory` 查询，交出 Go 版首启从 Electron localStorage 抽出的 `ai-chat:*` 键（`none` / `ready` / `failed`），供视图幂等导入旧对话（#181）；Node 版内核恒返回 `none`。
