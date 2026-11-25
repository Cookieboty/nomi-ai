# Agents

![Side workspace and session layout](../screenshots/workspace.webp)

> Screenshots are generated from the live UI driven by a mock CLI; chat content and paths are for demonstration only.

Nomi's chat window can serve as a UI for local agents: messages, tool confirmations, permissions, and progress are forwarded to the real CLI, while reasoning and tool execution are handled by the CLI itself. Built-in support covers **Claude Code**, **Codex**, **Grok**, **Gemini CLI**, **dsh**, **Kimi Code**, **MiniMax Code**, and **Antigravity CLI**, and you can also connect any CLI that supports ACP (Agent Client Protocol).

Select an endpoint from the sidebar's **New conversation** menu (or a project row's **New** button) to open an agent tab (`Ctrl/⌘+T`), or pick an installed official CLI directly per conversation inside main chat. Multiple sessions can run concurrently, and active sessions show a status dot at the start of their sidebar row.

## Installation and Versions

The left side of **Settings → Models & Agents → Agents** lists each agent and its status (Not installed / Update available / version number):

- Each agent has a **Version** card for checking updates, one-click installation, and updating to the latest version. Installation and updates use your local Node.js and npm. Clicking runs the command immediately and streams logs in the card; logs collapse automatically and the version updates on success, or remain visible with the failure reason on error. A dialog is shown only if preflight checks fail (for example, Node.js is too old or the global npm directory is not writable). If the global directory lacks write permission, you can install to the user directory instead—Nomi never uses `sudo`.
- **General** checks the runtime environment (prompting with a download link if Node.js is missing, too old, or `npm` cannot be found) and hosts the **Auto-approve All** toggle (see below).

## Official Accounts and Third-Party Providers

Each tab selects its source from the composer's model/source chip, affecting only that tab:

- **Official account**: The CLI's own official sign-in. You can add multiple official accounts: each account gets an isolated config directory, sign-in goes through the CLI's official flow, and Nomi never stores login credentials. The default account is used for new tabs and tabs set to **Follow default**. `dsh` and Gemini CLI do not have Nomi-managed official accounts, so **Default** uses their own configuration: Gemini uses `~/.gemini` from your terminal (API key, Vertex AI, or enterprise license; Google no longer allows Gemini CLI sign-in with personal Google accounts) or can switch to a third-party provider.
  Kimi Code and MiniMax Code sign in with Kimi / MiniMax accounts; if not signed in, the tab prompts you to sign in under **Settings → Models & Agents → Agents**. Antigravity CLI (`agy`) supports signing in and out of its local official Google account inside the app, and does not support Nomi multi-account isolation or third-party gateway models.
- **Third-party**: Any model configured under **Settings → Models & Agents → Third-Party Providers**, routed through Nomi's local gateway with automatic protocol translation. It applies only to the CLI process launched by Nomi and never modifies global configs such as `~/.claude`, `~/.codex`, `~/.grok`, `~/.gemini`, `~/.kimi-code`, or `~/.minimax`; CLIs run directly in your terminal keep using your own configuration.
  When switching third-party models in Kimi Code or MiniMax Code, Nomi restarts the process and resumes the same session.
