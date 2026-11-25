# Slash Commands and Plugin Panel

Type `/` in the input box of any session (Nomi chat or an agent tab) to open the command palette. Once selected, commands **run inside Nomi's UI and render their output as cards in the conversation stream**.

![Slash command palette](../screenshots/slash-palette.png)

## Usage

| Action | Behavior |
| --- | --- |
| Type `/` | Opens the palette; keep typing for fuzzy search (`/cnt` matches `/context`) |
| ↑ ↓ | Select a command |
| Enter | Execute; commands taking arguments (shown with argument hints in the palette) complete to `/<name> ` first so you can enter arguments and press Enter again |
| Tab | Autocomplete only without executing |
| Esc | Close the palette |
| `//xxx` | Send a literal `/xxx` (not treated as a command) |
| Paths such as `/usr/bin` | Sent as plain text |

Commands are grouped in order: current endpoint (the CLI's own commands), project custom commands, user custom commands, plugins, Skills, and finally Nomi built-in commands. The badge on the right of each entry indicates who handles it: **Built-in**, **Forwarded to CLI**, **Expanded** (Nomi reads and expands the command file before sending), or **Unsupported**.

When a session has a working directory, typing `@` autocompletes file paths inside it.

## Built-in Commands (Local Execution, Zero Model Turns)

![/context card](../screenshots/slash-context-card.png)

- `/context`: Context window usage with a progress bar and category breakdown. Total usage matches Claude Code / Codex accounting: input tokens (including cache reads and writes) plus output tokens from the last model request, labeled **Actual** when real usage data is available or **Estimated** otherwise; unrecognized models default to 128K. In Nomi chats, the breakdown separates system prompt, tool definitions, long-term memory, and message categories: the core estimates ratios from the actual outbound request, then calibrates using the first request's real input and the delta between the last and first requests so the parts sum to the total. In Grok tabs, `/context` is forwarded to Grok itself.
- `/cost` (`/usage`, `/stats`): Token and cost totals for this session, today, and the last 7 days from the local usage ledger.
- `/status`: Endpoint, model / provider, working directory, sign-in method, CLI version, and session.
- `/model [name]`: Lists available models and switches; `/model <name>` switches directly.
- `/mode`: Cycles permission modes (Plan / Ask each time / Auto-edit files / Auto / Full access), same as `Shift+Tab`.
- `/clear` (`/new`, `/reset`): Starts a new conversation while keeping the previous one in history.
- `/diff`: Uncommitted changes in the current working directory (relative to `HEAD`, including untracked files).
- `/plugins` (`/skills`, `/mcp`, `/agents`): Opens the read-only Plugin Panel.
- `/help`: Available commands and execution modes for the current endpoint.

Available only in Nomi chats:

- `/agent <name> [request]`: Explicitly delegates to a specific agent (running in the background by default), such as `/agent codex fix the login bug`. When a request is provided, it dispatches immediately without going through the chat model; if the agent is not installed, delegation is disabled, or dispatch fails, Nomi explains why in chat instead of claiming it succeeded. Entering only the name routes the next message to that agent, and `/agent off` cancels. Typing `/` shows `/agent` among built-in commands; typing `/agent ` lists available agents (installed ones first, uninstalled ones dimmed). See [AI Chat](chat.md#handing-off-to-agents-delegation).
- `/compact [focus]`: Summarizes earlier turns to free up context space (also runs automatically before sending when nearing the limit); any focus text you provide is prioritized in the summary.
- Enabled Nomi skills (see [MCP & Skills](mcp-skills.md)) also appear as `/<skill-name>` and follow the skill instructions when selected.

## Forwarded and Expanded Commands

- **Claude Code**: `/compact`, `/init`, `/code-review`, `/security-review`, `/effort`, `/config`, and similar commands are forwarded verbatim to the CLI; project and user custom commands and skills in `.claude/commands` and `.claude/skills` are also listed and forwarded verbatim.
- **Codex**: `/compact` is forwarded to Codex to compact the current session; project and user skills are expanded by Nomi (`$ARGUMENTS`, `$1`, …) and sent as a user message.
- **Grok**: Commands supported by Grok's headless mode (such as `/compact` and `/context`) and skills are forwarded verbatim to Grok.
- **Gemini, dsh**: Nomi built-in commands only.

## Unsupported and Unknown Commands

Native CLI commands that cannot work under the current integration mode (such as `/memory`, `/permissions`, `/login`, and `/resume`) are omitted from the menu; typing their full name explains why they are unsupported and what to use instead. Typing a nonexistent `/xxx` **never sends it to the model**—Nomi flags it as an unknown command and offers **Send as plain text**.

## Plugin Panel (Read-Only)

In agent tabs, open it from the `+` menu in the input bar (**Plugins / Commands**) or via `/plugins`: lists discovered commands, Skills, plugins, MCP servers (names and transport types only), and subagents for the current endpoint. In Nomi chats, `/plugins` displays Nomi's own skills and MCP servers (managed under **Extensions**). There are no toggles in the panel: Nomi does not modify individual CLI configurations on your behalf.

## Privacy and Security

- Command discovery reads only filenames and file headers (the first 8 KB of each file), and **never reads** credential or settings files (`auth.json`, `.credentials*`, `.env*`, `settings*.json`, `config.toml`, `~/.claude.json`); from `.mcp.json`, only server names and transport types are extracted. Symlinks are checked against their resolved real path.
- Command files are expanded by the core by ID—the UI cannot pass arbitrary paths—and dynamic shell injection (`` !`cmd` ``) inside command files is never executed by Nomi.

## Implementation

- UI: `packages/ai-chat/src/slash` (`registry.ts`, `adapters/<endpoint>.ts`, `atPathComplete.ts`), `components/SlashPalette`, `components/PluginPanel`.
- Core: command discovery `apps/desktop-go/internal/core/cli/slashdiscovery.go`.
