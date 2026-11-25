# Privacy & Security

Nomi is local-first: your data stays on your computer.

Location: **Settings → Privacy & permissions**, organized into three tabs: **Privacy & data**, **Outbound protection**, and **Data export**. File authorizations, tool permissions, and action logs live under **Settings → Nomi → Desktop permissions**.

## Where Data Is Stored

Chats, memories, knowledge base indexes, reminders, schedules, tasks, skills, and settings are all stored in the local app data directory (referred to below as `userData`), never uploaded or synced:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Nomi` |
| Windows | `%APPDATA%\Nomi` |
| Linux | `~/.config/Nomi` (or `$XDG_CONFIG_HOME/Nomi`) |

Chat transcripts live in `userData/conversations/` (see [AI Chat](chat.md#where-conversations-are-stored)) with `0600` file permissions.

API keys, cloud recognition keys, and MCP secrets/tokens are encrypted via the OS secure credential store. If the OS credential store is unavailable, Nomi **refuses to save them** rather than falling back to plaintext on disk.

## Local-Only Mode

**Only local models can read files** under **Settings → Nomi → Desktop permissions → Cloud & local-only**: when enabled, file contents, images, knowledge base snippets, and audio recordings are sent only to local models (such as Ollama or the built-in `llama.cpp`); requests carrying this content to cloud models are rejected. When disabled, each cloud model prompts for your consent the first time it is about to receive such content, and consented models are listed on the same page. **Offline mode** on the **Local models** page also turns this setting on. If you switch models mid-conversation, previously read files, command outputs, and web pages are re-evaluated against the new model, and disallowed items are replaced with placeholders before sending. Paginated reads of previously truncated outputs and summarization models handling earlier steps in long-running tasks are likewise re-checked against the actual receiving model: disallowed paginated reads are blocked, and disallowed items in summarization inputs are replaced with placeholders.

## Outbound Protection

**Settings → Privacy & permissions → Outbound protection** (on by default): before sending requests to third-party providers, secrets in messages, file contents, and command outputs are replaced with placeholders and restored in the reply, keeping the original secret strictly on your machine. Applies to both Nomi chats and all agents.

- Detects provider API keys, tokens (GitHub, Slack, JWT, etc.), private keys (PEM), and passwords (connection strings, assignments); **Strict detection** also matches by key name (which may produce false positives).
- When a secret is detected, you can choose **Redact** (default), **Warn only** (send as-is and log an entry), or **Block** (abort the turn).
- **Send format-matched fake keys**: Substitutes a synthetic key matching the prefix, length, and character classes of the real one so format validation checks still pass.
- **Registered secrets**: For values without a standard format—such as internal company tokens or database passwords—register them (at least 8 characters, stored encrypted locally) to hide them in every outbound request; use **Never redact** for false positives.
- **Also hide for local models** is off by default, since traffic to local or LAN models such as Ollama and LM Studio never leaves your machine/network.
- **Try it** lets you paste text and preview locally what a provider would receive; **Recently hidden secrets** logs only the type, length, and leading characters.

## Permissions and Confirmations

- Files can only be accessed inside folders you have authorized (via the system folder picker or by clicking **Authorize** on a **Request folder access** card in chat). Sensitive locations are always denied, and you can add extra protected folders under **Desktop permissions → Privacy**. See [Automation & Desktop Capabilities](automation.md).
- **Local protection for agents**: Agents (Claude Code, Codex, etc.) can only operate inside project folders—root directories, your home directory, broad folders like Documents or Desktop, system directories, and protected folders are disallowed. Neither agents nor Nomi's workspace commands inherit tokens, passwords, cloud keys, or database connection strings from your environment (model service credentials are still passed, and genuinely needed variables can be allowlisted under **Privacy**). Codex disables network access by default and asks before going online. On macOS, agents also run inside a system sandbox (on by default) that blocks reading sensitive paths and restricts writes to project folders; blocked attempts can be authorized per session or permanently in chat. See [Agents](coding-agents.md#local-protection).
- **Projects for Nomi chats**: Above the input box of a new chat, you can attach a project to each Nomi conversation (or leave it unset). Nomi's file tools work directly across all folders in the project, and commands start in the primary folder. Outside the project, only folders and files you separately authorized (including files dropped onto Nomi) are accessible, following normal authorization and confirmation rules. Your home directory itself, its parents, Documents / Desktop / Downloads themselves, system directories, and sensitive directories cannot be added to a project, nor can one folder in a project contain another. If a folder is later deleted or added to the protected list, Nomi and agents stop using it (if the primary folder becomes unusable, the whole project becomes unavailable).
- **No confirmation for workspace file operations** (**Settings → Nomi → Permissions & handoff**, follows **Auto-approve All** unless explicitly overridden): When enabled, file reads and writes inside project folders no longer prompt individually; unauthorized paths outside the project and sensitive files remain blocked.
- **Auto-review commands** (**Settings → Nomi → Permissions & handoff**, on by default): Under **Auto-edit files**, Nomi sends commands (`workspace_run`) to an auxiliary model for risk assessment before running them: low-risk commands run immediately, while high-risk commands—or any command in a turn that has read untrusted external content (web pages, command outputs, clipboard, knowledge base, MCP responses, delegated agent results, etc.; files in the workspace or authorized folders do not count)—prompt you for confirmation. Switching to **Auto** runs allowed commands directly without a confirmation card. If the review fails or times out, or if the auxiliary model is in the cloud and you have not consented to sending content to it, Nomi falls back to asking you. When turned off, every command asks for confirmation. Under **Auto-edit files**, commands still prompt if external content was read, if the review flags risk, or if review is unavailable. Note: commands run as your user account and are **not confined to the workspace**—they can read and write anything you have access to.
- **Command allowlist**: Checking **Don't ask again for commands starting with this** on a command confirmation card records its prefix (such as `pnpm test`, `go test`, `git status`, `pnpm run build`) in the allowlist so matching commands run directly without review or prompts. Only recognized test, build, lint, or read-only inspection `<program> <subcommand>` pairs (such as `pnpm test`, `go vet`, `cargo check`, `make test`, `git diff`, `tsc`) are eligible—bare program names (such as `make`) are not. Only simple commands can be saved: pipes, redirections, `;` / `&&` chaining (except a single leading `cd <subdir> &&`), and command substitutions are ineligible. Commands containing flags that swap binaries or write to arbitrary paths (`-exec`, `-toolexec`, `-vettool`, `--output`, `-O`, `--config`) are neither saved nor auto-approved (evaluated on post-unquoting shell arguments, catching forms like `"-exec=…"` and `--out"put"=…`, as well as unambiguous long-option prefixes such as `--outp=…`). Review and confirmation still apply when: external content was read in the current turn; files were modified in a turn that read external content (subsequent turns in that conversation are also paused until you manually confirm one command in that conversation, for up to 24 hours; other conversations are unaffected); the mode is **Ask each time**; or you set that tool individually to **Always ask**. View or remove rules under **Desktop permissions → Tool permissions → Command allowlist**; older saved rules that no longer qualify are dropped automatically.
- The **permission mode** in Nomi chat's input bar (`Shift+Tab` to cycle) controls how often Nomi's own tools ask:
  - **Plan**: Read-only; mutating actions are rejected immediately.
  - **Ask each time**: Prompts on every change, with no "don't ask again in this chat" option.
  - **Auto-edit files** (default): Follows each tool's setting under **Desktop permissions → Tool permissions**.
  - **Auto**: Runs allowed tool calls directly without per-action prompts; workspace boundaries, sensitive paths, and OS-level extra consents still follow their respective rules.
  - Destructive actions and writes after reading external content in the same turn also run directly at this level; switch back to **Auto-edit files** or **Ask each time** when tighter control is needed.
- **Per-conversation approval**: Clicking **Always allow** on a confirmation card for mutating actions (or the matching confirmation on the Dynamic Island) suppresses further prompts for the same action category in that conversation (file edits form one category, delegations and follow-ups another, desktop control another, and all other tools are scoped per tool). The button tooltip states the exact scope, and reading external content will not re-trigger prompts within it; switching to another conversation requires fresh approval, and approvals clear on app restart. Deletions and other destructive actions, command execution (governed by the command allowlist), **Ask each time** mode, and tools configured as **Always ask** (such as browser actions) are excluded from per-conversation approval. Desktop control is an exception: clicking **Allow** covers all subsequent desktop actions in that conversation—including payments, sending, deleting, and coordinate clicks—while **Always allow** on the card auto-approves across all future conversations. Password managers, banking apps, and Nomi's own windows remain blocked. Emergency stop and audit logging continue to apply.
- **No re-confirmation for follow-ups**: Once a delegation is approved, subsequent follow-ups sent by Nomi to the same agent do not re-prompt each time (**Plan** still blocks them and **Ask each time** still prompts).
- Every tool call is recorded in the local audit log (logging only argument hashes and lengths).
- For agent permissions, see [Agents](coding-agents.md#permission-modes): when **Auto-approve All** is enabled, new tabs run with **Full access** and their commands can access anything you can access.

## Export and Clearing

- **Data export**: Bundles selected categories (`conversations/`, long-term memory, schedules and reminders, skills, settings) into a `.zip` archive; excludes API keys and encrypted MCP configuration values.
- Under **Privacy & data**, you can clear the current conversation (deleting only messages in that chat), manage memories, or jump to usage privacy settings; memories, desktop permissions, and other stores can also be cleared individually.
- **Generate chat titles with model**: When enabled, the first message of a new chat is sent once more to the active model to generate a title; when off, the first sentence is used directly.

## Subscription Quotas and Sign-In Credentials

**Settings → Usage & analytics → Usage & cost** displays official account subscription quotas per tool (Claude Code, Codex, Grok), with a refresh button on each card. Quota bars are shown only for account/subscription sign-ins; API-key or third-party-provider setups show **API billing, no subscription quota** while still tracking usage and cost.

- **Nomi never touches sign-in credentials**: It never reads, stores, or uploads `auth.json`, `.credentials.json`, or OS keychain entries, never calls undocumented endpoints, and never estimates quotas.
- **Quotas come from only two sources**: Data already present locally (such as quota snapshots written to session logs by Codex, or quota data in Claude Code's status-line input—the latter requires opting in on the card), plus results fetched using the official CLI's own login session when you manually refresh (temporarily running `claude -p /usage`, `codex app-server`, or Grok ACP in read-only, non-approving mode and exiting immediately). Nomi retains only percentage, window, reset time, and plan name; email addresses and account IDs are discarded.
- When multiple official accounts exist, these commands run inside the default account's own config directory.
- When **Actively refresh quotas** is turned off, refreshing only re-reads existing local data without launching any CLI.

## Coding Tool Usage Logs

**Usage & cost** reads **accounting fields** already written locally by coding tools (timestamp, model, token counts, session/project name), deduplicates requests, and computes costs locally. Supports Claude Code, Codex, `dsh`, Grok, Gemini CLI, Qwen Code, OpenCode, GitHub Copilot CLI, Kimi, and Aider.

- Read-only, accounting fields only: never reads message bodies or credentials; OpenCode and Copilot CLI SQLite databases are opened read-only and run fixed queries.
- Offline and never uploaded; respects each tool's home directory environment variables (such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`).
- **Usage ledger**: Deduplicated records are stored under `userData/usage/` and pruned according to your **Usage retention** setting (1 year by default). Roughly the most recent 2 months live in `ledger.jsonl` and stay in memory per record; older entries are moved by local date into `ledger-days/YYYY-MM-DD.jsonl`, keeping only daily totals and deduplication key hashes in memory (`ledger-days/index.gob` caches those totals and is rebuilt if deleted). Charts and heatmaps read the daily totals directly, loading individual daily files only when request details or CSV exports query older dates. When re-scanning coding tool logs older than 2 months, only the corresponding day's file is opened to match gateway route records so the same request is never double-counted. After editing prices or adding custom pricing, costs for older dates are recalculated in the background—showing the previous cost until finished (token and call counts are unaffected). Downgrading to a version prior to 2.3.0 only displays the last ~2 months while leaving daily files intact, so upgrading back restores everything.
- **Pricing and model metadata**: Fetches the public pricing table and model parameters from `https://models.dev/api.json` (at most once every 12 hours on startup unless triggered via **Sync now**, and can be disabled); requests carry no usage or account data. Pricing precedence: custom > synced > built-in.

