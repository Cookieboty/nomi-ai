# Agent Board

The Agent Board lists what is currently running: active Nomi chats answering a turn, Nomi background runs, agents dispatched by Nomi or opened directly by the user, and external agent sessions opened outside Nomi, complete with memory and CPU usage. While the Task Board answers "where does this task stand?", the Agent Board answers "who is running, how many resources are they using, and where are they stuck?"—and the two link to each other.

Core logic lives in `apps/desktop-go/internal/core/fleet`, exposed through the `coding` contract domain (`fleet.state`, `fleet.archive`, and the `fleet.changed` event in `packages/contract/src/app/coding.ts`), with handlers in `internal/core/codinghandlers/fleet.go` and wiring in `fleet_wiring.go`. The UI lives in `packages/ai-chat/src/components/Fleet`.

## Entry Points

- **Agents** in the left navigation bar (alongside Tasks and Library) opens the full board page; the icon shows a badge for items needing your attention, the active count, and a load ring.
- The load indicator on the left side of the title bar (next to the sidebar collapse button) shows `running count · total memory · system CPU`. Click it to open a popover listing active items, or jump straight to the full board.
  When the sidebar is collapsed, the session title yields width to this indicator (`--cd-titlebar-lead-w`).

## Management Scope

| Subject | `scope` | Allowed Actions |
| --- | --- | --- |
| Nomi itself (core process, commands it runs, local models) | — | Not shown as a card |
| Active Nomi chat answering a turn | `managed` | Observe only |
| Nomi background run (recurring task with executor `nomi`) | `managed` | Pausable (task pause) |
| CLI tabs in the orchestrator (chat delegations, task dispatches, direct user tabs) | `managed` | Pausable |
| Agent sessions outside Nomi's process tree (started directly in a terminal or IDE) | `external` | Read-only; alerts only, never interfered with |

Scope is determined by process relationships rather than delegation flags: every tab in the orchestrator (including tabs you opened yourself or took over) counts as managed. External sessions are those discovered by agent monitoring (`internal/core/agents`) from local session files, excluding Nomi's own tab sessions: every session ID used by a tab is recorded (`agents/owned.go`, persisted in `owned-sessions.json`; IDs unseen for 30 days are pruned, and active IDs are flushed to disk at most once per hour based on last-seen time). Even after a tab closes, switches session ID on error, or restarts, sessions dispatched by Nomi will never reappear as "Terminal · Read-only". External sessions are excluded from all control APIs; future pause, stop, or message-injection endpoints only accept managed IDs.
In Mock CLI mode (`NOMI_USE_MOCK_CLI=1`, used for demo screenshots and E2E tests), `OwnProcsOnly` is enabled: processes outside Nomi's process tree are hidden from the board so real local agents and their directories never appear in screenshots.

"Active Nomi chats" come from the chat router (`airouter.Handlers.ActiveChats`): streams carrying `extra.conversationId` (auxiliary calls such as title generation omit it). Titles are resolved by the UI from the session list. Idle Nomi chats do not appear under **In progress**.

## Page Layout

- **Header**: Title, the **Act automatically when memory is low** toggle, and system memory pressure · physical memory · system CPU (background tint shifts under high load).
- **Board**: Status filters (All / To do / In progress / Paused / Done, with live counts), search by title / agent / directory, and filter by agent type.
  Cards are laid out in two columns (one column on narrow viewports), with items needing your input sorted first within each status. Each card shows the agent, status, title, source and directory, queue / pause / error reason, completion summary, time since last activity, and CPU / memory usage. Pause / Resume lives in the upper-right corner of the card; finished managed tabs show **Close tab** in the lower-right corner (with confirmation); actions to open the tab / task / chat or archive live in the `⋯` menu.
  Because the core does not report completion percentages, the status bar at the bottom of a card never fakes progress: **In progress** shows an animated accent strip, while **Done** shows a solid `success` bar.
- **Below the header**: The most recent memory governor action (within the last 10 minutes).
- **Bottom bar**: Scheduling policy (see below).
- **Below the board**: Idle process list.

## Statuses

There are only four statuses, with no historical log retained. Managed and external items share the board (external cards use a dashed border and have no action buttons):

