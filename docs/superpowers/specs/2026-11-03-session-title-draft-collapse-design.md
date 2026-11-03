# Session smart title, draft isolation, sidebar collapses — design

Date: 2026-11-03 (Asia/Singapore)  
Package focus: `packages/ai-chat`, `apps/desktop-electron` harness, `apps/desktop-go` harness  
Status: approved for planning  
Explore map: `/workspace/nomi-explore-session-draft.md` (symbols below cite that map and current `main`)

## Goal

1. **Smart titles:** After the first user message in a Nomi chat or a CLI agent tab, generate a short Grok-style title with the **currently selected model** (background short prompt). On failure, fall back to the first ~30 characters of the user text. Never overwrite a manual rename.
2. **Composer draft isolation:** All empty / never-sent sessions (Nomi conversations and CLI tabs) share one draft bucket. After the first send, drafts are keyed by that session’s id. Switching sessions must not leak unsent text into the wrong thread.
3. **Local history fold:** The sidebar「本机历史」section (`data-testid="cli-history"`) is collapsible; default expanded; collapse is **not** persisted across app restarts.
4. **Endpoint usage card fold:** `EndpointInfoCard` at the workbench bottom gains a top-right collapse control; preference **is** persisted in `localStorage`.

## Non-goals

- Streaming or showing the title-generation prompt as a visible chat turn.
- Persisting composer drafts to disk / `sessionStorage` beyond in-memory Map for this iteration (Map lives for the app session only).
- Collapsing the whole sidebar rail (`collapsed` / `CollapsedRail`) — unchanged.
- Changing EndpointInfo detail drawer content or quota fetch logic.
- Renaming from cwd, workspace path, or backend display name alone.
- Shipping a release tag as part of this work.

## Locked decisions

| Topic                | Choice                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title scope          | Nomi chats **and** CLI agent tabs (Codex / Claude Code / …)                                                                                                                      |
| Title generation     | After first user message lands, fire a **background** short prompt using the **current selected model** for that session                                                         |
| Title failure        | Fall back to first ~30 chars of user text (`splitFileAttachments(...).text`), same spirit as today’s Nomi `ConversationStore.touch`                                              |
| Manual rename        | Never overwrite: Nomi only while name is still default `ui.chat-settings.new-chat` / translated「新对话」/「New chat」; CLI only while `isGeneratedTabTitle(tab.title, backend)` |
| Empty sessions draft | One shared bucket `SHARED_UNSENT` across **all** empty Nomi chats and empty CLI tabs                                                                                             |
| Sent sessions draft  | Key `nomi:${conversationId}` or `tab:${tabId}` (session id, **never** cwd / `slashCwd` / `railCwd`)                                                                              |
| After send           | Composer clears as today; do **not** copy leftover text into the new private key; `SHARED_UNSENT` stays for other empty sessions                                                 |
| Local history fold   | Chevron / disclosure on `histHead`; **default expanded**; **do not** persist                                                                                                     |
| Endpoint card fold   | Icon top-right on `EndpointInfoCard`; persist `localStorage` key `cd.sidebar.endpointCardCollapsed`                                                                              |
| Hosts                | Electron harness + Go harness stay in parity for CLI title updates                                                                                                               |

---

## 1. Smart session titles

### Behavior

1. On first **user** message append / first CLI submit for a session whose title is still the generated default:
   - Immediately apply the **heuristic fallback** (~30 chars of cleaned user text) so the sidebar updates without waiting on the model (Nomi already does this in `ConversationStore.touch`; CLI must gain the same immediate path).
   - Then kick a **background** title job: short system/user prompt asking for a concise chat title (no quotes, no trailing punctuation spam; implementation plan picks exact prompt + max length, e.g. ≤40 display chars).
2. When the job returns a usable non-empty title, apply it **only if** the session is still in the “generated / default” gate (see below). Otherwise discard.
3. If the job fails, times out, or returns empty / garbage, keep the heuristic title already applied.
4. Sidebar must reflect renames: Nomi via existing index + `CONVERSATIONS_CHANGED_EVENT` / `messageCount` refresh; CLI via harness `tab.title` → `useCliTabSync` → `ConversationStore.upsertFromTab`.

