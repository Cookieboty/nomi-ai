---
'@nomi-ai/ai-chat': patch
---

fix(usage): when you click Refresh on a quota card and the official CLI explicitly reports you are signed out (Claude `authMethod: none`, Codex `Not logged in`), the old account's quota is cleared immediately (status-line snapshot, `/usage` result, Codex app-server value, and older log snapshots can no longer bring it back) and the card shows "not signed in". A missing CLI, a timeout or unreadable output is still treated as a temporary failure that keeps the last value.
