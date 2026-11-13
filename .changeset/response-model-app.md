---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/types': patch
---

When the model an upstream provider returns is not the one that was requested, the turn footer shows both (`MAAS · Aerith-fable-5 → claude-fable-5`). Case, a provider prefix, and a date or `latest` suffix count as the same model; the raw returned name stays on the turn and is still there after reload. Nomi chat and coding assistants that go through the local gateway both record it.
