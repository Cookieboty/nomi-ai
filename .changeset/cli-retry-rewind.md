---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/cli-sdk': patch
---

fix(cli): retrying or editing a message in a coding-agent tab now removes that message and everything after it before resending. Claude rewinds the same session in place (`--resume-session-at`) and Codex rewinds the same thread (`thread/revert`), so the model no longer sees the reply being redone; when that is not possible (no recorded turn, or a rewind to the session's first turn) they start a new session that carries the remaining conversation. Grok, Gemini, dsh and external CLIs keep sending in the same session as before. The app-server driver now reports each turn's own id (`TurnResult.cliTurnId`).
