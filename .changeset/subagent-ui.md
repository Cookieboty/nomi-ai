---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

feat(chat): subagent cards in the conversation show whether a subagent runs in the background, what it is doing right now and how many tools it used; Codex and dsh cards say that the CLI doesn't expose internal steps and show the subagent's final report. Background subagents that keep running after a reply are listed above the conversation ("N background tasks", with elapsed time), Claude Code subagents can be stopped one by one, tabs with background work show a "running in background" dot, and stopping or closing such a tab asks for confirmation first.
