---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(usage): when usage records can't be written to disk (full disk, permissions), the usage panel now says so and shows how many records are waiting in memory, instead of failing silently; the notice clears once writing works again.
