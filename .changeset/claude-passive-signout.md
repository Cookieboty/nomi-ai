---
'@nomi-ai/host-electron': patch
---

fix(usage): with "actively refresh quota" turned off, signing out of Claude Code no longer leaves the previous account's quota on the usage panel. Nomi notices the sign-out from Claude's local config (no process is started) and clears the old quota and status-line snapshot. Codex keeps its credentials in the system keychain, so a Codex sign-out is still only detected on an active refresh.
