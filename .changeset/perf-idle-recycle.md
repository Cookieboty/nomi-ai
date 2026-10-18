---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

perf(harness): a Claude Code process that has been idle for 30 minutes (configurable with `NOMI_HARNESS_IDLE_MS`, `0` turns it off) is now reclaimed to free memory — only when no turn is running, no permission request is pending, and the session can be resumed. The tab shows a hollow "dormant" dot (and a one-line hint under the conversation); the transcript and session are kept, and the next message resumes the session automatically with `--resume`.