| Status | Sources |
| --- | --- |
| To do (`todo`) | Queued tabs; queued CLI tasks waiting to open a tab; queued Nomi background runs |
| In progress (`running`) | Actively running items; items waiting for approval (`needsYou: permission`), blocked by the sandbox (`sandbox`), or waiting on a question (`question`, labeled **Waiting for you**) also stay here |
| Paused (`paused`) | Frozen CLI tabs—paused automatically by the memory governor (`paused.by: memory`), manually by the user (`user`), or by Nomi (`nomi`); paused background runs |
| Done (`done`) | Finished tabs, background runs, and external sessions (an external session waiting for your reply means its turn finished, so it lands here); items awaiting acceptance (`needsYou: accept`) or errored (`failed`) |

- **To do** cards state why execution hasn't started yet (`queueReason`): `memory` (held by the memory governor due to memory pressure), `retry` (waiting to retry after a failure, with `retryAt`), or `slot` (waiting on earlier work because the concurrency cap, hourly launch cap, or orchestrator active-tab limit is full). Normally dispatched work starts immediately, so **To do** is usually empty.
- Never-run empty tabs, `idle` recurring tasks waiting for their next trigger, and `idle` external sessions are omitted from the board; external sessions marked as running whose process has exited are treated as **Done**.
- Finished items can be archived (`fleet.archive`): this only removes them from the board without touching the tab or session, and they reappear if they start running again; items still needing user action cannot be archived. Archive state is kept in memory only. Finished items with no activity for two hours are automatically hidden.

## Resource Usage

