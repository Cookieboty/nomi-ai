---
'@nomi-ai/ai-sdk-client': patch
---

fix(sdk): `useChat` now reads the real `ChatChunk` (`{type:'delta', content}`) instead of the non-existent `deltaText` field, so replies are no longer blank; `{type:'error'}` chunks surface as errors.
