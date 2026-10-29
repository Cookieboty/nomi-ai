---
'@nomi-ai/core': patch
'@nomi-ai/contract': patch
'@nomi-ai/gateway': patch
'@nomi-ai/ai-runtime': patch
---

perf(memory): the local AI gateway process now starts on first use (sending a chat message, opening a CLI tab, enabling terminal commands) instead of at launch. Crash restart and the crash fuse work as before. The main process loads undici only when it makes its first upstream request. The contract IPC server can count a window's in-flight calls (`inflightFor`).
