---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

perf(chat): switching conversations is smooth again — median switch latency 252 ms → 27 ms with no long task (long Nomi conversations, 6 conversations × 400 messages). Root causes: the main process ran four synchronous `which` spawns on every harness state broadcast (now cached, never spawned when reading state), every switch waited for two redundant IPC round trips (now skipped when already on the main Nomi tab, and run in parallel with the local switch), and each Markdown block rebuilt a unified processor plus a full highlight.js language registry (now one shared lowlight instance and a settled-message render cache). A switched-to conversation paints its last messages first and fills in older ones in small batches.
