# MCP and Skills

Entry point: **Settings → Extensions / MCP**, or press `Ctrl/⌘+Shift+E` to open the extensions panel. It has two tabs: **MCP Servers** and **Skills**.

## MCP Servers

- Add local command (`stdio`) or remote HTTP / SSE servers in the UI. Built-in presets include three official reference servers (`filesystem`, `memory`, `sequential-thinking`), plus Playwright (official Microsoft preset, operating on the page's accessibility tree without needing a vision model) and Chrome DevTools (official Chrome preset, debugging and controlling Chrome) for web automation. Presets are fetched via `npx` on first connection rather than bundled with the app, so Node.js must be installed locally.
- **Import JSON** accepts standard `{ "mcpServers": { … } }` configs to import multiple servers at once. Imported servers start disconnected so you can review them before enabling.
- Once connected, every tool is listed and tagged as read-only or destructive.
- **Remote server authorization**: HTTP / SSE servers requiring sign-in show **Authorization required**. Clicking **Authorize & connect** completes OAuth login in your browser (with automatic authorization server discovery and PKCE; if a server does not support dynamic client registration, you can enter a Client ID in the server settings). Tokens renew automatically and can be canceled or cleared with **Clear authorization** at any time. Servers with a manually configured `Authorization` header bypass browser OAuth. Changing a server's URL, headers, or Client ID clears existing authorization and requires re-authorizing.
- **Trust levels** (configured per server): **Ask every time** (default), **Auto-approve read-only** (ask for others), or **Auto-approve all** (still logged). Destructive tools always require explicit confirmation in their details.
- Every call is written to the local audit log, viewable under **Settings → Nomi → Desktop permissions → Activity log**.

## Skills (SKILL.md)

- Each folder represents a skill: `SKILL.md` starts with a name and description, followed by instructions for the assistant, and can include reference files.
- Only the name and description of enabled skills are injected into chat; the model reads the full file only when needed, saving context. Skills do not execute scripts. Enabled skills can also be invoked directly in Nomi chat with `/<skill-name>`.
- You can create, edit, enable / disable, delete, or import skills from a folder. Two sample skills are included: `weekly-report` and `meeting-notes`.

## Importing from Other Tools

**Import from other tools** reads local configs from Claude Code (`~/.claude.json`, `.mcp.json`, `~/.claude/skills`) and Codex (`~/.codex/config.toml`, `~/.agents/skills`), listing MCP servers and skills available to select and import. Imported MCP servers stay disconnected by default; skills are copied into Nomi's skills directory without modifying the original files.

## Implementation

- Core: `apps/desktop-go/internal/core/extensions` (`mcpconfig.go`, `service.go`, `migrate.go`, with OAuth in `oauth*.go`).
- OAuth credentials are encrypted per server under `userData/extensions/oauth/`; if OS secure storage is unavailable, authorization is refused rather than falling back to plaintext. Authorization endpoints accept public HTTPS only (except when the server itself is on `127.0.0.1`), require every resolved IP to be non-private, and do not follow redirects. Tokens are sent only to the configured server URL; the browser callback listens only on `127.0.0.1`, validates `state` and `iss`, accepts a single request, and times out after 180 seconds.
- Configuration is stored in `userData/extensions/mcp.json`; environment variables and headers whose names contain `key`, `token`, `secret`, `password`, `auth`, `cookie`, or `credential` are encrypted via OS secure storage and masked in the UI—saving is refused if OS secure storage is unavailable.
- Destructive classification does not blindly trust server self-reports: non-read-only tools on local command servers are always treated as destructive, and remote tools are inferred from hazardous names (`exec`, `delete`, `write`, `shell`, etc.).
- Servers can also be supplied via the `MCP_SERVERS` environment variable (JSON array); they are displayed read-only in the UI and always use **Ask every time**.
- Skills are stored under `userData/skills/<name>/SKILL.md`; reading reference files is restricted to plaintext, capped at 64 KB, and cannot escape the skill directory.
- UI: `packages/ai-chat/src/components/ExtensionsPanel`.
