---
'@nomi-ai/ai-chat': patch
---

feat(chat): coding-agent model choices are limited to the list the CLI or the gateway provides — the model button no longer has "Custom model id", and `/model <id>` no longer accepts an id that isn't in the list. A tab whose current model is outside the list still shows it.
