---
'@nomi-ai/ui': patch
---

fix(chat): when two custom slash commands / skills share a name (project vs user, custom vs built-in, or a Grok bundled skill), the one that loses the bare name used to be shown as `/project:foo` but still sent `/foo`, so a different command ran. Claude Code and Grok have no verified syntax to target the other version, so those entries now stay in the menu marked "Unavailable" with the reason, and selecting or typing them shows an explanation instead of sending anything. The winner keeps the bare name, matching the CLI's own precedence. Codex (expanded by Nomi by id) and Nomi are unchanged.
