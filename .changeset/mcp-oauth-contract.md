---
'@nomi-ai/contract': patch
'@nomi-ai/i18n': patch
---

feat(contract): 新增 `ext.mcpAuthorize`（dangerous）与 `ext.mcpClearAuthorization`；MCP 状态多了 `authorization-required`，服务条目可带 `oauthClientId`、`auth`、`hasAuthorization`；流式 `reasoning` 块可带可选的 `phase: start | end`。/ Adds `ext.mcpAuthorize` (dangerous) and `ext.mcpClearAuthorization`; MCP status gains `authorization-required`, server entries can carry `oauthClientId`, `auth` and `hasAuthorization`; streamed `reasoning` chunks take an optional `phase: start | end`.
