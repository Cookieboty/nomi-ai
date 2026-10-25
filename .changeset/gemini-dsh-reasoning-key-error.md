---
'@nomi-ai/ai-runtime': patch
'@nomi-ai/ui': patch
---

Product polish: Gemini / dsh reasoning-effort UI is disabled with clear copy (no documented control); non-reasoning models show「当前模型无思考深度」. ProviderRouter.isKeyError prefers HTTP status codes (401/402/403/429) before message regex; describeStreamError prefixes HTTP status so stream key-rotation can use the same rule.
