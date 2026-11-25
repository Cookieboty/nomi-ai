# Dynamic Island Notifications

When Nomi is not on the desktop, Nomi notifications appear in a Dynamic Island style centered at the top of the screen: expanding from the notch on Macs with a notch, or appearing as a centered top pill on other displays. Click it to open and focus the chat window; press `Esc` or click the close button to dismiss the entire island.

Things waiting for you (agent permission prompts, sandbox blocks, tasks awaiting approval or review, Nomi confirmation requests) stay on the island with action buttons so you can allow or deny right there. Clicking an item (or its "Open" button) opens the chat window and jumps straight to it: task details for tasks, the agent tab for agent requests, or the main chat for Nomi confirmations.

Settings: "Settings → General → Notifications / Dynamic Island".

- **Enable Dynamic Island notifications**: On by default on macOS; optional top pill on Windows / Linux, off by default. When turned off, alerts fall back to system notifications while Nomi is not on the desktop.
- **Notification types** (individually toggleable): Things waiting for you (on by default; see below), Proactive AI messages (proactive chats, daily briefings, etc.), Agents (one notice on completion, confirmation needed, or error, with no mid-run progress updates), and Schedule reminders (due reminders and scheduled task results).
- **Always use top pill**: Centers at the top edge instead of attaching to the notch.
- "Show a preview notification" lets you test the layout.

## Where Notifications Go

Reminders, scheduled task results, proactive chats, agent updates, and usage budget alerts each appear in only one place:

- **Nomi is on the desktop**: Uses her speech bubble only (reminders show as reminder cards), with neither Dynamic Island nor system notifications.
- **Nomi is closed or hidden**: Uses the Dynamic Island; if the Dynamic Island is off, unsupported on the platform, or disabled for that source, falls back to a system notification (clicking opens the chat window).
- **Do-not-disturb hours** ("Settings → Knowledge & Memory → Schedule → Do Not Disturb"): Nothing pops up, and reminders queue until the window ends. macOS Focus has no public API and cannot be detected automatically.
- Notifies once when things finish: no progress bars, periodic summaries, or "N tasks still running" broadcasts; scheduled task results are always written to the chat window.
- **When the Nomi workbench is on screen**: Shows only "Things waiting for you" and "Alerts" (see next section); suppressed notifications do not fall back to system notifications.

## When the Workbench Is on Screen

Each notification is classified first and routed through a single policy check (`Classify` / `ShouldShow` in `internal/core/island/policy.go`, shared by both the Dynamic Island and fallback system notifications):

| Category        | Includes                                                                 | Workbench off-screen | Workbench on-screen (viewing another session / unfocused) | Viewing the notification's own session |
| --------------- | ------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------- | -------------------------------------- |
| Progress        | In progress, periodic summaries, stalled checks                          | Suppress (removed)   | Suppress                                                  | Suppress                               |
| Completion      | Agent finished, turn finished waiting for reply, scheduled task results  | Show                 | Suppress                                                  | Suppress                               |
| Other           | Proactive AI messages, daily briefings                                   | Show                 | Suppress                                                  | Suppress                               |
| Waiting for you | Agent permissions, questions, plan approvals, sandbox blocks, Nomi OKs   | Show                 | Show                                                      | Suppress (card is already in chat)     |
| Alert           | Failures / errors, due reminders, persistent task notices, budget alerts | Show                 | Show                                                      | Suppress (errors appear in chat)       |

- "Workbench on screen" means the chat window is visible and not minimized. Platforms do not expose whether a window is occluded by other windows, so an occluded window still counts as on screen.
- "Viewing the notification's own session" means the chat window is on screen, Nomi is focused, and the active tab matches the notification's tab (Nomi confirmations and questions map to the main chat). Reminders, usage alerts, and agents in external terminals do not belong to any session and are never suppressed by this rule.
- The "Waiting for you" list follows the same rule: items belonging to the session you are currently viewing stay off the island and appear (within 5 seconds) once you switch tabs or leave the window; persistent task items belong to no session and always show.
- When Nomi is on the desktop, she still uses her speech bubble unaffected by this rule; do-not-disturb hours and per-type toggles still apply.

## Things Waiting for You

