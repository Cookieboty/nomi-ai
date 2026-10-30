---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(cli): when Claude Code runs a subagent in the background, its later output and the follow-up reply Claude writes on its own once the subagent finishes are now saved to the conversation (marked "Follow-up after a background task finished") and trigger the usual completion notification, instead of only flashing by live. A tab with background subagents still running is no longer reclaimed as idle, and permission requests raised between turns can be answered.