### Acceptance criteria

- New Nomi chat: first send replaces「新对话」with a smart title when the model succeeds; otherwise ~30-char fallback. Manual rename in the sidebar before or during generation wins.
- New CLI tab (`Codex` / `Codex 2` / …): first submit no longer waits for history scan; title updates immediately (heuristic) then optionally to smart title; `syncOpenSessionTitle` / history scan still may refine only while `isGeneratedTabTitle` holds.
- Attachments-only first message (no usable text after `splitFileAttachments`): keep default title for heuristic; skip LLM job (nothing to summarize); later first text message may still trigger if still default (see edge cases).
- Manual `renameTab` / sidebar rename never gets clobbered by heuristic, LLM job, or history `syncOpenSessionTitle`.

### Architecture / touch points

| Area                          | Path                                                                                                                                                                                                                                              | Symbols / notes                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nomi heuristic (exists)       | `packages/ai-chat/src/services/conversationStore.ts`                                                                                                                                                                                              | `create()` default `t('ui.chat-settings.new-chat')`; private `touch(id, message?)` gates on default name + `role === 'user'`, sets `splitFileAttachments(content).text.slice(0, 30)` |
| Nomi persist                  | `packages/ai-chat/src/services/IPCClient.ts`                                                                                                                                                                                                      | `saveMessage` / `saveMessageTo` → `store.append` → `touch`                                                                                                                           |
| Nomi send                     | `packages/ai-chat/src/contexts/AiChatContext.tsx`                                                                                                                                                                                                 | `openTurn` / `sendMessage` / `turn.save`                                                                                                                                             |
| Title job (new)               | Prefer small helper under `packages/ai-chat` (e.g. `services/sessionTitle.ts`) callable from Nomi send path after first user save; uses session’s selected model id (same source ModelControls / chat settings already use for that conversation) |
| Apply smart title (Nomi)      | `ConversationStore` meta update (existing rename / `updateMeta` path) **re-checking** default-name gate                                                                                                                                           |
| CLI default titles            | `apps/desktop-electron/internal/core/src/cli/harness/Orchestrator.ts`                                                                                                                                                                             | `BACKEND_TITLE`, `createTab`, `isGeneratedTabTitle`, `renameTab`, `syncOpenSessionTitle`                                                                                             |
| CLI send-time heuristic (new) | Same Orchestrator send / first-prompt path                                                                                                                                                                                                        | If `isGeneratedTabTitle`, set cleaned ~30–60 char title + `changed()` before waiting on history                                                                                      |
| CLI smart title               | Renderer or core: after first user text known, run same title helper with **tab’s selected model**; apply via rename IPC that still gates `isGeneratedTabTitle`                                                                                   |
| History refine                | `SessionHistoryService` / `createCore.ts` `history.openTitle`                                                                                                                                                                                     | Keep; already gated by `isGeneratedTabTitle`                                                                                                                                         |
| Go parity                     | `apps/desktop-go/internal/core/cli/harness/orchestrator_tabops.go`                                                                                                                                                                                | `SyncOpenSessionTitle` + send-time heuristic mirror                                                                                                                                  |
| Sidebar mirror                | `packages/ai-chat/src/hooks/useCliTabSync.ts`                                                                                                                                                                                                     | `structKey` includes `title` — expect one sync per rename, avoid thrash                                                                                                              |
| Tests today                   | `packages/ai-chat/tests/history.test.ts`; `apps/desktop-electron/internal/core/tests/unit/cli/HarnessTabs.test.ts`                                                                                                                                | Extend rather than invent parallel rename paths                                                                                                                                      |

**“Current selected model” (explicit):**