- **Process table** (`internal/core/agents/proctable.go`) reads parent PID, resident memory, and cumulative CPU time for all processes in a single pass. On macOS it calls `libproc` and `KERN_PROCARGS2` directly (`procnative_darwin.go`, ~4 ms, no subprocesses); on Windows it uses a Toolhelp snapshot plus per-process `GetProcessTimes`, memory queries, and `NtQueryInformationProcess` for command lines (`procnative_windows.go`), falling back to `ps` or PowerShell `Win32_Process` when unavailable; on Linux it uses `ps`. Per-agent CPU is computed as the delta in cumulative CPU time across two samples divided by the elapsed interval (`100` = one full core, matching Activity Monitor's `% CPU` column) rather than `ps`'s `%cpu`.
- The process list is shared across callers for 5 seconds (`agents.ProcessesShareTTL`): the board and agent progress monitor read on their own timers without spawning duplicate `ps` or PowerShell calls. When the progress monitor (runs every 8 seconds) finds no agent processes, it re-reads the process table at most once every 30 seconds (`agents.IdleProcsMs`) while continuing to scan session files every tick—so newly opened terminal agents appear within at most 30 seconds.
- **System CPU** (`system.cpuPercent`, 0–100 across all cores, matching Activity Monitor's System + User total) reads OS counters (`agents.SystemCPU`: `host_statistics` on macOS, `/proc/stat` on Linux, `GetSystemTimes` on Windows). When unavailable (such as non-cgo macOS builds), it falls back to summing process CPU divided by core count, which misses short-lived processes that exited between samples and `kernel_task`.
- **Tab processes**: The orchestrator records the spawned PID per tab in `spawnCLI` (`Orchestrator.TabPids`) and expands the full process tree from the process table; each PID is counted once.
- **Nomi itself**: Nomi's own process tree minus all tab process trees. Nomi chats and background runs execute inside the core process, so individual per-item `usage` is not available.
- **External processes**: Agent processes are grouped by process tree (`agents.AgentTrees`, so an agent spawned inside another agent counts toward the same tree). Processes that register an active session (such as Claude Code's `~/.claude/sessions/<pid>.json`, `agents.Service.ProcSessions`) map exclusively to that session; a newly opened process with no session file yet (no message sent) counts as idle instead of claiming an older session in the same directory. Remaining trees are claimed by external sessions matching the same agent type and working directory (`agents.Service.ProcCwds`), prioritizing running sessions. Unclaimed trees (open in a terminal or IDE with no active session) are placed in `externalIdle.items`, listed one per row under **Idle processes** below the board.

## Closing Idle Processes Manually

External sessions are strictly read-only, with one exception: you can manually close idle external processes (`fleet.closeIdle`, `dangerous`). Click **Close** on a row to stop one process, or check multiple rows (or select all) and click **Close selected** to batch-close them. After one confirmation, the UI invokes `fleet.closeIdle` for each item and lists a per-row reason for any that could not be closed. For each item, the core re-reads the process table to verify that the PID is still the root of an idle tree for the same agent type and not inside Nomi's process tree (if it started a session, exited, or had its PID reused, it returns `FLEET_NOT_IDLE`), then sends `SIGTERM` to the tree (children first) and `SIGKILL` after 3 seconds if still alive. Verification only trusts a fresh process table read taken after the click: if reading fails (e.g., PowerShell timeout on Windows), it retries once and returns `FLEET_CLOSE_UNVERIFIED` without sending any signal—never verifying against a cached board snapshot. Neither the scheduler nor the memory governor ever invokes this.

## Sampling

- Sampling happens on demand and is reused within 1 second. The UI polls `fleet.state` every 3 seconds while the board or popover is open, every 15 seconds otherwise, and stops polling when the window is hidden.
  `fleet.changed` is pushed whenever a tab, task, external session, or chat stream starts or ends.
- Known limitations: `ps` resident memory excludes compressed memory; Linux process CPU time has 1-second resolution; reading the process table once on Windows is relatively slow.

## Scheduling Policy

Defined in `internal/core/fleet/policy.go`. Sets the combined concurrency cap for agents dispatched by Nomi and background tasks. Users pick one of three presets at the bottom of the board (`fleet.setPolicy`, persisted alongside the auto-manage toggle in `fleet/settings.json`), taking effect immediately:

| Preset | Concurrency Cap |
| --- | --- |
| Save resources (`saver`) | Up to 5 combined |
| Balanced (`balanced`) | Up to 10 combined (default) |
| Full speed (`max`) | Unlimited count: new work queues when memory pressure is elevated/critical or system CPU ≥ 85%, and starts automatically once load eases |

The concurrency limit spans both synchronous delegations and recurring tasks (including background delegations): both sides receive the cap (`delegate.SetMaxParallel` / `tasks.Runtime.SetMaxConcurrent`), count the other side's active runs when checking capacity (`SetSharedLoad`, reading the peer's atomic counter without acquiring its lock), and trigger a queue re-evaluation on the other side whenever a slot frees up (`SetOnFreed`). Synchronous delegations and follow-ups triggered inside a background Nomi run do not queue; instead they borrow their parent task's slot (`delegate.borrowSlot`, at most one child at a time per parent task, without double-counting), preventing deadlock when all slots are held by parent tasks waiting on child results (#294). Tabs opened directly by the user and external terminal/IDE sessions are not counted. Under the two fixed-cap presets, excess work queues (`queueReason: slot` under **To do**) rather than failing; lowering the cap does not interrupt running items, and raising it starts queued items immediately. **Full speed** holds work by resource state (`Holding`, independent of the auto-manage toggle; system CPU is computed every 5 seconds by the memory governor from `agents.SystemCPU` counter deltas), setting `queueReason` to `memory` or `cpu`; synchronous delegations in foreground chat return `memory_pressure` under this condition. The runaway safeguard limiting recurring tasks to at most 30 launches per hour applies regardless of preset. Preset names and values are supplied by the core in `policy` / `policyOptions` on `fleet.state` and rendered directly by the UI.

## Memory Governor

Defined in `internal/core/fleet/governor.go`. Reads system memory pressure every 5 seconds (`agents.SystemMemory`: `kern.memorystatus_vm_pressure_level` and `kern.memorystatus_level` on macOS; `MemAvailable` and PSI on Linux; `GlobalMemoryStatusEx` on Windows with < 15% free = warning and < 7% free = critical) and acts only on managed CLI tabs—never touching external sessions. When the upper-right toggle (**Act automatically when memory is low**, `fleet.setAutoPause`, persisted in `userData/fleet/settings.json`, on by default) is turned off, the governor stops acting automatically and resumes tabs it had paused; tabs paused by Nomi are not resumed and continue waiting for memory to recover.

| Pressure | Action |
| --- | --- |
| Warning or above | Immediately reclaims CLI processes of tabs idle ≥ 1 minute (`Orchestrator.ReclaimIdleNow`, sharing idle-reclaim rules; sessions stay intact, lossless); repeats once per minute while pressure persists |
| Critical | Freezes one running tab every 10 seconds: tabs dispatched by Nomi (chat delegations, tasks) before user-opened tabs, highest memory first within each tier; skips tabs resumed within the last 2 minutes and the tab the user is currently viewing (when the window is in the foreground) |
| Normal and stable for 30s | Resumes one tab paused by the memory governor or by Nomi every 20 seconds (oldest paused first); tabs manually paused by the user are never auto-resumed |

Freezing sends `SIGSTOP` / `NtSuspendProcess` (`Orchestrator.FreezeTab`, with the process tree expanded from the process table, parent first): the process uses zero CPU and its memory can be compressed or paged out by the OS. On resume (`ThawTab`, children first), the current turn picks up seamlessly where it left off, invisible to delegations and recurring tasks. Because frozen processes cannot handle interrupts or accept input, the orchestrator always thaws them before stopping, closing, sending messages, injecting input, approving prompts, or tearing down processes, and thaws all frozen tabs on exit (`Dispose`). Cards also expose manual **Pause / Resume** buttons (`fleet.pause` / `fleet.resume`). The line below the board header shows the most recent governor action within the last 10 minutes. Nomi chats and background Nomi runs execute inside the core process and cannot be frozen.

Pause / Resume on background runs maps to task pause (`fleet.pause` / `fleet.resume` translates `run:<taskId>` into task `pause` / `resume` commands through the same `tasks.Service.Command` entry point as the Task Board): scheduling stops, the in-flight turn finishes (the card stays in **In progress** labeled **Pauses after this turn**), and the run then moves to **Paused** without starting new turns until resumed by the user or `resume_agent`; memory recovery never auto-resumes it and the memory governor does not touch it. Only running or queued runs that are not waiting on user input can be paused; active foreground chats are observe-only; runs stopped automatically after consecutive failures do not count as paused and do not appear on the board. Who paused an item (`user` / `nomi`) is held only in the board service's memory and resets to `user` across restarts.

## Nomi Dispatching

- **Tools** (`internal/core/fleet/tools.go`, registered in Nomi's tool table and exposed only when the conversation touches agents, memory, slowdowns, pausing, or dispatched work):
  `list_agents` (reports pressure, free percentage, system CPU, Nomi's own usage, and all agents, marking external ones `readOnly`) and `pause_agent` / `resume_agent` (only for managed, pausable items; rejects external sessions, active foreground chats, and items waiting on user input with an explanation). Agents paused by Nomi (`paused.by: nomi`) behave like governor-paused tabs and auto-resume once memory returns to normal so they are never stranded; background runs paused by Nomi wait for manual resume.
- **Admission control**: When memory is critical and auto-management is enabled, the memory governor holds back new work. The task runtime checks `Admit` (`tasks.Runtime.SetAdmit`) before starting execution, keeping agent tasks and background Nomi tasks in the queue (`queueReason: memory` under **To do**) while notification-only tasks proceed normally; once pressure clears, the queue is re-evaluated immediately (`OnRelease` → `Runtime.Tick`). For synchronous delegations, background Nomi runs wait for pressure to ease, while foreground chats receive `memory_pressure` so Nomi can switch to background delegation. The dispatching prompt also instructs Nomi to call `list_agents` first when the system feels sluggish or before dispatching multiple agents at once.
- **Dispatch tree**: Background Nomi runs carry their task ID on the context (`tasks.WithRunTask`). Any agent tab delegated from that run records `parentTaskId`, and its board card displays `Dispatched by "…"` (`parentId`).

## Threading

`fleet.*` avoids entering the JS runtime GIL unnecessarily: recurring tasks' `Runtime.List` is read outside the GIL (the runtime holder might be waiting on the GIL), and `jsrt.Call` enters the GIL only when reading tabs and agent monitor state. Chat router stream start/end notifications run on a separate goroutine so they never block the stream.
