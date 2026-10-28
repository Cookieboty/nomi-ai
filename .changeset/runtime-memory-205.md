---
'@nomi-ai/host-electron': patch
'@nomi-ai/renderer': patch
---

perf(memory): lower idle memory use. When the mascot is hidden, its window and Rive runtime are released; they are rebuilt when it is shown again or a desktop confirmation needs it. A hidden chat window that stays idle for 10 minutes is destroyed, but never while a request or stream is still running.