- **Nomi:** the model id already stored / selected for that conversation’s send (whatever `openTurn` / ModelControls would use for the reply). Title job must not silently switch providers.
- **CLI tab:** the model selected on that harness tab at submit time. If the backend has no selectable chat LLM for a free-form completion, skip the LLM job and keep heuristic only (do not invent a hidden Nomi model call for a Claude/Codex tab).

### Edge cases

| Case                                   | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User renames while LLM title in flight | On completion, gate fails → discard LLM result; keep manual name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Heuristic then LLM                     | Heuristic first (sync); LLM may replace heuristic **only** while still default/generated (heuristic titles count as generated for CLI via length/content not matching `BACKEND_TITLE` pattern — **explicit:** after heuristic, CLI titles are no longer `isGeneratedTabTitle`; therefore **smart title must run through a dedicated “auto-title pending” flag or apply LLM _before_ clearing generated status**). **Chosen approach:** introduce a per-session `autoTitlePending` (or reuse “still auto-managed”) set true when first user message arrives while title was generated/default; clear on manual rename or successful smart apply. Heuristic may update the display string while `autoTitlePending`; LLM apply allowed while `autoTitlePending`; `isGeneratedTabTitle` / default-name checks remain for history sync and for sessions that never entered the job. |
| Second user message                    | Do not re-run title job once `autoTitlePending` cleared or once a non-default name stuck without pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Race: two fast sends                   | Only the first user message arms the job; subsequent messages do not start a second job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| fillComposer / edits before send       | Title uses the text actually sent as the first user message, not earlier draft snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| File-attachment prefixes in content    | Always `splitFileAttachments` (Nomi) / equivalent strip for CLI before heuristic and before LLM prompt body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Electron vs Go                         | Same gates and send-time heuristic; smart-title job may live in shared renderer and call both hosts’ rename APIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 2. Composer draft isolation

### Behavior

1. Maintain an in-memory draft store: `Map<string, { text; images; files }>` living **above** settings keepalive hide in `App.tsx` (must survive settings overlay; must not remount away with MessageInput unmount tricks alone).
2. `draftKey(active)`:
   - If the active session has **no committed user messages** → `SHARED_UNSENT`.
     - Nomi: `ConversationStore` messages length `=== 0` for current id (id may already exist from `create()`).
     - CLI: `!tab.cliSessionId &&` no committed messages on the tab (align with ModelControls `hasMessages`: `!!tab.cliSessionId \|\| carriedMessages > 0`).
   - Else → `nomi:${conversationId}` or `tab:${tabId}`.
3. On active session / key change: stash current composer fields into the previous key; hydrate the next key (empty defaults if missing).
4. On successful send (same moment today’s `setMessage('')` runs): clear the **active** composer UI; write empty into the session’s **private** key if it now qualifies as sent; leave `SHARED_UNSENT` untouched so other empty sessions still see the shared draft (usually empty after send — if user had only this empty session, shared is cleared with the send clear; if they typed in shared, send clears composer and should clear `SHARED_UNSENT` content too because that text was consumed by the send). **Chosen:** clearing on send clears whichever key was active at send time (`SHARED_UNSENT` for first message). Private key for the now-sent session starts empty. Other empty sessions sharing `SHARED_UNSENT` correctly see empty after that send (Codex Desktop-like: the typed text was consumed).
5. `fillComposer` / `composerFill` from `ChangesUiContext` writes into the **active** draft entry only (then into the visible composer).

### Acceptance criteria

- Two empty Nomi chats + one empty Codex tab share one textarea buffer when switching among them.
- After sending in chat A, typing in a new empty chat B starts from empty shared bucket (send cleared shared); chat A’s later unsent follow-ups use `nomi:A` and do not appear in B.
- Switching between two **sent** sessions restores each session’s unsent follow-up draft independently.
- Draft keys never use `slashCwd` / `railCwd` (documented in `App.tsx`); same cwd, different tabs → different private keys after send.
- Opening Settings and returning does not wipe drafts.
- IME composition / slash palette / `@` path mention ephemeral UI: restoring text must not incorrectly reopen those panels (restore text + attachments only).