- **Settings → Models & Agents → Agents → Inherit terminal proxy**: Routes login and chat traffic for all agents through the terminal `https_proxy` (localhost addresses and Nomi's own model requests bypass the proxy). Configured in one place rather than per agent.
- Choose the default source for new tabs under **Settings → Models & Agents → Agents → \<agent\> → New tab**. Set each CLI's default third-party model under **Settings → Models & Agents → Task & Cost Routing**; see [Third-Party Providers & Models](providers.md#agents-using-third-party-models).

## Account Source and Launch Command

For Claude Code, Codex, Grok, Kimi Code, and MiniMax Code, you can configure the account source individually under **Settings → Agents → Assistants → \<agent\> → Account & Launch**:

- **Use local sign-in**: Sign in via the agent's own CLI first, and Nomi uses that existing account directly without adding it again, or creating, syncing, or injecting a Nomi account directory; model environment variables set in your terminal are also preserved.
- **Multi-account managed by Nomi (default)**: Add and select official accounts in Nomi, with an isolated config directory for each account.

By default, Nomi uses the auto-detected CLI without requiring a command. When you need a wrapper script or network forwarder, enable **Advanced: Custom launch command** and enter the executable plus optional leading arguments, such as `claude`. Wrap paths containing spaces in double quotes. Nomi appends the driver's protocol, permission, model, MCP, and session-resume flags after your command; shell pipes, redirections, and variable expansion are not evaluated here, so use a wrapper script if needed. Account source and custom launch command take effect independently—disabling the custom command still preserves **Use local sign-in**, and selecting an account source does not enable a proxy on its own.

`dsh` and Gemini do not currently have Nomi multi-account management and keep their existing third-party model configuration. All third-party models continue to use the existing gateway and launch behavior.

**Test launch** appends only `--version` to the full command; it makes no model requests and does not validate accounts or network connectivity. After saving new settings, open idle official sessions carry over prior context into a new session on the next turn, and newly created sessions use the updated configuration immediately. Disabling the custom launch command does not delete the saved command or account data.

Sign-in detection and subscription quota queries for Claude Code and Codex also use the custom launch command; when **Use local sign-in** is selected, Nomi does not inject its own isolated account directory. Quota availability depends on what the CLI returns; local token and cost records cannot be used to infer remaining subscription quota.

## Permission Modes

The permission mode in the input bar is set per tab (switch via `/mode` or `Shift+Tab`) and unified into five levels mapped to each CLI's native flags:

| Level | Meaning |
| --- | --- |
| Plan | Read-only; no file edits |
| Ask each time | Asks in a card before every change |
| Auto-edit files | Edits files automatically; confirms other actions |
| Auto | Runs most actions without asking |
| Full access | No confirmations; decided by the CLI |

CLIs that do not support a given level fall back to a safer one (`dsh` only supports Plan / Auto-edit files / Full access; Kimi Code has no Auto-edit files; MiniMax Code only supports Plan / Ask each time; Antigravity CLI supports Plan / Ask each time / Auto-edit files / Auto). When confirmation is required, an Allow / Deny card appears in the chat; unanswered requests time out as denied after 2 minutes.
When an agent needs input from you (Claude Code questions, Codex `app-server` prompts, or ACP forms), a unified question card appears above the input bar and is skipped if unanswered after 10 minutes.

**Auto-approve All** (**Settings → Agents → Assistants → General**, on by default): New regular agent tabs start in **Full access**, editing files and running commands without prompting; when turned off, new tabs start in the default mode and ask before each action. Only enable this in folders you trust. For regular background agent tabs launched by recurring tasks: when task authorization is set to L3 (risk-based auto-approval, on by default) and the system sandbox is active (macOS), together with **Auto-approve All** enabled in the foreground, command execution is handled by command review and approved without per-action prompts (on Windows and Linux without a system sandbox, regular background tasks still ask for each action; sandbox blocks and credential requests always prompt—see [Schedules & Tasks](scheduling-calendar.md)). **Agents delegated by Nomi in chat** are not governed by this toggle; they run at the highest level supported by the target agent (usually **Full access**) by default, with the effective level and applicable host protections shown in the approval card.

## Local Protection

Regardless of the permission level, Nomi enforces the following safeguards:

- **System sandbox** (macOS, on by default under **Settings → Nomi → Desktop permissions → Privacy → Agent sandbox**): The agent runs inside a system sandbox that blocks reading sensitive locations (SSH and Git credentials, cloud credentials, keychains, browser data, personal data such as Mail / Messages / Photos, `.env` files, and private keys) and protected folders, and restricts writes to project folders plus its own config and cache. When blocked, a card appears in the chat (as well as in delegated sub-task cards and task details; the desktop character notifies you when the window is in the background) showing what the agent tried to read or write: **Allow for this session** (no further prompts in this session), **Always allow** (saved to settings, revocable under **Privacy**, scoped to this project only), or **Don't allow** (no further prompts in this session). Secret files such as `.env` are authorized per file, granting access only to the specific blocked file. Write access grants the narrowest possible scope (the containing folder or its Git repository); startup items, command directories (such as `~/.local/bin`), and shell configs (such as `~/.zshrc`) can never be authorized for writes. Granted permissions are preserved, and the next message launches and resumes the session with the updated permissions; approving does not automatically send a message or restart a stopped session. Agents are also informed they are running in a sandbox so they stop and explain blocks rather than working around them. When creating a background task, you can pre-check categories to **Pre-allow in agent sandbox** (GitHub outbound actions automatically include SSH and Git credentials) so the task runs without prompts. With the sandbox enabled, you can safely run agents with **Auto-approve All**. Other operating systems do not yet support the system sandbox; the remaining protections below still apply.

- **Working directory**: Must be a project folder. Root directories, the home directory, broad folders like Documents / Desktop / Downloads, system directories, built-in sensitive directories (`.ssh`, `.aws`, etc.), and folders added under **Settings → Nomi → Desktop permissions → Privacy** are rejected. Directories are checked when selecting a folder, opening a new tab, and before every CLI launch; if settings change later, existing tabs with disallowed directories are blocked with an explanation.
- **Environment variables**: CLIs do not inherit tokens, passwords, cloud keys, or database connection strings from your environment (such as `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, or `DATABASE_URL`); model service credentials (`ANTHROPIC_*`, `OPENAI_*`, etc., or cloud accounts when using Bedrock / Vertex) are passed as usual. Variables that are genuinely needed (such as `NPM_TOKEN` for private npm packages) can be added under **Privacy → Allowed environment variables**.
- **Codex network access**: Off by default; commands inside the sandbox cannot access the network. Under **Auto-edit files**, Codex sends a confirmation card before accessing the network or writing outside the workspace. Enabling **Settings → Agents → Permissions → Let Codex use the network** allows direct network access (**Full access** is not subject to this restriction). When Nomi's system sandbox is enabled, Codex does not use its own sandbox and this setting has no effect.

## Side Workspace and Session Layout

Claude Code's local usage aggregation detects the actual config directory returned when the CLI launches, including isolated account directories used by custom launchers. After the first launch, it remembers the log path and continues scanning across restarts; the same message appearing in multiple directories is counted only once.

- **Left**: Unified session list (with project groups and endpoint filters) and **Local history** (past sessions recorded by each CLI, clickable to resume).
- **Center**: Conversation pane; click **View changes** or the title-bar toggle to expand the side workspace, or open files in the standalone file sidebar for focused reading.
- **Right**: Multi-tab side workspace (**Changes · Files · Split Terminal · Run Traces · Embedded Browser · Side Chat**), collapsed by default, with the change count shown on the top-bar toggle.

All dividers can be dragged (positions are remembered) and double-clicked to reset. Select a project above the input box in a new session (with search and project creation); once the first message is sent, it is locked in. The working directory is the project's primary folder, and any additional folders in the project are also exposed to the agent for reading and writing (`--add-dir` / writable directories for Claude Code and Codex, `--include-directories` for Gemini, and `additionalDirectories` for ACP assistants that advertise support; others operate only in the primary folder), with the system sandbox allowing those folders too. You can also switch branches there: click the branch name to search local branches, check one out, or **Create and check out new branch**. The branch selector at the top of the right-hand **Changes** pane controls the same switcher (disabled while an agent is running). If uncommitted changes would be overwritten, Git refuses the checkout so changes are not lost. If no project is selected, the working directory defaults to `Documents/nomi` (created on first use).

### Changes and Git

- When the working directory is a Git repository, **Changes** reflects `git status` grouped into staged, unstaged, and untracked files, with an option to filter to files edited by the agent in the current session. The current branch and upstream branch appear at the top of the right pane.
- You can stage or unstage files directly, discard unstaged changes (saved to `git stash` so they can be recovered), enter a commit message and commit (or have an auxiliary model draft a commit message from the diff), undo unpushed commits, push, and pull (fast-forward only). Nomi never force-pushes and never pops up password prompts.
- **Ask assistant to commit** fills the commit instruction into the input box so you can confirm before sending it to the agent.
- **Files** lists the entire working directory (skipping dependency and cache folders such as `node_modules` and `.next`, and dimming `.gitignore` entries). Clicking a file opens the standalone sidebar with line navigation, source editing, and auto-save; Markdown files support an outline, rendered editing, and focus reading. Reads and writes reject symlinks pointing outside the working directory.
- When a project has multiple folders: **Changes** shows one section per Git repository (titled with the folder name, with the primary folder labeled and sections collapsible); branching, syncing, staging, and committing apply only to that section's repository. Multiple project folders inside the same repository are merged into one section, and non-Git folders are omitted from **Changes**. The badge count at the top is the sum across sections. **Files** shows one top-level node per folder, with the primary folder expanded by default. The full-screen review file tree is also grouped by folder. Typing `@` in the input box suggests paths across all folders, displaying files from secondary folders as `folder-name/path` and inserting the absolute path.

### Turn Edit Summary Card

![Turn edit summary card](../screenshots/v1.2.0-turn-edit.webp)

Whenever an agent edits files in a turn, an **Edited N file(s)** card appears under the message: you can expand inline line-by-line diffs, click **View changes**, open **Full-screen review** (listing all modified files sequentially alongside a file tree), or revert that turn's writes (with confirmation, scoped to the workspace).

### Context Ring

The ring indicator next to the input bar shows current context usage; hovering displays `Current context xK / Max`. Usage comes from the last model request in the current turn. Context window size prefers the value reported by the CLI and falls back to 128K for unrecognized models. `/context` uses the same accounting.

### Sending Messages While Running

You can keep typing while an agent is running: press `Enter` to inject into the current turn, `Ctrl/⌘+Enter` to queue until the current turn finishes, or `Esc` inside the input box to stop the run and send immediately.

### Images

Paste or drag images to send them to Claude Code, Codex, Grok, or Gemini; Nomi warns you if the current model does not support vision. `dsh` does not support images.

## Session Management

- **Switch model / reasoning effort**: The model button in the tab's input bar switches only that tab. CLIs that support in-place switching apply the change without restarting; others restart and resume the same session.
- **Inherit settings on new sessions**: Each agent remembers the last selected permission mode, model, and reasoning effort (**Full access** is not remembered).
- **Hibernation**: Tabs idle for an extended period (30 minutes by default) release their process and display **Hibernated** in the sidebar, resuming automatically on the next message.
- **Fork**: Selecting **Fork…** in the session menu or **Fork from here** at the end of any reply opens the same dialog: fork into a new session on the same endpoint or (when agents are installed) another endpoint, choose how many recent turns of context to include (All / Last 20, 10, 5, or 3 turns), and pick a target project. Forking from a specific reply carries messages only up to that reply and omits later messages; the original session is untouched.

## Supported Agents

Only built-in agents are supported; adding external CLIs is no longer available. External CLIs added in older versions are automatically removed on upgrade: their configurations are deleted, along with any tabs, sidebar sessions, and messages that used them.

## Monitoring and Quotas

- Agents running in your terminal can also be monitored; see [Agent Monitor](agent-monitor.md).
- Official account subscription quotas and usage costs live under **Settings → Usage & analytics**; see [Privacy & Security](privacy-security.md#subscription-quotas-and-sign-in-credentials).

## Implementation

- Design and architecture: [Agent Integration](../development/coding-agents.md).
- Manifests (capability flags, permission levels, install methods): `packages/cli-catalog/src/<cli>/manifest.ts`.
- Core: session orchestration `apps/desktop-go/internal/core/cli/harness`, Git operations `internal/core/cli/gitops.go`, install and updates `internal/core/cli/cli_update_service.go`, official accounts `internal/core/cli/accounts`; session drivers `internal/clisdk`, per-CLI plugins `internal/cliplugins/<cli>`.
- UI: `packages/ai-chat/src/components/SessionWorkspace`, `ProvidersPage`.
- Controlling local apps: When `agent-desktop` is installed (**Settings → Computer Use → Allow agents to use**, on by default), Claude Code, Codex, and ACP agent sessions receive Nomi's `nomi-computer` MCP server; see [Automation & Desktop Capabilities](automation.md#computer-use).

### Image Message Recovery

Agent image messages are synced and persisted through the shared resource pipeline. Original images, Base64 payloads, or accessible file paths provided in history or live protocols are restored as images; image-only messages are preserved as well, while missing or broken images render a placeholder. User attachments support zooming, panning, and switching between images; agent-generated images show recorded generation metadata and expose edit or reference actions where supported by the resource.

History parsing for Claude Code, Codex, Gemini, Grok, and `dsh` supports image recovery. Kimi and MiniMax recover images from generic ACP events and messages already saved by Nomi, as they do not currently have standalone history importers. Whether an original image can be restored depends on whether the source record retained the data and whether the file remains accessible.
