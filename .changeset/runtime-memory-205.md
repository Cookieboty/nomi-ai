---
'@nomi-ai/host-electron': patch
'@nomi-ai/core': patch
'@nomi-ai/contract': patch
'@nomi-ai/gateway': patch
'@nomi-ai/ai-runtime': patch
'@nomi-ai/renderer': patch
---

perf(memory): lower idle memory use. When the mascot is hidden, its window and Rive runtime are released; they are rebuilt when it is shown again or a desktop confirmation needs it. A hidden chat window that stays idle for 10 minutes is destroyed, but never while a request or stream is still running. The local AI gateway process now starts on first use (sending a chat message, opening a CLI tab, enabling terminal commands) instead of at launch. Crash restart and the crash fuse work as before. The main process loads undici only when it makes its first upstream request.
