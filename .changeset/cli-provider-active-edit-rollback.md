---
'@nomi-ai/ai-chat': patch
---

fix(cli): editing the provider that is currently in use (dsh / Grok / Claude / Codex) can no longer leave a half-applied setup. An edit that would fail to apply (for example an empty model for dsh or Grok) is rejected before anything is saved, and if applying the edit fails, the previous endpoint, key and model are restored together, so the CLI config file and the key passed at launch always match.
