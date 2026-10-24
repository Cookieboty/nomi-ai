---
'@nomi-ai/ai-runtime': minor
---

GatewayStore is the single source of truth for providers/models: migrate legacy ai-providers.json / CLI stores then rename them to *.migrated, and stop falling back to ProviderStore for Nomi chat / agent-tools / summary roles.
