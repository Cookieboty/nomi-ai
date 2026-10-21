---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

fix(cli): permission requests from subagents running in parallel no longer replace each other. Every pending request is listed with the subagent that asked ("Subagent · …") and a countdown to the automatic denial, each answer goes to its own request, and a request that times out is reported instead of silently disappearing.
