---
'@nomi-ai/ai-chat': patch
---

fix(usage): a slow quota refresh that finishes after you clear usage data (or after the logged-in account changes) can no longer write its old result back — the quota cache now uses a generation check, a refresh after an account switch no longer reuses the previous account's in-flight request, Codex's persisted `quota.json` is not recreated, and "Clear usage data" now also clears the Grok quota cache.
