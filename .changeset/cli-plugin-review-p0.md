---
'@nomi-ai/ai-runtime': patch
'@nomi-ai/ai-sdk': patch
'@nomi-ai/ai-sdk-client': patch
---

CLI-plugin review P0/P1: mapTools/AiSdkLlmProvider plumb `callerTabId` (ALS + ChatRequest.extra) so nested `delegate_to_cli` depth checks work on the production tool path; re-export `runWithToolCaller` / `getToolCallerTabId`.