Listed on the island until handled (shown regardless of whether Nomi is on the desktop and even during do-not-disturb hours, since they block progress). Press `Esc` or click the close button in the top-right corner of the list to hide it temporarily: the items remain pending and can still be handled in chat or on the Tasks page, and they reappear alongside any new item that arrives. Clicked buttons re-enable after 8 seconds if no result arrives. Items handled elsewhere (answering a permission prompt in a tab, confirming in chat, or acting on the Tasks page) disappear from the island immediately; agents delegated from Nomi chat return results to the conversation for follow-up (reply or accept) and no longer stay on the island as "Waiting for review". Buttons share the same entry point as chat and Tasks—acting anywhere clears all places together:

| Source                                                                    | Island buttons                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Agent tool permission                                                     | Allow / Deny                                                                                 |
| Nomi, Claude Code, Codex, or ACP waiting for your answer                  | Open (answer in chat)                                                                        |
| Agent plan awaiting approval                                              | Approve & auto-edit files (or "Execute this plan") / Ask step by step / Keep editing         |
| Agent blocked by sandbox                                                  | Allow for this session / Always allow / Deny; protected folders allow only Deny or Open Settings |
| Persistent task awaiting approval                                         | Approve / Reject                                                                             |
| Persistent task configuration changed                                     | Handled, continue / Give up                                                                  |
| Persistent task you took over                                             | Mark done / Hand back                                                                        |
| Persistent task awaiting review                                           | Accept / Open (send back requires feedback)                                                  |
| Persistent task needing verification                                      | It took effect / It didn't / Open                                                            |
| Nomi confirmation (desktop actions, commands, MCP, handoff, folder scope) | Allow / Deny; actions requiring full review offer "Open" only                                |
| More info needed or reauthorization required                              | Open                                                                                         |

"Open" opens the chat window. A permission request on a task-dispatched agent tab is the same item as that task's "Awaiting approval" and is listed only once under the task.
Agent permission requests already in the waiting list do not trigger a separate "Confirmation needed" notice.

A single item renders as one large pill; multiple items show a header row ("N waiting for you") followed by up to 4 visible items with scrolling for more.
When a regular notification arrives, it stacks at the top of the list and collapses after a few seconds.

## Appearance

- **Macs with a notch**: The top edge attaches flush to the top of the screen, extending downward out of the notch with rounded bottom corners only; content (icon, title, buttons) sits below the notch's bottom edge. Notch mode is always solid black.
- **Screens without a notch / forced pill**: Translucent dark floating pill (440 px wide, 64 px tall for a single item) with four rounded corners and a drop shadow.
- Left side shows Nomi's icon (or the agent's icon for agent events) with a bottom-right badge: spinner while running, green checkmark on completion, red exclamation on failure, amber exclamation when waiting for you, and pink heart for messages.
- Right side shows action buttons for waiting items or a close button for notifications.
- Window height tracks content dynamically (the page reports height changes to the core, which resizes the window), growing with the list so it never holds an invisible transparent area that blocks clicks underneath.
- Expands and collapses over ~0.36 seconds with no bounce; transitions are disabled when the system "Reduce motion" setting is on.
- Does not steal focus, stays visible across all desktop Spaces, and renders content strictly as plain text.

## Implementation

- `apps/desktop-go/internal/core/island`: notification routing in `notify.go`, pending list in `pending.go`, layout geometry in `geometry.go` (pure functions with unit tests), HTML view in `island.html` (embedded into the binary); window management in `internal/shell/wailsshell`.
- Pending-item sources and button wiring: `apps/desktop-go/island_pending.go` (refreshes on tab events, task changes, and confirmation prompt open/close, with a 5-second fallback poll). Details for agent permission prompts are tracked by the orchestrator (`cli/harness/pending_perms.go`).
- Page-to-core `postMessage` signals: `nomi:island:size:<height>` resizes the window, `nomi:island:act:{id, action}` handles button clicks, `nomi:island:open` opens chat, and `nomi:island:hidden` signals hide completion.
- On macOS, the island window is a true borderless window (`MacWindowCornerTypeSquare` in Wails): Wails' default frameless window retains titlebar styling, causing macOS to push it below the menu bar with rounded corners and detach it from the notch.
- In dev builds (`pnpm dev`), "Settings → Debug" previews every style on the real island: each notification type and waiting-list sample (1, 3, or 7 scrolling items, etc.). Samples use `island.debug`, which the core accepts only when `NOMI_DEV_VIEWS` is set; clicking a sample button simply removes the sample.
- Notch presence is inferred from "built-in display + menu bar height", falling back to pill style if uncertain. For debugging, `CD_ISLAND_SIMULATE_NOTCH=1` simulates a notch on any platform.
