---
'@nomi-ai/ai-sdk-client': patch
'@nomi-ai/ai-runtime': patch
---

fix(sdk): IPC stream listeners are released as soon as a stream ends or fails (and on `dispose`), and `tts.stream(text, opts)` keeps its positional arguments (the request id travels in a separate envelope instead of being inserted in front of them).
