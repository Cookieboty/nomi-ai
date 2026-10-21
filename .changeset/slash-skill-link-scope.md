---
'@nomi-ai/electron': patch
---

fix(security): project slash skills / commands can no longer use symbolic links to read Claude Code's session history and transcripts. Links from a project may only point into the user's skill / command / agent / plugin folders (not all of `~/.claude`), a link may not change the file type (a `SKILL.md` can only point to a `.md`), and common secret files (service-account keys, `*.tfvars`, `secrets.*`, shell history) are never read.
