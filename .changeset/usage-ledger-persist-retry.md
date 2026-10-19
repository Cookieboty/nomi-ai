---
'@nomi-ai/ai-chat': patch
---

fix(usage): when writing the usage ledger to disk fails (disk full / I/O error), the unsaved records now stay queued and are retried instead of being dropped, and the log-scan cursor is only saved after the records it covers are on disk — so a restart no longer loses calls that the cursor had already marked as read.
