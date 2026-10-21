---
'@nomi-ai/electron': patch
---

fix(electron): project and user slash skills / commands can no longer be used to read credentials through symbolic links. The "never read .env / auth.json / *.pem …" rule now also applies to the real target of a link (plus `~/.ssh`, `.git/`, cloud-credential folders), the target is opened and re-verified to prevent swap-after-check, and links inside a repository may only point inside the project or the user agent folders (`~/.claude`, `~/.agents`, `~/.grok`). Shared skills linked from your own `~/.claude/skills` etc. keep working.
