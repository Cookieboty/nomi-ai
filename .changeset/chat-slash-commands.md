---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/ui': patch
---

feat(chat): slash command palette for every conversation (Nomi / Claude Code / Codex / Grok / dsh) — typing `/` opens a grouped, fuzzy-searchable palette (built-in / endpoint / project / user / plugin / Skills) with argument hints and keyboard navigation. Nomi-native commands (`/context` with a progress bar and breakdown, `/cost`, `/status`, `/model`, `/help`, `/diff`, `/clear` / `/new`) run locally and render as system cards inside the conversation instead of being sent to the CLI; documented Claude Code commands (`/compact`, `/init`, `/code-review`, `/security-review`, `/effort`, `/config`) and project / user commands and skills are passed through (Claude) or expanded locally by the main process (Codex / Grok); interactive-only commands and unknown `/xxx` show an explicit hint and are never silently sent to the model (`//` sends a literal slash). A read-only "Plugins / commands" panel lists the commands, Skills, plugins, MCP servers and sub-agents discovered for the current endpoint (file names and frontmatter only — credentials and MCP env / headers are never read). Design and research notes: docs/design/chat-slash-commands.md.
