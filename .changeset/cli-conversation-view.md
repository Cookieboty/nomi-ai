---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/ui': patch
---

feat(chat): redesign the coding-agent conversation view (Codex Desktop-style) — tool calls are now compact rows (lucide icon, action summary, spinner / done / failed state, duration) instead of a green plain-text list; consecutive explore / command / edit calls fold into expandable groups ("Explored 3 files, 5 searches"), commands show their output, edits render a coloured diff with +/- stats, sub-agents and thinking are collapsible blocks, permission requests stay a prominent card, assistant text renders Markdown, the footer shows a "Working…" indicator, and auto-scroll follows only while the user is at the bottom (with a jump-to-latest button). The main process now records tool arguments / output / thinking / sub-agent parents (Claude, Codex, dsh, Grok) and persists a bounded trace on each assistant message.
