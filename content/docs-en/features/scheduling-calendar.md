# Schedule and Tasks

## Schedule

Entry points: "Settings → Knowledge & Memory → Schedule", or open the same tab in the right drawer via the "Knowledge · Memory · Schedule" icon at the bottom of the sidebar or `Ctrl/⌘+Shift+M`. Reminders, scheduled tasks, proactive chat, and do-not-disturb settings all live here.

### Reminders

- One-time or recurring: once, daily, weekdays, specific day of the week, monthly, or every N minutes, plus quick presets like "In 5 minutes" and "Tomorrow at this time".
- You can also ask in chat directly, e.g., "Remind me about standup every weekday at 9 AM".
- When due, Nomi waves and shows a reminder card in her bubble (OK / Snooze 10 minutes). When Nomi is not on the desktop, alerts use the Dynamic Island or system notifications—see "How Alerts Are Delivered" below.
- Reminders missed while the app was closed are delivered on the next launch.

### Scheduled Tasks

Set a name, prompt, schedule, and recurrence rule; when due, the active chat model generates the output, writes it to the chat window, and notifies you per the delivery rules below. The built-in "Daily briefing" template combines today's reminders with your long-term memory. Tasks missed within the last 12 hours run once on startup; you can also click "Run now".

### Proactive Chat (Off by Default)

When enabled, Nomi occasionally initiates a chat while you are idle using topics from your long-term memory. Choose between Low (up to once a day), Medium (3 times), or High (6 times), and optionally restrict it to specific hours. She never interrupts right after you chatted, while you are away from the computer, or during do-not-disturb hours. Click "Try one now" to trigger manually.

### Do Not Disturb

Configure do-not-disturb hours (can span midnight, e.g., `22:30–08:00`). Nothing pops up during this window: due reminders are queued and delivered together once it ends, while scheduled tasks still run and write results silently to the chat window.

### How Alerts Are Delivered

Reminders, scheduled task results, proactive chats, agent updates, and usage budget alerts each appear in only one place:

- **Nomi is on the desktop**: Uses her speech bubble only (reminders show as reminder cards).
- **Nomi is closed or hidden**: Uses the [Dynamic Island](dynamic-island.md); if the Dynamic Island is off, unsupported on the platform, or disabled for that source, falls back to a system notification (clicking opens the chat window).
- **Do-not-disturb hours**: Nothing pops up.

## Tasks

The "Tasks" entry above the sidebar conversation list lets you assign something once: Nomi remembers it, advances it on a schedule or event, and reaches out when your input is needed. A badge shows how many items require your attention.

- **Create**: Say "Every day at 9 AM help me…" in chat, or click "New task" and fill out the form: goal, trigger (once, daily, weekdays, every N minutes, manual, or "when something happens"), assignee (Nomi, an agent, or notification only), allowed capabilities, and completion behavior (auto-accept or wait for your review; defaults to auto-accept). Before creation, an authorization card lists the goal, capabilities, authorized folders, and expiration for your confirmation.
- **Event triggers**: Watch web pages / RSS feeds, GitHub repositories (issue and PR activity, CI completion), read-only tools on local MCP servers, or in-app events (agent turn completed, knowledge base updated). New event-driven tasks initially only record what they observe; enable automatic handling in the task detail pane when ready.
- **Capability levels**: Notification only → Read-only (files, web, local records) → Local write (knowledge base, memory, files in authorized folders) → Run commands (still checked by command review) → External actions (such as commenting on GitHub or opening PRs from a `nomi/` branch; authorized per action and never auto-merged). File reads and writes are restricted to authorized folders. Tasks delegated to an agent can also pre-allow specific sandbox categories (such as cloud account credentials) so they run without prompting; tasks with external GitHub actions automatically include SSH and Git credentials needed to push code. See [agents](coding-agents.md#local-protection).
- **Judge by risk** (L3 and up, on by default): Commands first go through command review (the same mechanism used for automatic command review in chat) and run directly if approved. Only high-risk commands, credential or never-auto-allow commands, commands rejected by review, or actions taken after reading external content (event triggers) pause to ask you. Unchecking "Judge by risk" when creating a task prompts on every command. Where no OS-level agent sandbox is available (Windows / Linux, where `sandbox.Supported()` is false), regular background tasks still confirm each command unless the parent Nomi is in "Auto" mode; with an OS sandbox active and "Auto-approve everything" enabled in the foreground, regular background tasks likewise stop prompting per command (except for credentials, destructive actions, and actions after reading external event content). **Background agent tasks delegated from Nomi chat** always run at the highest permission level the target agent supports ("Full access" for agents that support it, or the highest available level) with risk-based command judgment, regardless of Nomi's own mode, the foreground "Auto-approve everything" toggle, or OS sandbox availability; the pre-approval confirmation card shows the effective permission level and applicable host protections. Command review sends the full command text to the auxiliary model (with secrets, tokens, and local paths redacted first). Approval requests time out after a limit (10 minutes by default), treating timeouts as rejections and marking the task "Interrupted: approval needed" rather than hanging indefinitely on "Waiting for approval".
- **Agent execution**: By default, agents edit directly in the codebase; if parallel tasks in the same repository touch the same file, the higher-priority task edits first. An isolated git worktree is created only when explicitly branching from another ref; on acceptance (when auto-accept is off), small diffs copy back to the workspace while larger diffs commit to a new `nomi/…` branch for you to merge. Tasks of the same kind reuse the previous session. Agents dispatched by Nomi from chat auto-accept on completion and return results directly to the conversation instead of waiting for manual review.
- **Expiration**: Tasks are not cut off by token, duration, or cost limits and run until completion (stalled executions without activity time out); authorizations carry an expiration date and can be renewed before expiring.
- **Review and control**: Status has four buckets: Scheduled / Running / Needs you (waiting for approval, input, review, verification, or failed) / Done. Both list and board views filter by status and search by title and goal. The list uses two-column cards (matching the Agent Board layout), while the board groups columns by status or priority; cards let you run scheduled tasks immediately or pause running ones. Click a card to inspect details on the right: approve, provide input, accept or send back, pause, cancel, revoke authorization, and view run history and event logs. External actions that were in flight when the app closed are automatically reconciled on restart, asking you to confirm only if automatic verification fails. When an agent delegated from Nomi chat finishes, results return to the conversation for follow-up (replying sends it back for rework) and are no longer marked "Waiting for review" on the Agent Board or Dynamic Island; you can still accept or send back from the Tasks page.
- Existing reminders and scheduled tasks also appear as two read-only groups in the list (clicking opens Schedule).

### Apps & Accounts

"Settings → Apps & Accounts" manages external accounts available to tasks. Currently supports GitHub: use your local `gh` login directly or paste a token (a read-only fine-grained token suffices for watching specific repositories). Credentials stay where they live (`gh` or the OS keychain), and tasks can only access them per their granted authorization; removing a connection pauses tasks that depend on it until reauthorized.

## Implementation

- Reminders: `apps/desktop-go/internal/core/desktop/reminders` (`userData/desktop/reminders.json`); scheduled tasks, proactive chat, and do-not-disturb: `internal/core/schedule` (`userData/schedule/`).
- Tasks: `apps/desktop-go/internal/core/tasks` (`userData/tasks/`), event sources in `tasks/event_*.go`; connections: `internal/core/connections`.
- UI: `packages/ai-chat/src/components/SchedulePanel`, `Tasks`, `ConnectionsPanel`.
