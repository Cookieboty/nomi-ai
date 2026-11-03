# Composer `@` path mention — design

Date: 2026-11-03  
Package focus: `packages/ai-chat`  
Status: approved for planning

## Goal

In the chat composer, typing `@` opens a workspace path picker (files and directories). Choosing an entry inserts only text of the form `@relative/path` (directories end with `/`). No attachment chips.

## Decisions (locked)

| Topic                      | Choice                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Version note               | No `v2.1.1` exists today; this is a feature on current `main` / 2.1.0 line                   |
| Insert behavior            | Path text only — never create a file attachment chip                                         |
| Path form                  | Relative to conversation workspace root, with leading `@`, e.g. `@src/App.tsx`, `@src/`      |
| No workspace (`cwd` empty) | Do not open the palette; `@` is a normal character                                           |
| Trigger position           | Open for `@` in any position (including mid-email); user closes with Esc if unwanted         |
| Architecture               | Mirror slash palette in `ai-chat` (parse + filter + floating list), reuse workspace tree IPC |
| Selectable entries         | Files and directories; directory insert includes trailing `/`                                |

## Trigger and replace

1. Find the active `@`-mention token: from the caret, walk left to the nearest `@` that starts the current token; the query is the text after that `@` up to the caret (token ends at whitespace / line boundary for the right edge at caret).
2. If the session has a workspace `cwd`, show the path palette filtered by that query; otherwise leave `@` alone.
3. On confirm (Enter / Tab / click): replace the whole `@…` token with `@` + relative path (`/` suffix for directories). Surrounding text is unchanged.
4. Esc closes the palette and keeps the typed `@…` text.

## Data and UI

- **Source:** Current conversation `cwd` workspace tree (same family as `ListWorkspaceTree` / files rail). Reuse existing host IPC; add only a minimal query bridge if the renderer cannot already list paths.
- **Filter:** Case-insensitive substring on relative path; prefer basename hits, then full relative path. Cap list length for responsiveness (implementation plan picks a concrete limit).
- **UI:** Floating list above the composer, aligned with `SlashPalette` patterns (highlight, empty “无匹配文件” / equivalent for paths). Arrow keys move; Enter/Tab select; Esc dismiss.
- **Out of scope (v1):** People/session/skill mentions, attachment chips, multi-root workspaces beyond current cwd, host-native OS autocomplete.

## Implementation sketch

1. Pure helpers: detect active `@` token + query; apply replacement; filter/rank tree entries (unit-tested first).
2. Small palette component (or thin reuse of slash list primitives) bound to MessageInput keyboard handling without breaking `/` slash when both could conceptually apply — `/` remains line-start slash commands; `@` is token-based.
3. Wire workspace tree load/cache from existing harness / IPC when palette opens or cwd changes.
4. Tests: token parse, replace (`@file`, `@dir/`), no-cwd no-open, keyboard select; one MessageInput integration case.

## Success criteria

- With a cwd, typing `@` shows workspace files/dirs; selecting inserts `@rel` or `@rel/`.
- Without a cwd, `@` never opens a palette.
- Existing slash commands, drag/paste attachments, and FileChip flow are unchanged.
- New behavior covered by failing-then-passing tests (TDD).

## Non-goals

Shipping a release tag `v2.1.1` as part of this work; changeset/version bump only if the release process for this repo requires it for the PR.
