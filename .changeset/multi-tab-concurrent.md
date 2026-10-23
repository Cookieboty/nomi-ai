---
---

feat: chat tabs run coding agents concurrently (Claude Code / Codex / dsh, no global concurrency limit), each with its own session and working directory; tabs show status dots and unread badges, support add/close/rename and keyboard shortcuts, and persist across restarts. The coding agent monitor aggregates dsh sessions (detected via the held session lock) and Nomi tabs with endpoint filters; the mascot and the Dynamic Island react per endpoint. dsh tool results are paired with their tool names, and the app warns when dsh needs Node 24 or newer.
