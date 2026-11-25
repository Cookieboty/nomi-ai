# Agent Monitor

Nomi can watch agents running locally on your machine (including sessions launched directly in a terminal) and notify you once when a task finishes, fails, or completes a turn and is waiting for your reply—without broadcasting mid-turn progress.

When multiple agents finish or fail within 1.5 seconds of each other, Nomi combines them into a single notification instead of interrupting repeatedly; prompts waiting for your action are never merged and pop up immediately. Sessions managed in Nomi's own agent tabs notify only once on the tab side. Idle session files touched by a CLI during exit or cleanup do not trigger another completion alert, and an initial environment stub created by Gemini before you have sent a message is not counted as a session.

Location: **Settings → Agents → Monitor & sessions**. Here you'll find the master **Watch agent progress** toggle, per-agent toggles, detected tools, **Scan now**, and the active session list (Nomi's own agent tabs can be opened directly from the list). Notification style and types are configured under **Settings → General → Notifications / Dynamic Island**, and Do Not Disturb hours live under **Schedules**.

## Supported Tools

Claude Code, Codex, `dsh`, Grok, Gemini CLI, Kimi Code, and MiniMax Code—each can be toggled on or off individually.

## Statuses

- **In progress**: Session file was recently written to and the process is still running.
- **Waiting for you**: The current turn has finished and the process is still running.
- **May be stuck**: The process is still running, but there have been no updates for an extended period (5 minutes by default; shown in the list only, with no notification).
- **Done / Failed / Ended**.

Sessions are deduplicated by session ID; historical sessions discovered for the first time never trigger notifications—alerts fire only on status transitions.

## When Notifications Fire

- **Notify once at completion**: Starting, in-progress, and potentially stuck states are shown only in the list with no alert or speech; completion, failure, and waiting-for-reply trigger a single notification, while confirmation requests trigger immediately.
- The legacy 10-minute periodic summary ("N coding tasks still in progress") and its timer have been removed; there are no mid-run progress broadcasts.
- **Read aloud** (off by default): When enabled, reads the outcome aloud in addition to playing the notification sound, respecting the voice toggle and mute state.
- When the Nomi workbench is visible on screen, completion alerts do not pop up the Dynamic Island—only confirmation-needed and failure alerts do—and the tab you are currently viewing suppresses all popups (see [Dynamic Island](dynamic-island.md#when-the-workbench-is-on-screen)).
- When Nomi is visible on the desktop, notifications appear in her speech bubble; otherwise they use the [Dynamic Island](dynamic-island.md), falling back to system notifications if the Dynamic Island is unavailable.

## Principles

Nomi only reads session and log files already written locally by these tools and checks whether the corresponding processes are running; it never signs in or accesses any remote accounts.

## Implementation

- `apps/desktop-go/internal/core/agents`: process detection `processes.go`, session scanning `fsscan.go`, per-tool session parsers `parsers.go`, defaults `settings.go`. Grok status is inferred solely from file modification times and process presence.
- UI: `packages/ai-chat/src/components/CodingMonitor`.
