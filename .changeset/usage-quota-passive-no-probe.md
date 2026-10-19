---
'@nomi-ai/ai-chat': patch
---

fix(usage): opening the usage panel, its 30-second re-read and data-change notifications no longer start `claude auth status` / `codex login status` / the Grok ACP sign-in probe. Those probes now only run when "Active quota refresh" is on and you click Refresh for a tool (or "Refresh all"), and a single-card refresh only probes that tool. With the switch off, Refresh only re-reads local data. Tools that have not been probed yet and have no local hint stay hidden until you refresh once (the empty state now says so).
