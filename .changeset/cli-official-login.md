---
'@nomi-ai/electron': patch
---

feat(cli): sign in to official Claude Code, Codex and Grok accounts from inside Nomi. Each sign-in runs the CLI's own login command in a separate staging folder, so your current sign-in is untouched until you switch; Nomi shows the sign-in link and device code (or a box to paste Claude's authorization code), stores the new account encrypted and cleans up the staging folder (and its temporary keychain item on macOS). Only official sign-in pages can be opened from it.
