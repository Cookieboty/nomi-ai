---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

feat(chat): delete coding-assistant sessions — local history rows (Claude Code, Codex, Gemini, Grok, dsh) get a delete button and a "Delete chat" menu item, and an open CLI tab can now be deleted (not only closed): after an in-app confirmation (same look on macOS and Windows, no system dialog) Nomi closes the tab and moves that CLI's own session record (all files of the session, plus its sub-agent / index files) to the system Trash, so it can still be recovered. Sessions still open in a tab are never deleted from disk; Codex's own thread index is left untouched. Nomi conversations keep their existing permanent delete with inline confirmation.
