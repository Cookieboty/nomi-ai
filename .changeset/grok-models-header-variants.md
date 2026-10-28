---
'@nomi-ai/host-electron': patch
---

fix(cli): activating a Grok profile now also recognises a `[models]` table written as `[ models ]` or with a trailing comment, and a root-level `models.default = …`, so it no longer appends a second `[models]` table and breaks `~/.grok/config.toml`. A `models = { … }` inline table is reported instead of being rewritten, and cancelling restores the original header and spacing.
