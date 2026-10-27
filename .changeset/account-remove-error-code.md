---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

fix(accounts): on Windows with the English UI, deleting a Codex / Grok / Gemini official account now shows the second "force delete" confirmation when Nomi can't tell whether a CLI is still using it. The decision now uses an error code passed through IPC instead of matching the (translated) error text (#137).
