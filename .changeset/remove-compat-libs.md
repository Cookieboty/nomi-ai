---
'@nomi-ai/core': patch
'@nomi-ai/cli-sdk': patch
'@nomi-ai/ai-runtime': patch
---

删除兼容别名：`hasGrokAuthFile`（改用 `hasGrokLocalPresence`）、`createGeminiMapper`（改用 `createAcpMapper`）、`normalizeImages`（改用 `inspectImages`）、`CliUpdateService.runUpdate`（改用 `run`）、钥匙串 `get`/`set` 存根，以及 ai-runtime 对 `getToolCallerTabId`/`runWithToolCaller` 的再导出（请从 `@nomi-ai/bundle-ig-base` 导入）。Orchestrator 依赖项 `legacyDefaultCwd` 改名为 `previousDefaultCwd`。
