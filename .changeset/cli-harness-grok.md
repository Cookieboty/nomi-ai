---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/ui': patch
---

feat(cli): add Grok Build as a coding-agent endpoint — detect/install (`grok update` + npm `@xai-official/grok`), headless `streaming-json` harness, per-endpoint provider store that patches `~/.grok/config.toml` with an env_key (key injected only at launch), usage from `sessions/**/updates.jsonl` turn_completed rows, and endpoint glyph. Quota UI treats Grok as API billing; sidebar history for Grok is deferred.
