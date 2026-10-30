---
'@nomi-ai/host-electron': patch
---

fix(electron): writing to the stdin of a coding-agent CLI (Claude Code's long-lived process, Codex / dsh / Grok) or of a code-sandbox program that has already exited no longer crashes the main process with an uncaught `EPIPE`; the turn simply fails as the process closes.