### Architecture / touch points

| Area                 | Path                                                                           | Symbols                                                                           |
| -------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Composer state today | `packages/ai-chat/src/components/MessageInput/index.tsx`                       | `useState('')` `message`, `images`, `files`; clear on send; **not** session-keyed |
| Mount                | `packages/ai-chat/src/App.tsx`                                                 | single `<MessageInput />`, no `key=` on conversation                              |
| Fill                 | `SessionWorkspace/ChangesUiContext.tsx`                                        | `composerFill` / `fillComposer`                                                   |
| Identity             | `ipcClient.currentConversationId`; harness `tabs.activeTab.id`, `cliSessionId` |                                                                                   |
| Nearby scope pattern | `App.tsx` `slashScope`                                                         | candidate pattern for id base, not for draft key cwd                              |
| Persist today        | only `cd.chat.kbMode` in MessageInput                                          | drafts stay memory-only this iteration                                            |

Prefer explicit save/restore over remounting MessageInput with React `key` (avoids dropping `isComposing`).

### Edge cases

| Case                                     | Choice                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| New Nomi chat already has id, 0 messages | Still `SHARED_UNSENT`                                                                                                                  |
| CLI tab id exists before `cliSessionId`  | Still `SHARED_UNSENT` until first bind / first committed message                                                                       |
| Queued send while busy                   | Clear timing matches today’s clear-on-enqueue/send; stash uses post-clear empty                                                        |
| Attachments in shared draft              | Images/files are part of the shared bucket; switching empty sessions carries them                                                      |
| Delete session                           | Drop its private map entry; do not clear `SHARED_UNSENT` unless it was the active key being edited and product already clears composer |

---

## 3. Local history collapsible

### Behavior

1. `histHead` in `Sidebar/index.tsx` (~1060+) becomes a disclosure control (`aria-expanded`) with chevron; label remains `t('ui.cli-monitor.local-history')`.
2. When collapsed: hide history rows and load-more (`cli-history-more`); scanning / refresh affordances stay reachable from the head row (refresh button behavior unchanged).
3. Initial state every app launch: **expanded**. No `localStorage` read/write for this flag.
4. Prefer lightweight ChevronDown/Right pattern (hist head is dense) over full `@nomi-ai/ui` `Disclosure` if Disclosure fights existing `histHead` flex layout — either is fine if a11y is met.

### Acceptance criteria

- User can collapse/expand「本机历史」; collapsed hides the list.
- Restart app → section expanded again.
- `data-testid="cli-history"` remains on the section wrapper for existing tests.

### Touch points

- `packages/ai-chat/src/components/Sidebar/index.tsx` — `histSection` / `histHead`
- `packages/ai-chat/src/components/Sidebar/index.module.css` — `.histSection`, `.histHead` already `display:flex; justify-content:space-between`

---

## 4. EndpointInfoCard collapse

### Behavior

1. State `endpointCardCollapsed`, persisted under `localStorage` key **`cd.sidebar.endpointCardCollapsed`** (`'1'` / `'0'` or boolean JSON — plan picks one and sticks to it).
2. Top-right controls: existing refresh (`.refresh`, absolute) plus a new collapse icon to its left (or grouped). Both `stopPropagation` so they do not open the detail drawer.
3. Collapsed appearance: slim row — endpoint icon/name + plan badge only; hide mini quota bars and today-cost body.
4. Expanded appearance: today’s compact card.
5. Whole-card click → drawer remains on the main hit target when expanded or on the slim row when collapsed (except the icon buttons).

### Acceptance criteria

- Collapse control visible at top-right; toggles body.
- Preference survives reload.
- `data-testid="endpoint-info-card"` remains; add `data-collapsed="true|false"` for tests.
- Existing endpoint info unit/headed tests updated only as needed for the new control.

### Touch points

