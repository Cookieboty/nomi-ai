---
'@nomi-ai/ai-chat': patch
---

fix(cli): when a CLI is routed through protocol conversion and the model calls several tools in parallel, the Anthropic Messages and OpenAI Responses streams now emit tool-call blocks one at a time with their complete arguments, instead of cutting off the first tool's arguments when the second one starts.
