---
'@nomi-ai/ai-chat': patch
---

feat(cli): context compaction for Codex and Grok tabs.

- While the CLI compacts on its own, the tab shows "compacting context" and the context meter resets afterwards (Codex app-server `contextCompaction` items; Grok `auto_compact_*` over ACP and streaming-json).
- `/compact` now works in Codex and Grok tabs: Nomi sends the CLI's own compaction request (Codex `thread/compact/start`, Grok `x.ai/compact_conversation`) instead of passing the text to the model, and replies "Context compacted". An empty session says there is nothing to compact; Codex in its per-turn `exec` fallback says manual compaction needs app-server; a Grok without the extension gets `/compact` as before.
- Gemini's ACP does not report compaction, so its meter still only follows `usage_update`.
