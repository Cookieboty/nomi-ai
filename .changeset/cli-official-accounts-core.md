---
'@nomi-ai/electron': patch
---

feat(cli): groundwork for multiple official coding-agent accounts. Nomi can keep several Claude Code, Codex, Grok and Gemini sign-ins (encrypted with the system keychain) and switch the global sign-in between them, so the CLI in your own terminal follows too. Before switching it saves any token refresh the CLI made, keeps an account signed in from the terminal instead of losing it, cancels instead of overwriting when it can't tell which credentials are newer, backs up the previous sign-in and restores it if writing fails.
