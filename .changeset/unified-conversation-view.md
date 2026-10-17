---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/ai-runtime': minor
'@nomi-ai/bundle-ig-base': patch
'@nomi-ai/ui': patch
---

feat(chat): one shared conversation view for Nomi and every coding agent — Nomi chat (including its tool calls, reasoning, sources and memories) now renders through the same component as Claude Code / Codex / Grok / dsh. Adds streaming thinking blocks with a timer ("Thought for N s" when done), explicit waiting states (queued, waiting for permission, first token, retry / reconnect, context compaction, sub-agent, interrupted), per-minute message times with full time on hover, per-turn duration / token / cost summary, copy / regenerate / edit-and-resend / stop actions, an error card with retry, long-conversation paging, and a message queue while a turn is running. History transcripts now carry tool arguments, output, duration and usage. Fixes the lag introduced by the previous conversation view (batched live events, memoised rows, incremental Markdown, bounded trace) and treats Claude `result.is_error` as an error instead of a normal reply.