- `packages/ai-chat/src/components/EndpointInfo/index.tsx` — `EndpointInfoCard`
- `packages/ai-chat/src/components/EndpointInfo/index.module.css` — `.card`, `.refresh`, `.head` padding (today `padding-right: 28px` for one button → room for two)
- Mount: `Sidebar/index.tsx` ~1143–1156 when `!collapsed && !searching && isDev`
- Design doc `docs/design/endpoint-info-card.md` — note collapse addition in impl PR if that doc is kept in sync (optional follow-up, not blocking)

---

## Cross-cutting gotchas

- **Draft keys = session ids**, never `slashCwd` / `railCwd` (`App.tsx` documents the cwd split for slash vs files rail).
- **CLI titles** update harness tab first; do not only `updateMeta` on the sidebar mirror or titles diverge from `useCliTabSync`.
- **Nomi `touch()`** does not run for CLI messages (CLI not stored in `ConversationStore` message lists the same way); CLI must not rely on `touch` for titles.
- Settings keepalive: draft Map must live in a parent that stays mounted.
- Composer-at-path / slash ephemeral UI: draft restore is text + files only.

---

## i18n keys to add

Reuse where enough; add dedicated a11y strings:

| Key                                     | Purpose                                             |
| --------------------------------------- | --------------------------------------------------- |
| `ui.cli-monitor.collapse-local-history` | aria-label / title when expanded (action: collapse) |
| `ui.cli-monitor.expand-local-history`   | aria-label / title when collapsed (action: expand)  |
| `ui.usage-tools.collapse-endpoint-card` | EndpointInfoCard collapse control                   |
| `ui.usage-tools.expand-endpoint-card`   | EndpointInfoCard expand control                     |

Optional reuse (not required if new keys land): `ui.knowledge-local.collapse`, `ui.model-quality.collapse` / `expand`.  
No new user-visible strings required for title generation prompt (internal) or draft isolation.

Zh/En pairs required for the four new keys in the existing i18n catalogs used by `packages/ai-chat`.

---

## Testing notes

1. **Titles — unit**
   - Nomi: extend `history.test.ts` — first user message heuristic; smart apply when still default; skip when manually renamed; attachments-only leaves default / no job.
   - Title helper: mock model client — success, empty, throw → fallback behavior.
   - CLI: extend `HarnessTabs.test.ts` — send-time heuristic while generated; `syncOpenSessionTitle` / smart apply respect manual rename; Go parity test or shared cases if present.
2. **Drafts — unit / component**
   - `draftKey` matrix: empty Nomi, empty CLI, sent Nomi, sent CLI.
   - Switch empty↔empty keeps shared text; send clears shared; sent↔sent isolates follow-ups.
   - `fillComposer` hits active key only.
3. **Local history — component**
   - Toggle hides/shows list; remount defaults expanded (no persistence).
4. **Endpoint card — component**
   - Toggle sets `data-collapsed`; reload reads `cd.sidebar.endpointCardCollapsed`; refresh/collapse don’t open drawer.
5. **Regression**
   - Existing `endpointInfo.test.tsx`, `historySidebar.test.tsx`, headed `E26.usage-cards-endpoint` smoke as needed.
   - MessageInput slash / send / queue paths still clear consistently.

---

## Implementation order (suggested)

1. Local history fold (UI-only).
2. EndpointInfoCard fold + `localStorage`.
3. CLI send-time heuristic title + Go parity; then shared smart-title helper + Nomi/CLI apply with `autoTitlePending` gate.
4. Composer draft Map + MessageInput/App wiring + `fillComposer` (largest behavioral change).

---

## Self-review checklist

- No TBD/TODO left: model source, pending-title gate, send-clear vs shared bucket, persistence asymmetry (history vs card), attachments-only, Electron/Go parity all decided above.
- No contradiction with locked user answers: smart titles both sides; current model; fallback ~30 chars; global `SHARED_UNSENT`; history default expanded no persist; card persist.
- Heuristic-vs-LLM vs `isGeneratedTabTitle` resolved via `autoTitlePending` so smart titles can replace the interim heuristic without treating manual renames as auto.
