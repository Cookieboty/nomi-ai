# Agent Integration

Nomi drives Claude Code, Codex, Gemini CLI, Grok, and dsh as subprocesses and presents them as "tabs" in the chat window. See [features/coding-agents.md](../features/coding-agents.md) for user-facing documentation; this page covers the implementation.

```
View (ai-chat tab) ──Contract harness.* / cli.*──▶ Orchestrator (internal/core/cli/harness)
                                                     │  Launch args, env, permission modes ← Plugin (internal/cliplugins/<cli>)
                                                     ▼
                                             Session Driver (internal/clisdk/drivers) ──stdio──▶ CLI Subprocess
                                                                                                   │ When source is third-party
                                                                                                   ▼
                                                                                    Unified Gateway (nomi-tab- token, see gateway.md)
```

## Components

| Location | Role |
| --- | --- |
| `packages/cli-catalog` | Manifests (ID, capability flags, session transport, permission mode mapping) and UI metadata for each built-in CLI, pure data; used by both views and core |
| `apps/desktop-go/internal/clisdk` | Plugin contract (manifest validation, capability interfaces, multi-option permission replies), external ACP plugins, subprocess launch (`launch/`), and JSON-RPC (`rpc/`) |
| `apps/desktop-go/internal/clisdk/drivers` | Four session drivers: `acp`, `streamjson`, `appserver`, `exec` |
| `apps/desktop-go/internal/cliplugins/<cli>` | Built-in plugins: launch injection, permission modes, official account catalog, history transcript parsing, model catalog, slash commands; shared helpers live in `shared/` |
| `apps/desktop-go/internal/core/cli/sandbox` | OS-level sandbox (macOS Seatbelt): per-tab profile generation, violation log monitoring, and classification; see [security.md "Agents"](security.md#agents-cli-subprocesses) |
| `apps/desktop-go/internal/core/cli/harness` | Orchestrator: tabs, persistence, source (official / third-party), permission queue, steer, idle recycling, upgrade restarts |
| `apps/desktop-go/internal/core/cli/accounts` | Official accounts: detect accounts logged in via terminal, import, sign in, switch (per-CLI isolated HOME / keychain) |
| `apps/desktop-go/internal/core/cli/delegate` | Nomi task delegation to agents (`delegate_to_cli`): in-place edits + per-file arbitration, worktree when targeting a different base branch, session reuse |
| `apps/desktop-go/internal/core/cli` (other) | CLI probing and versioning, install/update, session history, git operations (changes panel), slash command discovery, workspace files |
| `apps/desktop-go/internal/core/codinghandlers` | Agent-related contract procedures |

Tab messages are persisted in `harness/tabs/<tab>.json` (up to 300 messages, with a 200 ms write debounce). The core keeps only the 6 most recently read tabs in memory (`MaxCachedTabMessages`), evicting older ones after synchronous operations complete; running/queued tabs, tabs with unflushed writes, and the active tab are exempt from eviction and reload from disk when read again.

## Session Transports

| CLI | Transport | Fallback |
| --- | --- | --- |
| Claude Code | `stream-json` | `exec` |
| Codex | `app-server` (JSON-RPC) | `exec` |
| Gemini CLI | `acp` | — |
| Grok | `acp` | `exec` |
| dsh | `exec` | — |
| Kimi Code | `acp` | — |
| MiniMax | `acp` | — |
| Antigravity CLI | `acp` | — |

Transports are declared via `transport` / `fallbackTransport` in `packages/cli-catalog/src/<cli>/manifest.ts`.

User-added "external CLIs" are no longer supported (the settings entry, `cli.pluginAdd / pluginRemove / pluginTest`, and `backend: 'external'` tabs have all been removed). Legacy data from older versions is handled on startup: manifests in `userData/cli-plugins/external/` are deleted; `backend: 'external'` tabs are no longer restored (along with their messages and resume files); sidebar sessions bound to those tabs are removed when the tab is closed; a stored "external CLI" selection in the view falls back to the first agent, and any remaining `backend: 'external'` records fall back to Nomi as an invalid backend.

Protocol details live inside the drivers; per-CLI differences (stream event parsing, history transcripts, model catalogs, slash-command layouts) live inside each plugin. The orchestrator branches on manifest capability flags rather than CLI names (enforced on the view side by the ESLint rule `nomi/no-cli-literal`, with an allowlist in `scripts/eslint/cli-literal-allowlist.mjs`).

## Built-in Agent Registry

**Single source of truth for data**: Declarative metadata for every built-in CLI lives in `packages/cli-catalog/src/<id>/manifest.ts` — capability flags, transport, executables and npm package, permission mode -> native mode mappings, display name and `fullName`, config file path (`configPath`), and core runtime metadata (`host`: minimum Node version, self-update method, official vendor, ACP launch args, plan follow-up, whether a `nomi-<id>` command exists). UI and list ordering is defined by `BUILTIN_CLI_ORDER`. The Go core reads `internal/cliplugins/catalog/catalog.json` generated from it (`pnpm -F @nomi-ai/cli-catalog gen:go`; `tests/go-catalog.test.ts` verifies it is up to date) rather than maintaining a hand-written Go manifest.

**Go registers code only**: `internal/cliplugins/<id>/` implements the main-process logic (`CreateMain()`: official/third-party launch, account catalog, slash commands, etc.), and `builtin.entries` registers it along with transcript parsing. Everything in the core that needs per-CLI handling reads from `internal/cliplugins/builtin`:

| Need | Source |
| --- | --- |
| Which built-in CLIs exist | `builtin.IDs` (sorted by ID), `builtin.Ordered` (UI and list order) |
| Plugin capabilities (permissions, accounts, history, slash commands, terminal, etc.) | `builtin.Impl(id)` (each plugin's `CreateMain()`, instantiated once) |
| Display name | `builtin.DisplayName` ("Gemini"), `builtin.FullName` ("Gemini CLI": Agent Board, Usage, Dynamic Island) |
| Manifest capability flags, transport, executables, npm package | `builtin.Capability`, `builtin.UsesAcp`, `builtin.Binaries`, `builtin.NpmPackage` |
| Manifest `host` section | `builtin.MinNode`, `SelfUpdate`, `Vendor`, `AcpArgs`, `PlanFollowUp`, `NomiCommand` |
| Capability-filtered lists | `builtin.Where(builtin.WithAccounts / WithHistory / WithQuota / WithThirdParty / LocalOnly / All)` |

Views use `BUILTIN_CLI_ORDER`, `cliCapability`, `cliName`, `cliFullName`, `cliConfigPath`, and `byCli` from `@nomi-ai/cli-catalog`. Permission capabilities for ACP agents are derived from the manifest (`shared.AcpPermissions`) rather than duplicated in Go. Two guard tests block hardcoded lists (3 or more built-in IDs on one line or across adjacent lines): `internal/cliplugins/builtin/hardcoded_test.go` on the Go side and `packages/cli-catalog/tests/no-hardcoded-lists.test.ts` on the view side. Implementations that genuinely apply only to specific CLIs (quota queries, usage log parsing, brand icons, gateway client entries) are registered in the test allowlists with an explicit reason. `builtin_test.go` verifies a one-to-one correspondence between code entries and manifests, and that manifest `history` flags match the implementation.

Adding a built-in agent (using ACP as an example):

1. `packages/cli-catalog/src/<id>/`: add `manifest.ts` and `renderer.ts`; append to `BUILTIN_CLI_ORDER`; run `gen:ids` and `gen:go`.
2. `apps/desktop-go/internal/cliplugins/<id>/`: add `manifest.go` (two lines: pulled from catalog) and `CreateMain()`; register in `builtin.entries`.
3. Add the brand icon (`packages/ui/src/brand/endpointGlyphs.ts` and the copy in the Dynamic Island page), English/Chinese i18n strings, and documentation.

Lists, display names, detection, installation and updates, Agent Board process recognition, delegation, ACP launch, and settings pages will all pick it up automatically; add quota queries or usage log parsing in their respective places if needed.

Third-party models: set `thirdParty: true` in the manifest, and have the plugin implement `Launch.ThirdParty`, returning a private home directory (`PrivateHome`: environment variables and unlinked entries) and config files to write (`Files`). `gwstore/agents.AgentLaunchFor` calls it for CLIs without a dedicated handler, creates the private home directory, and writes the files (`0600`). CLIs without a dedicated gateway entry use the generic entry (`clients.GenericSpec`: lenient validation, mapping unknown model names to the primary model). The model is written into the config file; switching models restarts the process and resumes via `session/load`. `nomi-<cli>` commands in the terminal require launch script support (manifest `host.nomiCommand`).

## Projects

A project (`internal/core/projects`, `userData/projects.json`, contract `project.*` / `project.changed`) is a named group of folders: `primary` is the primary folder and `folders` holds additional folders. The model aligns with ACP's [Additional Directories](https://agentclientprotocol.com/rfds/additional-directories): `cwd` remains the primary directory and anchor for relative paths, while additional folders expand read/write scope; git, worktrees, and `AGENTS.md` look only at the primary folder.

- **Sessions store only `projectId`**: Nomi chats store it in conversation metadata, and agents store it in the tab object (`tabs.json`). Paths are never persisted in sessions; every time they are used, `Store.Roots(id)` fetches them live and re-validates them against workspace root rules: if the primary folder is unavailable, the whole project is unavailable; if an additional folder is unavailable, it is skipped.
- **Nomi**: `desktop.ApplyConversationWorkspace` resolves `desktop.Workspace` from `extra.projectId` and rewrites `extra.cwd` to the primary folder (discarding any path supplied by the view). File tools re-resolve via `ExecContext.ProjectID` on each call (`PermissionBroker.WorkspaceOf`), with guard scopes covering all folders (`Workspace.Scopes`).
- **Agents**: The working directory is the primary folder (except for delegated worktree tabs). Additional folders are fetched on each launch by `Orchestrator.extraDirs`: `--add-dir` for Claude Code, per-turn `sandboxPolicy.writableRoots` for Codex app-server (`-c sandbox_workspace_write.writable_roots` for exec fallback), `--include-directories` for Gemini, and `session/new` / `session/load` for other ACP agents declaring `sessionCapabilities.additionalDirectories`; Nomi's OS sandbox also adds them as writable directories. When a project changes (`Store.OnChange` -> `Orchestrator.ProjectChanged`), idle tabs disconnect persistent processes and restart with the new folders on the next turn while resuming the same session; if the primary folder changed, the working directory updates and prior context is carried over.
- **Right panel**: The view passes all project folders (working directory first) to `SessionChangesPanel` / middle-column Diff / full-screen review / `@` path completion, and each folder calls `harness.workspaceList` / `harness.gitDiff` as usual (the core resolves directories by project folder). Changes mounts one `RepoGitSection` per folder, deduplicated by the `gitRoot` returned by `gitDiff`; single-folder projects preserve the original layout. `gitDiff`'s 7 `git diff` commands and `rev-parse` run in parallel inside the core. For the Changes line in session details (size summary only), `harness.gitSummary` runs just `status` + `diff --numstat HEAD` without diff bodies, sharing in-flight requests per directory. Refreshes on window focus (changes, branch, upstream, worktrees) are routed through `utils/focusRefresh.ts` and throttled to at most once every 5 seconds.
- **Delegation and tasks**: `delegate_to_cli` / `delegate_to_nomi` pass the project into new tabs and tasks (`ExecutorSpec.Project`); Nomi background tasks follow the same path via `extra.projectId`.
- **File preview**: File links in sessions open via `harness.previewOpen`. If a file is outside the session's working directory but inside one of a project's folders (another folder of the same project or another project), the core fetches that project's currently available folders via `resourcepreview.Service.ProjectRoots` and picks the deepest matching folder as an editable root without requiring per-file authorization. Files outside all projects still require user confirmation and open read-only once confirmed.
- **Migration**: `migrateToProjects` creates single-folder projects from each conversation metadata `cwd`, tab directory, and background task directory, and updates sessions to reference `projectId`. It runs whenever `projects.json` does not exist or `userData/projects-migration.pending` remains (from an interrupted run); every step is idempotent, and the marker is removed only after full completion. Only conversations successfully migrated drop `cwd`; conversations whose directories are currently unavailable (unmounted external drive, offline network share) retain `cwd` and retry on subsequent launches.

## Permission Modes

Manifest modes: `plan`, `manual`, `acceptEdits`, `auto`, `bypass` (`packages/cli-catalog/src/manifest.ts`). Each CLI maps them to its own launch flags or session mode (`session/set_mode` in ACP). Tool calls requiring confirmation enter the orchestrator's permission queue (`permissionqueue.go`) and are answered in the view; replies can be multi-option (allow once / this session / deny).

Structured questions do not enter the permission queue; they go through `internal/core/askuser` question cards (above the chat input bar, 10-minute timeout): Claude Code's `AskUserQuestion`, Codex app-server's `item/tool/requestUserInput`, Codex's form-based `mcpServer/elicitation/request`, and ACP's `elicitation/create` (advertising `elicitation.form` during handshake). Answers, skips, cancellations, and timeouts are written back in each protocol's native format. When Codex wraps an MCP tool approval as an elicitation (`codex_approval_kind: mcp_tool_call`), it still routes through allow/deny; URL elicitations are cancelled immediately. Codex's `exec` fallback has no interactive back-channel. MCP servers connected directly by Nomi do not advertise elicitation and do not enter this card.

## Sources and Tab Tokens

- **Official**: The CLI uses an official account managed by Nomi (each account has an isolated config directory, and login is performed by the CLI itself; see `accounts/`). "Local login" is no longer supported: built-in agents do not use the machine's default CLI login directory; agents without official account support (`dsh`, Gemini) only have third-party sources. Legacy `local-<kind>` records are deleted on read, and tabs or "default for new sessions" preferences pointing to them switch to follow the default official account.
- **Third-party**: The CLI points to the local unified gateway. Before launch, the orchestrator issues a `nomi-tab-` token and registers a binding (tab, generation, model, thinking depth), waiting for confirmation before starting the process. Switching models or third-party providers re-registers the binding and takes effect on the next turn.

Official account sign-in: Codex uses device code flow — once the UI receives the sign-in URL and device code, it automatically opens the browser only once. Grok uses the `grok login --oauth` browser callback flow, where the CLI opens the browser. The sign-in modal does not inherit the settings page's embedded mode and only responds to an active sign-in initiated from the current page that has not been closed; late events arriving after close do not reopen the modal, and launch responses do not overwrite earlier sign-in progress.

## Subtasks (Tabs Delegated by Nomi)

- Subtask drawer (`packages/ai-chat/src/components/SubagentPane`, state in `contexts/SubagentPaneContext`): the main column stays on the source conversation. Delegated tabs use `CliConversation` + `MessageInput`, calling `sendToTab` / `replyPermissionFor` / `cancelRun` by tab ID without calling `activate`. In-process subagents show steps from the parent transcript whose `parentId` points to them; `delegate_to_nomi` renders `tasks.trace`. See [docs/design/subagent-chat-parity.md](../design/subagent-chat-parity.md) for design details.
- Takeover: sending a message while a delegation is actively running counts as taking over (interrupting Nomi's turn, `delegation.takenOver`); sending while idle simply continues the conversation without marking a takeover.
- Reporting: `TabFinished.Origin` records who initiated the turn (`user` / `sandbox` / programmatic). Turns sent by the user or resumed after sandbox authorization are handed by `coding_wiring.go` to `delegate.ReportFollowUp`, returning to the source conversation via `delegate.completed` (`followUp: true`); delegation's own turns are reported by `finalize`.

## Local Protection

Working directory policies, environment variable scrubbing, Codex network disabled by default, OS-level sandboxing, and per-session grants: see [security.md "Agents"](security.md#agents-cli-subprocesses).

## Testing

- Mock CLIs live in `scripts/mock-cli/mock-<cli>.mjs` at the repo root. When `NOMI_USE_MOCK_CLI=1`, `cli.MockCliBin` searches upward from the current directory for `scripts/mock-cli` (so it works even when `pnpm dev` runs from `apps/desktop-go`) and uses them in place of real CLIs. If the file is missing, the CLI is treated as not installed.
- Unit tests for the orchestrator, drivers, and plugins live in their respective packages (`go test ./internal/core/cli/... ./internal/clisdk/... ./internal/cliplugins/...`). Subprocess tests wait on explicit conditions (with descriptive timeouts) rather than counting polling iterations.
