---
'@nomi-ai/ai-chat': patch
---

fix(usage): the log scanner now remembers each tool log's file identity (inode) and a fingerprint of the part it has already read. If a log is replaced or rewritten in place (restored from backup, atomically replaced, same-size rewrite, or rewritten longer), it is re-read from the start instead of resuming at the old offset and silently skipping the new calls. Cursors saved by older versions are re-read once when their file has changed; the ledger de-duplicates by stable key, so nothing is counted twice.