## Diagnostic Logs

**Settings → Privacy & permissions → Privacy & data → Diagnostic logs** helps troubleshoot third-party providers, agents, and gateway issues.

- Enabled by default (always on in development builds), allowing you to view raw gateway request bodies in a chat's **Execution trace**. Because this records conversation content and code locally, turn off **Save diagnostic logs** if you prefer not to keep them; your choice takes effect immediately for subsequent turns. When enabled by default, logs stay at normal verbosity; debug verbosity is enabled only when explicitly turned on in settings (or in development builds).
- Records raw agent I/O (`userData/logs/`, retained for 7 days) and gateway request/response bodies (`userData/gateway/trace/`, retained for 24 hours, pruning oldest files once total size exceeds 256 MB). Each gateway request has a trace ID included in the `x-nomi-trace-id` response header and in **Requests**.
- Keys, tokens, and `Authorization` headers are redacted; environment variables are never logged.
- **Export diagnostics bundle** packages the last 24 hours of logs into a `.zip` and runs a second redaction pass before export. Because the bundle contains chat content and code, share it only with people you trust.
- During development, set `NOMI_DIAG_BODY=0` to disable gateway body tracing independently.

## Application Security

- Communication between the UI and core occurs exclusively over a local `127.0.0.1` connection using a per-window one-time token and origin validation; every callable UI action is explicitly declared in the application contract.
- Nomi's speech bubbles and the Dynamic Island render plain text only.
- Before contacting external URLs, Nomi validates and blocks localhost, LAN, and other internal addresses (including obfuscated notations and post-DNS-resolution targets); local or LAN model endpoints require explicit confirmation.

## Implementation

- [Security Boundaries](../development/security.md), [Application Contract](../development/contract.md).
- Core: desktop permissions `apps/desktop-go/internal/core/desktop`, outbound protection `internal/gateway/privacy`, usage and quotas `internal/core/usage`, diagnostics `internal/core/diagnostics`, data export `internal/core/local/hub.go`, window tokens `internal/contract/websocket.go`.
- UI: `packages/ai-chat/src/components/SettingsView` (`PrivacySection.tsx`, `PrivacyModeSettings.tsx`, `DiagnosticsSettings.tsx`), `DesktopPanel`.
