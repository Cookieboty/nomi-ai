---
'@nomi-ai/ai-chat': patch
---

fix(cli): activating a Grok provider profile no longer adds a second `[models]` table when `~/.grok/config.toml` already has one (which made the whole config unparseable). The existing table's `default` is switched in place and restored when Nomi stops managing the config.
