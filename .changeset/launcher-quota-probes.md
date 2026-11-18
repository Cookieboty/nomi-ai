---
'nomi': patch
---

Use the configured CLI launcher for Claude and Codex login detection and subscription quota queries. Preserve local login environments instead of injecting Nomi account directories, avoid inferring wrapper authentication from the native CLI's configuration, and keep launcher diagnostics on stderr from corrupting Claude auth-status JSON.
