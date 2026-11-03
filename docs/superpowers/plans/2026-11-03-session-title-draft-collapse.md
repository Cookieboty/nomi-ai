# Session title, draft isolation, sidebar collapses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smart session titles (heuristic then current-model LLM) for Nomi chats and CLI tabs, in-memory composer draft isolation with a global `SHARED_UNSENT` bucket, collapsible「本机历史」(default expanded, not persisted), and a collapsible `EndpointInfoCard` (persisted).

**Architecture:** UI-only folds land first. CLI Orchestrator (Electron + Go) applies send-time heuristic titles and arms an in-memory `autoTitlePending` gate; a shared `packages/ai-chat` helper builds prompts, sanitizes titles, and runs the background completion via an injected `complete` function. Nomi applies titles through `ConversationStore.updateMeta`; CLI applies through a gated harness `applyAutoTitle` so manual `renameTab` wins. Composer drafts live in a small Map module owned above Settings keepalive in `App.tsx`, keyed by `draftKey` — never by cwd.

**Tech Stack:** React + TypeScript (`@nomi-ai/ai-chat`), Electron harness (`apps/desktop-electron/internal/core`), Go harness (`apps/desktop-go/internal/core/cli/harness`), Vitest / Jest, `@nomi-ai/i18n` locale JSON + `scripts/i18n/refresh-catalog.mjs`, changesets.

## Global Constraints

- Title scope: Nomi chats **and** CLI agent tabs (Codex / Claude Code / …).
- Title generation: after first user message lands, fire a **background** short prompt using the **current selected model** for that session.
- Title failure: fall back to first ~30 chars of user text (`splitFileAttachments(...).text`), same spirit as today’s Nomi `ConversationStore.touch`.
- Manual rename: never overwrite — Nomi only while name is still default `ui.chat-settings.new-chat` / translated「新对话」/「New chat」; CLI only while `isGeneratedTabTitle(tab.title, backend)` **or** `autoTitlePending` (heuristic may replace display string while pending; LLM apply allowed while pending; clear pending on manual rename or successful smart apply).
- Empty sessions draft: one shared bucket `SHARED_UNSENT` across **all** empty Nomi chats and empty CLI tabs.
- Sent sessions draft: key `nomi:${conversationId}` or `tab:${tabId}` (session id, **never** cwd / `slashCwd` / `railCwd`).
- After send: composer clears as today; do **not** copy leftover text into the new private key; clearing on send clears whichever key was active at send time (`SHARED_UNSENT` for first message); private key for the now-sent session starts empty.
- Local history fold: chevron / disclosure on `histHead`; **default expanded**; **do not** persist.
- Endpoint card fold: icon top-right on `EndpointInfoCard`; persist `localStorage` key `cd.sidebar.endpointCardCollapsed` as `'1'` / `'0'`.
- Hosts: Electron harness + Go harness stay in parity for CLI send-time heuristic title updates.
- Spec: `docs/superpowers/specs/2026-11-03-session-title-draft-collapse-design.md`.

## File map

| File                                                                     | Role                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `packages/i18n/src/locales/{zh,en}/ui/cli-monitor.json`                  | Local-history collapse/expand a11y strings                             |
| `packages/i18n/src/locales/{zh,en}/ui/usage-tools.json`                  | Endpoint card collapse/expand a11y strings                             |
| `packages/i18n/src/catalog.ts`                                           | Regenerated via `node scripts/i18n/refresh-catalog.mjs`                |
| `apps/desktop-go/internal/core/i18n/locales/**`                          | Byte-identical copy of `packages/i18n/src/locales` (dict_test)         |
| `packages/ai-chat/src/components/Sidebar/index.tsx`                      | Local-history disclosure                                               |
| `packages/ai-chat/src/components/Sidebar/index.module.css`               | Chevron layout on `histHead`                                           |
| `packages/ai-chat/src/components/EndpointInfo/index.tsx`                 | Card collapse + localStorage                                           |
| `packages/ai-chat/src/components/EndpointInfo/index.module.css`          | Two top-right controls; slim collapsed row                             |
| `packages/ai-chat/tests/historySidebar.test.tsx`                         | History fold tests                                                     |
| `packages/ai-chat/tests/endpointInfo.test.tsx`                           | Card fold / persist / stopPropagation                                  |
| `apps/desktop-electron/internal/core/src/cli/harness/Orchestrator.ts`    | Send-time heuristic + `autoTitlePending` + `applyAutoTitle`            |
| `apps/desktop-electron/internal/core/tests/unit/cli/HarnessTabs.test.ts` | Heuristic / pending / rename gates                                     |
| `apps/desktop-go/internal/core/cli/harness/orchestrator_send.go`         | Go send-time heuristic parity                                          |
| `apps/desktop-go/internal/core/cli/harness/orchestrator_tabops.go`       | Go `ApplyAutoTitle` / pending clear on rename                          |
| `packages/ai-chat/src/services/sessionTitle.ts`                          | Pure helpers + async generate                                          |
| `packages/ai-chat/tests/sessionTitle.test.ts`                            | Helper unit tests                                                      |
| `packages/ai-chat/src/services/conversationStore.ts`                     | `isDefaultChatName` export; optional notify on touch rename            |
| `packages/ai-chat/src/contexts/AiChatContext.tsx`                        | Arm Nomi smart-title after first user save                             |
| `packages/ai-chat/src/services/IPCClient.ts`                             | Thin `completeTitle` / reuse `chat.sendMessage` with chat model        |
| `packages/ai-chat/src/services/harnessClient.ts`                         | `applyAutoTitle` IPC                                                   |
| `packages/ai-chat/src/services/composerDrafts.ts`                        | `draftKey` + in-memory Map                                             |
| `packages/ai-chat/tests/composerDrafts.test.ts`                          | Key matrix + stash/hydrate/clear                                       |
| `packages/ai-chat/src/components/MessageInput/index.tsx`                 | Controlled draft sync / clear active key on send                       |
| `packages/ai-chat/src/App.tsx`                                           | Own draft Map above keepalive; pass session identity into MessageInput |
| `.changeset/session-title-draft-collapse.md`                             | Patch notes                                                            |

---

### Task 1: Local history fold + i18n

**Files:**

- Modify: `packages/i18n/src/locales/zh/ui/cli-monitor.json`
- Modify: `packages/i18n/src/locales/en/ui/cli-monitor.json`
- Modify: `apps/desktop-go/internal/core/i18n/locales/zh/ui/cli-monitor.json` (copy same keys)
- Modify: `apps/desktop-go/internal/core/i18n/locales/en/ui/cli-monitor.json`
- Modify: `packages/i18n/src/catalog.ts` (via refresh script)
- Modify: `packages/ai-chat/src/components/Sidebar/index.tsx` (~1059–1138)
- Modify: `packages/ai-chat/src/components/Sidebar/index.module.css` (`.histHead`)
- Test: `packages/ai-chat/tests/historySidebar.test.tsx`

**Interfaces:**

- Consumes: existing `t('ui.cli-monitor.local-history')`, `data-testid="cli-history"`
- Produces: i18n keys `ui.cli-monitor.collapse-local-history`, `ui.cli-monitor.expand-local-history`; React state `localHistoryOpen` default `true` (not persisted)

- [ ] **Step 1: Add locale strings (zh + en)**

In both `packages/i18n/src/locales/zh/ui/cli-monitor.json` and `en/…` add (keep alphabetical neighbors near other `local-*` keys):

```json
"ui.cli-monitor.collapse-local-history": "收起本机历史",
"ui.cli-monitor.expand-local-history": "展开本机历史"
```

English:

```json
"ui.cli-monitor.collapse-local-history": "Collapse local history",
"ui.cli-monitor.expand-local-history": "Expand local history"
```

Copy the same JSON files into `apps/desktop-go/internal/core/i18n/locales/{zh,en}/ui/cli-monitor.json`.

Run:

```bash
node scripts/i18n/refresh-catalog.mjs
pnpm check:i18n
```

Expected: exit 0; `catalog.ts` includes the new `TranslationKey` union members.

- [ ] **Step 2: Write the failing fold test**

Append to `packages/ai-chat/tests/historySidebar.test.tsx` (reuse the existing harness that mounts a Sidebar with history rows):

```tsx
it('collapses and expands local history; remount defaults to expanded', async () => {
  const r = renderSidebarWithHistory(); // use the file's existing mount helper / pattern
  const section = await r.findByTestId('cli-history');
  expect(section.querySelectorAll('[data-testid="history-session-row"]').length).toBeGreaterThan(0);

  const toggle = r.getByTestId('cli-history-toggle');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(r.queryAllByTestId('history-session-row')).toHaveLength(0);
  expect(r.queryByTestId('cli-history-more')).toBeNull();

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(r.getAllByTestId('history-session-row').length).toBeGreaterThan(0);

  r.unmount();
  const r2 = renderSidebarWithHistory();
  const toggle2 = await r2.findByTestId('cli-history-toggle');
  expect(toggle2).toHaveAttribute('aria-expanded', 'true');
});
```

Adapt `renderSidebarWithHistory` to whatever helper the file already uses (do not invent a parallel mount).

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @nomi-ai/ai-chat test -- historySidebar.test.tsx
```

Expected: FAIL — missing `cli-history-toggle` / keys.

- [ ] **Step 4: Implement disclosure on `histHead`**

In `Sidebar/index.tsx` near the hist section:

```tsx
const [localHistoryOpen, setLocalHistoryOpen] = useState(true);
```

Replace the static `histHead` with a disclosure control (ChevronDown when open, ChevronRight when closed — same lucide pattern as `ChangeFileTree`):

```tsx
<div className={styles.histSection} data-testid="cli-history">
  <div className={styles.histHead}>
    <button
      type="button"
      className={styles.histToggle}
      data-testid="cli-history-toggle"
      aria-expanded={localHistoryOpen}
      aria-label={
        localHistoryOpen
          ? t('ui.cli-monitor.collapse-local-history')
          : t('ui.cli-monitor.expand-local-history')
      }
      title={
        localHistoryOpen
          ? t('ui.cli-monitor.collapse-local-history')
          : t('ui.cli-monitor.expand-local-history')
      }
      onClick={() => setLocalHistoryOpen((v) => !v)}
    >
      {localHistoryOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span className={styles.sectionTitle}>{t('ui.cli-monitor.local-history')}</span>
    </button>
  </div>
  {localHistoryOpen && (
    <>
      {histScanning && (/* existing empty scanning row */)}
      {histItems.map(/* existing rows */)}
      {histScopeSupported && history.hasMore(histScope) && (/* existing load-more */)}
    </>
  )}
</div>
```

Keep refresh affordances that already live outside this block unchanged. Do **not** read/write `localStorage` for this flag.

Add CSS for `.histToggle` (flex, gap, transparent button, inherit font/color).

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @nomi-ai/ai-chat test -- historySidebar.test.tsx
```

Expected: PASS (existing cases + new fold case).

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/src/locales/zh/ui/cli-monitor.json \
  packages/i18n/src/locales/en/ui/cli-monitor.json \
  packages/i18n/src/catalog.ts \
  apps/desktop-go/internal/core/i18n/locales/zh/ui/cli-monitor.json \
  apps/desktop-go/internal/core/i18n/locales/en/ui/cli-monitor.json \
  packages/ai-chat/src/components/Sidebar/index.tsx \
  packages/ai-chat/src/components/Sidebar/index.module.css \
  packages/ai-chat/tests/historySidebar.test.tsx
git commit -m "$(cat <<'EOF'
feat(sidebar): fold local history section

EOF
)"
```

---

### Task 2: EndpointInfoCard fold + localStorage + i18n

**Files:**

- Modify: `packages/i18n/src/locales/{zh,en}/ui/usage-tools.json`
- Modify: `apps/desktop-go/internal/core/i18n/locales/{zh,en}/ui/usage-tools.json`
- Modify: `packages/i18n/src/catalog.ts` (refresh)
- Modify: `packages/ai-chat/src/components/EndpointInfo/index.tsx`
- Modify: `packages/ai-chat/src/components/EndpointInfo/index.module.css`
- Test: `packages/ai-chat/tests/endpointInfo.test.tsx`

**Interfaces:**

- Consumes: existing `EndpointInfoCard`, `data-testid="endpoint-info-card"`, refresh button
- Produces: `data-collapsed="true|false"`; storage key `cd.sidebar.endpointCardCollapsed` (`'1'` collapsed, `'0'` expanded); i18n `ui.usage-tools.collapse-endpoint-card` / `expand-endpoint-card`

- [ ] **Step 1: Add locale strings**

Zh:

```json
"ui.usage-tools.collapse-endpoint-card": "收起用量卡片",
"ui.usage-tools.expand-endpoint-card": "展开用量卡片"
```

En:

```json
"ui.usage-tools.collapse-endpoint-card": "Collapse usage card",
"ui.usage-tools.expand-endpoint-card": "Expand usage card"
```

Sync Go embed copies. Run `node scripts/i18n/refresh-catalog.mjs && pnpm check:i18n`.

- [ ] **Step 2: Write failing tests**

In `packages/ai-chat/tests/endpointInfo.test.tsx` inside `describe('按端信息卡（左下角）', …)`:

```tsx
it('折叠控件切换 data-collapsed，并写入 cd.sidebar.endpointCardCollapsed', async () => {
  localStorage.removeItem('cd.sidebar.endpointCardCollapsed');
  const r = renderCard(/* existing quota fixture */);
  const card = await r.findByTestId('endpoint-info-card');
  expect(card).toHaveAttribute('data-collapsed', 'false');
  expect(r.getByTestId('endpoint-card-usage')).toBeTruthy();

  fireEvent.click(r.getByTestId('endpoint-card-collapse'));
  expect(card).toHaveAttribute('data-collapsed', 'true');
  expect(r.queryByTestId('endpoint-card-usage')).toBeNull();
  expect(localStorage.getItem('cd.sidebar.endpointCardCollapsed')).toBe('1');

  fireEvent.click(r.getByTestId('endpoint-card-collapse'));
  expect(card).toHaveAttribute('data-collapsed', 'false');
  expect(localStorage.getItem('cd.sidebar.endpointCardCollapsed')).toBe('0');
});

it('折叠 / 刷新不打开详情抽屉', async () => {
  const r = renderCard(/* … */);
  fireEvent.click(r.getByTestId('endpoint-card-collapse'));
  expect(r.queryByRole('dialog')).toBeNull();
  fireEvent.click(r.getByTestId('endpoint-card-refresh'));
  expect(r.queryByRole('dialog')).toBeNull();
});

it('启动时读取 cd.sidebar.endpointCardCollapsed=1 为收起', async () => {
  localStorage.setItem('cd.sidebar.endpointCardCollapsed', '1');
  const r = renderCard(/* … */);
  expect(await r.findByTestId('endpoint-info-card')).toHaveAttribute('data-collapsed', 'true');
});
```

Use the file’s existing render helper / mocks (same as the「精简：端图标…」case).

- [ ] **Step 3: Run to verify fail**

```bash
pnpm --filter @nomi-ai/ai-chat test -- endpointInfo.test.tsx
```

Expected: FAIL on missing collapse control / `data-collapsed`.

- [ ] **Step 4: Implement collapse**

Storage helpers at top of `EndpointInfo/index.tsx`:

```ts
const ENDPOINT_CARD_COLLAPSED_KEY = 'cd.sidebar.endpointCardCollapsed';

function readEndpointCardCollapsed(): boolean {
  try {
    return localStorage.getItem(ENDPOINT_CARD_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEndpointCardCollapsed(v: boolean): void {
  try {
    localStorage.setItem(ENDPOINT_CARD_COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}
```

In `EndpointInfoCard`:

```tsx
const [collapsed, setCollapsed] = useState(readEndpointCardCollapsed);

const toggleCollapsed = (e: React.MouseEvent) => {
  e.stopPropagation();
  setCollapsed((c) => {
    const next = !c;
    writeEndpointCardCollapsed(next);
    return next;
  });
};
```

On the card root:

```tsx
<div
  className={styles.card}
  data-testid="endpoint-info-card"
  data-endpoint={backend}
  data-busy={info.busy || undefined}
  data-collapsed={collapsed ? 'true' : 'false'}
>
```

When `collapsed`, render only the head row (icon / name / badge) inside `.main`; hide `MiniBars`, today-cost `.kv`, and install hint body. Keep `.main` click → `setOpen(true)`.

Add collapse button **left of** refresh (both absolute top-right). Collapse uses `ChevronDown` when expanded (action: collapse) and `ChevronRight` when collapsed (action: expand), or `ChevronsUpDown` — pick one pair and stick to it:

```tsx
<button
  type="button"
  className={styles.collapse}
  data-testid="endpoint-card-collapse"
  aria-expanded={!collapsed}
  aria-label={collapsed ? t('ui.usage-tools.expand-endpoint-card') : t('ui.usage-tools.collapse-endpoint-card')}
  title={collapsed ? t('ui.usage-tools.expand-endpoint-card') : t('ui.usage-tools.collapse-endpoint-card')}
  onClick={toggleCollapsed}
>
  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
</button>
```

Ensure refresh `onClick` already stops opening the drawer (it is a sibling of `.main`, not inside it — keep that). Collapse same pattern.

CSS: bump `.head { padding-right: 52px; }`; add `.collapse` mirroring `.refresh` but `right: 31px`; show both on `.card:hover` / `:focus-within` / `[data-busy]`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @nomi-ai/ai-chat test -- endpointInfo.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/src/locales/zh/ui/usage-tools.json \
  packages/i18n/src/locales/en/ui/usage-tools.json \
  packages/i18n/src/catalog.ts \
  apps/desktop-go/internal/core/i18n/locales/zh/ui/usage-tools.json \
  apps/desktop-go/internal/core/i18n/locales/en/ui/usage-tools.json \
  packages/ai-chat/src/components/EndpointInfo/index.tsx \
  packages/ai-chat/src/components/EndpointInfo/index.module.css \
  packages/ai-chat/tests/endpointInfo.test.tsx
git commit -m "$(cat <<'EOF'
feat(endpoint-info): fold usage card with persisted preference

EOF
)"
```

---

### Task 3: CLI send-time heuristic title (Electron) + tests

**Files:**

- Modify: `apps/desktop-electron/internal/core/src/cli/harness/Orchestrator.ts`
- Test: `apps/desktop-electron/internal/core/tests/unit/cli/HarnessTabs.test.ts`

**Interfaces:**

- Consumes: `isGeneratedTabTitle`, `cleanTitle` from `@nomi-ai/cli-plugins/main` (already used via agents/parsers), `appendMessage` in `sendTab`
- Produces:
  - private `autoTitlePending = new Set<string>()`
  - `applyHeuristicTitle(tabId, promptText): void` (or inline)
  - `applyAutoTitle(id: string, title: string): HarnessTabMeta | null` — applies only if `autoTitlePending.has(id)`; clears pending on success
  - `renameTab` clears `autoTitlePending` for that id

- [ ] **Step 1: Write failing tests**

In `HarnessTabs.test.ts`:

```ts
it('sets a heuristic title on first send while the tab title is still generated', async () => {
  process.env.NOMI_MOCK_DELAY_MS = '10';
  const h = mk();
  const tab = h.createTab({ backend: 'codex' });
  expect(tab.title).toBe('Codex');
  await h.sendTab(tab.id, '修复登录流程里的空指针');
  const titled = h.listTabs().tabs.find((x) => x.id === tab.id)!;
  expect(titled.title.startsWith('修复登录流程')).toBe(true);
  expect(titled.title.length).toBeLessThanOrEqual(60);
});

it('does not overwrite a manual rename with send-time heuristic', async () => {
  process.env.NOMI_MOCK_DELAY_MS = '10';
  const h = mk();
  const tab = h.createTab({ backend: 'codex' });
  h.renameTab(tab.id, '我的 Codex');
  await h.sendTab(tab.id, '这段不该改标题');
  expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.title).toBe('我的 Codex');
});

it('applyAutoTitle works only while autoTitlePending; rename clears pending', async () => {
  process.env.NOMI_MOCK_DELAY_MS = '10';
  const h = mk();
  const tab = h.createTab({ backend: 'claude' });
  await h.sendTab(tab.id, '帮我写一个解析器');
  // after heuristic, pending still true until smart apply or manual rename
  expect(h.applyAutoTitle(tab.id, '写解析器')).toMatchObject({ title: '写解析器' });
  expect(h.applyAutoTitle(tab.id, '第二次')).toBeNull();

  const tab2 = h.createTab({ backend: 'codex' });
  await h.sendTab(tab2.id, '另一段');
  h.renameTab(tab2.id, '手动名');
  expect(h.applyAutoTitle(tab2.id, '智能名')).toBeNull();
  expect(h.listTabs().tabs.find((x) => x.id === tab2.id)?.title).toBe('手动名');
});
```

If `applyAutoTitle` is not yet on the public harness surface used by `mk()`, export it the same way `renameTab` / `syncOpenSessionTitle` are exposed on the test harness.

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @nomi-ai/core exec jest --watchman=false tests/unit/cli/HarnessTabs.test.ts
```

(Adjust filter/cwd to the package that owns `apps/desktop-electron/internal/core` — use that package’s existing `test` script if the filter name differs; neighboring plans run Jest from `internal/core`.)

Expected: FAIL — title still `Codex` after send / `applyAutoTitle` missing.

- [ ] **Step 3: Implement in Orchestrator**

Near class fields:

```ts
private readonly autoTitlePending = new Set<string>();
```

Import / reuse `cleanTitle` (from `@nomi-ai/cli-plugins/main` or the agents/parsers re-export already used in core).

Helper method:

```ts
private armHeuristicTitle(tab: HarnessTabMeta, prompt: string): void {
  if (tab.backend === 'nomi' || tab.backend === 'external') return;
  if (!isGeneratedTabTitle(tab.title, tab.backend) && !this.autoTitlePending.has(tab.id)) return;
  const cleaned = cleanTitle(prompt, 30);
  if (!cleaned) return;
  if (isGeneratedTabTitle(tab.title, tab.backend)) {
    this.autoTitlePending.add(tab.id);
    tab.title = cleaned;
  } else if (this.autoTitlePending.has(tab.id)) {
    // already heuristically titled; keep pending for smart apply
  }
}
```

Call **immediately after** the user `appendMessage` in `sendTab` (around line ~2651), then `this.changed()` so the sidebar sync sees the new title before the CLI round-trip:

```ts
this.appendMessage(id, {/* user message */});
this.armHeuristicTitle(current, text);
this.changed();
```

Update `renameTab`:

```ts
renameTab(id: string, title: string): HarnessTabMeta {
  const tab = this.requireTab(id);
  const next = String(title ?? '').trim().slice(0, 60);
  if (!next) throw new Error(t('electron.common.title-cannot-be-empty'));
  tab.title = next;
  this.autoTitlePending.delete(id);
  this.changed();
  return { ...tab };
}
```

Add:

```ts
applyAutoTitle(id: string, title: string): HarnessTabMeta | null {
  if (!this.autoTitlePending.has(id)) return null;
  const tab = this.tabs.get(id);
  if (!tab) return null;
  const next = String(title ?? '').trim().slice(0, 60);
  if (!next) return null;
  tab.title = next;
  this.autoTitlePending.delete(id);
  this.changed();
  return { ...tab };
}
```

Wire `applyAutoTitle` through the same IPC / createCore surface as `renameTab` (mirror the existing rename registration pattern exactly).

Keep `syncOpenSessionTitle` gated only on `isGeneratedTabTitle` (unchanged) — after heuristic it will no longer overwrite; smart title uses `applyAutoTitle`.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @nomi-ai/core exec jest --watchman=false tests/unit/cli/HarnessTabs.test.ts
```

Expected: PASS including the new cases and the existing `syncOpenSessionTitle` case.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-electron/internal/core/src/cli/harness/Orchestrator.ts \
  apps/desktop-electron/internal/core/tests/unit/cli/HarnessTabs.test.ts
# plus any createCore / IPC registration files touched for applyAutoTitle
git commit -m "$(cat <<'EOF'
feat(harness): heuristic tab title on first send

EOF
)"
```

---

### Task 4: Go harness parity for send-time heuristic

**Files:**

- Modify: `apps/desktop-go/internal/core/cli/harness/orchestrator.go` (or the file that holds `isGeneratedTabTitle` / orchestrator fields)
- Modify: `apps/desktop-go/internal/core/cli/harness/orchestrator_send.go`
- Modify: `apps/desktop-go/internal/core/cli/harness/orchestrator_tabops.go`
- Test: extend an existing parity / tabops test under `apps/desktop-go/internal/core/cli/harness/` (prefer `orchestrator_tabs_parity_test.go` or `orchestrator_session_parity_test.go`)

**Interfaces:**

- Consumes: Go `isGeneratedTabTitle`, CLI plugin `CleanTitle` equivalent already used by history sync
- Produces: same semantics as Electron — `autoTitlePending` set, heuristic on `SendTab`, `ApplyAutoTitle`, `RenameTab` clears pending

- [ ] **Step 1: Write failing Go test**

Mirror the Electron cases with the file’s existing orchestrator test harness (`paritytest` / mock delay). Assert: after `SendTab` on a fresh Codex tab, `title` is the cleaned first ~30 chars; after `RenameTab`, `ApplyAutoTitle` is a no-op.

- [ ] **Step 2: Run to verify fail**

```bash
cd apps/desktop-go && go test ./internal/core/cli/harness/ -count=1 -run 'Heuristic|ApplyAutoTitle|SendTab.*[Tt]itle'
```

Expected: FAIL / no test match until implemented — after adding the test, FAIL on missing behavior.

- [ ] **Step 3: Implement**

Add `autoTitlePending map[string]struct{}` on `Orchestrator` (init in constructor alongside other maps).

In `SendTab`, after appending the user message (same relative point as Electron), if generated title and cleaned prompt non-empty: set pending, set `tab` title, `o.changed()`.

`RenameTab`: delete pending for id.

`ApplyAutoTitle(id, title string) *util.Obj`: if not pending return nil; else set title (trim, max 60), clear pending, `changed()`, return tab snapshot.

Export through the same JS/bridge surface Electron’s `applyAutoTitle` uses so the renderer call works on Go host.

- [ ] **Step 4: Run tests**

```bash
cd apps/desktop-go && go test ./internal/core/cli/harness/ -count=1
```

Expected: PASS (parity suite green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-go/internal/core/cli/harness/
git commit -m "$(cat <<'EOF'
feat(desktop-go): heuristic tab title on first send

EOF
)"
```

---

### Task 5: `sessionTitle` helper + Nomi apply + tests

**Files:**

- Create: `packages/ai-chat/src/services/sessionTitle.ts`
- Create: `packages/ai-chat/tests/sessionTitle.test.ts`
- Modify: `packages/ai-chat/src/services/conversationStore.ts` (export default-name predicate; arm/clear pending helpers)
- Modify: `packages/ai-chat/src/services/IPCClient.ts` (optional thin `completeChatText`)
- Modify: `packages/ai-chat/src/contexts/AiChatContext.tsx` (fire job after first user save)
- Modify: `packages/ai-chat/tests/history.test.ts` (smart apply / skip when renamed / attachments-only)

**Interfaces:**

- Consumes: `splitFileAttachments` from `./fileAttachments`; `t('ui.chat-settings.new-chat')`; chat `sendMessage` with **chat** routing (not `role: 'summary'`)
- Produces:

```ts
export const TITLE_MAX = 40;
export const HEURISTIC_MAX = 30;

export function isDefaultChatName(name: string): boolean;
export function heuristicTitle(raw: string, max = HEURISTIC_MAX): string;
export function sanitizeSmartTitle(raw: string, max = TITLE_MAX): string | null;
export function buildTitleMessages(userText: string): Array<{ role: 'system' | 'user'; content: string }>;

export type TitleComplete = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
) => Promise<string>;

export async function generateSmartTitle(userText: string, complete: TitleComplete): Promise<string | null>;

/** In-memory pending set for Nomi conversation ids */
export function armNomiAutoTitle(id: string): void;
export function clearNomiAutoTitle(id: string): void;
export function nomiAutoTitlePending(id: string): boolean;
```

Prompt (exact):

- system: `You name chat sessions. Reply with a concise title only: ≤40 characters, no quotes, no trailing punctuation, same language as the user.`
- user: the cleaned first-message text (already `splitFileAttachments` / trimmed), truncated to ~500 chars for the prompt body.

- [ ] **Step 1: Write failing helper tests**

`packages/ai-chat/tests/sessionTitle.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  buildTitleMessages,
  generateSmartTitle,
  heuristicTitle,
  isDefaultChatName,
  sanitizeSmartTitle,
  armNomiAutoTitle,
  clearNomiAutoTitle,
  nomiAutoTitlePending,
} from '../src/services/sessionTitle';

describe('sessionTitle', () => {
  it('detects default Nomi names', () => {
    expect(isDefaultChatName('ui.chat-settings.new-chat')).toBe(true);
    expect(isDefaultChatName('新对话') || isDefaultChatName('New chat')).toBe(true);
    expect(isDefaultChatName('已改名')).toBe(false);
  });

  it('heuristicTitle strips attachments and slices', () => {
    const raw = '[[file:a.ts]]hello world from the first message that is quite long';
    expect(heuristicTitle(raw).length).toBeLessThanOrEqual(30);
    expect(heuristicTitle(raw)).toContain('hello');
  });

  it('sanitizeSmartTitle rejects empty / quoted spam and trims', () => {
    expect(sanitizeSmartTitle('  ')).toBeNull();
    expect(sanitizeSmartTitle('"登录修复"')).toBe('登录修复');
    expect(sanitizeSmartTitle('A'.repeat(80))!.length).toBeLessThanOrEqual(40);
  });

  it('generateSmartTitle returns sanitized model output or null on failure', async () => {
    await expect(generateSmartTitle('fix login', async () => '  "Fix login"  ')).resolves.toBe('Fix login');
    await expect(generateSmartTitle('x', async () => '')).resolves.toBeNull();
    await expect(
      generateSmartTitle('x', async () => {
        throw new Error('boom');
      }),
    ).resolves.toBeNull();
  });

  it('buildTitleMessages uses system+user and includes the text', () => {
    const msgs = buildTitleMessages('修复登录');
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: expect.stringContaining('修复登录') });
  });

  it('pending arm/clear', () => {
    armNomiAutoTitle('c1');
    expect(nomiAutoTitlePending('c1')).toBe(true);
    clearNomiAutoTitle('c1');
    expect(nomiAutoTitlePending('c1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @nomi-ai/ai-chat test -- sessionTitle.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `sessionTitle.ts`**

```ts
import { t } from '@nomi-ai/ui';
import { splitFileAttachments } from './fileAttachments';

export const TITLE_MAX = 40;
export const HEURISTIC_MAX = 30;

const pending = new Set<string>();

export function isDefaultChatName(name: string): boolean {
  return name === 'ui.chat-settings.new-chat' || name === t('ui.chat-settings.new-chat');
}

export function heuristicTitle(raw: string, max = HEURISTIC_MAX): string {
  return splitFileAttachments(raw).text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function sanitizeSmartTitle(raw: string, max = TITLE_MAX): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('“') && s.endsWith('”')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[。.!！?？]+$/u, '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function buildTitleMessages(userText: string) {
  const body = userText.replace(/\s+/g, ' ').trim().slice(0, 500);
  return [
    {
      role: 'system' as const,
      content:
        'You name chat sessions. Reply with a concise title only: ≤40 characters, no quotes, no trailing punctuation, same language as the user.',
    },
    { role: 'user' as const, content: body },
  ];
}

export type TitleComplete = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
) => Promise<string>;

export async function generateSmartTitle(userText: string, complete: TitleComplete): Promise<string | null> {
  const cleaned = heuristicTitle(userText, 500);
  if (!cleaned) return null;
  try {
    const raw = await complete(buildTitleMessages(cleaned));
    return sanitizeSmartTitle(typeof raw === 'string' ? raw : '');
  } catch {
    return null;
  }
}

export function armNomiAutoTitle(id: string): void {
  pending.add(id);
}
export function clearNomiAutoTitle(id: string): void {
  pending.delete(id);
}
export function nomiAutoTitlePending(id: string): boolean {
  return pending.has(id);
}
```

Export `isDefaultChatName` usage from `ConversationStore.touch` by calling the shared helper (keep behavior identical). On `updateMeta` when `patch.name` is set from the sidebar rename path, call `clearNomiAutoTitle(id)` — do this in `Sidebar` rename handler and/or inside a small `renameConversation(id, name)` wrapper used by the sidebar so pending clears on manual rename.

- [ ] **Step 4: Wire Nomi send path**

In `AiChatContext` where the first user message is `turn.save(userMessage)` (before/at the stream start — same moment `touch` already renames):

```ts
const store = client.conversationStore?.();
const meta = turn.convoId ? store?.get(turn.convoId) : undefined;
const text = splitFileAttachments(userMessage.content).text.trim();
if (turn.convoId && text && meta && isDefaultChatName(meta.name)) {
  armNomiAutoTitle(turn.convoId);
  const convoId = turn.convoId;
  void generateSmartTitle(text, (messages) =>
    client.completeChatText ? client.completeChatText(messages) : client.sendMessage(/* not ideal */).then(/* … */),
  ).then((title) => {
    if (!title || !nomiAutoTitlePending(convoId)) return;
    const cur = client.conversationStore?.()?.get(convoId);
    if (!cur || (!isDefaultChatName(cur.name) && !nomiAutoTitlePending(convoId))) return;
    // Still allow apply while pending even if heuristic already changed the display name:
    if (!nomiAutoTitlePending(convoId)) return;
    client.conversationStore?.()?.updateMeta(convoId, { name: title });
    clearNomiAutoTitle(convoId);
    notifyConversationsChanged();
  });
}
```

Add on `IPCClient`:

```ts
async completeChatText(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const resp = await this.chat.sendMessage({ messages, role: 'chat' });
  return typeof resp?.content === 'string' ? resp.content.trim() : '';
}
```

This uses the **current chat assignment** (selected Nomi model), not the summary helper slot.

Attachments-only (`!text`): do not arm pending; leave default name (existing `touch` also leaves default when cleaned text is empty).

- [ ] **Step 5: Extend `history.test.ts`**

```ts
it('keeps heuristic name when smart title is skipped; applySmart only while pending', () => {
  const s = mk();
  const id = s.ensureCurrent();
  s.append(msg('1', 'user', 'hello from nomi first message'));
  expect(s.get(id)!.name.startsWith('hello from nomi')).toBe(true);
});

it('attachments-only first message leaves default name', () => {
  const s = mk();
  const id = s.ensureCurrent();
  const defaultName = s.get(id)!.name;
  s.append(msg('1', 'user', '[[file:a.ts]]'));
  expect(s.get(id)!.name).toBe(defaultName);
});
```

Keep the existing `first question` assertion. Add a small unit test that `updateMeta` after `clearNomiAutoTitle` is what the UI uses for manual rename (can live in `sessionTitle.test.ts`).

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @nomi-ai/ai-chat test -- sessionTitle.test.ts history.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ai-chat/src/services/sessionTitle.ts \
  packages/ai-chat/tests/sessionTitle.test.ts \
  packages/ai-chat/src/services/conversationStore.ts \
  packages/ai-chat/src/services/IPCClient.ts \
  packages/ai-chat/src/contexts/AiChatContext.tsx \
  packages/ai-chat/src/components/Sidebar/index.tsx \
  packages/ai-chat/tests/history.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-chat): smart Nomi titles via current chat model

EOF
)"
```

---

### Task 6: Wire CLI smart title via helper + gates

**Files:**

- Modify: `packages/ai-chat/src/services/harnessClient.ts` — `applyAutoTitle(id, title)`
- Modify: `packages/ai-chat/src/App.tsx` and/or CLI send wrapper (where `sendTabReply` / `onSend` for CLI runs)
- Modify: `packages/ai-chat/src/contexts/HarnessTabsContext.tsx` if rename helpers live there
- Test: `packages/ai-chat/tests/cliTabSync.test.tsx` or a new `packages/ai-chat/tests/cliSmartTitle.test.ts` with mocked harnessClient

**Interfaces:**

- Consumes: `generateSmartTitle`, `harnessClient.applyAutoTitle`, tab `source` / `modelOverride` / `lastServedRef`
- Produces: after CLI first send with non-empty cleaned text, if tab can free-form complete (third-party `provider/model` ref available), background job → `applyAutoTitle`; official CLI without gateway model → **skip LLM**, keep heuristic only

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { maybeSmartTitleCliTab } from '../src/services/cliSmartTitle';

describe('maybeSmartTitleCliTab', () => {
  it('skips LLM for official tabs without a gateway model ref', async () => {
    const complete = vi.fn();
    const apply = vi.fn();
    await maybeSmartTitleCliTab({
      tab: { id: 't1', source: 'official', modelOverride: 'gpt-5', backend: 'codex' },
      userText: 'fix auth',
      complete,
      applyAutoTitle: apply,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('runs LLM for thirdParty tabs and applies title', async () => {
    const complete = vi.fn(async () => 'Auth fix');
    const apply = vi.fn(async () => ({ id: 't1', title: 'Auth fix' }));
    await maybeSmartTitleCliTab({
      tab: {
        id: 't1',
        source: 'thirdParty',
        modelOverride: 'acme/cool-model',
        backend: 'codex',
      },
      userText: 'fix authentication bug',
      complete,
      applyAutoTitle: apply,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('t1', 'Auth fix');
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @nomi-ai/ai-chat test -- cliSmartTitle.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `packages/ai-chat/src/services/cliSmartTitle.ts`**

```ts
import { splitRef } from './nomiModel';
import { generateSmartTitle, type TitleComplete } from './sessionTitle';
import type { HarnessTabMeta } from './harnessClient';

export async function maybeSmartTitleCliTab(opts: {
  tab: Pick<HarnessTabMeta, 'id' | 'source' | 'modelOverride' | 'lastServedRef' | 'backend'>;
  userText: string;
  complete: TitleComplete;
  applyAutoTitle: (id: string, title: string) => Promise<unknown>;
}): Promise<void> {
  const ref = opts.tab.source === 'thirdParty' ? opts.tab.modelOverride || opts.tab.lastServedRef || null : null;
  if (!ref || !splitRef(ref)) return; // official / no free-form gateway model → heuristic only
  const title = await generateSmartTitle(opts.userText, opts.complete);
  if (!title) return;
  await opts.applyAutoTitle(opts.tab.id, title);
}
```

`complete` for third-party must call chat with that provider/model:

```ts
async (messages) => {
  const r = splitRef(ref)!;
  const resp = await api.chat.sendMessage({
    messages,
    role: 'chat',
    provider: r.provider,
    model: r.model,
  });
  return typeof resp?.content === 'string' ? resp.content.trim() : '';
};
```

Add `harnessClient.applyAutoTitle` mirroring `renameTab`.

Call `maybeSmartTitleCliTab` from the CLI send success path in `App.tsx` / input mode props (fire-and-forget after `onSend` / `sendTabReply` is invoked with the same text the user sent). Do not await inside the send UI path.

Manual sidebar rename already goes through `tabs.rename` → harness `renameTab` which clears pending (Task 3).

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @nomi-ai/ai-chat test -- cliSmartTitle.test.ts cliTabSync.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/services/cliSmartTitle.ts \
  packages/ai-chat/tests/cliSmartTitle.test.ts \
  packages/ai-chat/src/services/harnessClient.ts \
  packages/ai-chat/src/App.tsx \
  packages/ai-chat/src/contexts/HarnessTabsContext.tsx
git commit -m "$(cat <<'EOF'
feat(ai-chat): smart CLI titles for third-party tab models

EOF
)"
```

---

### Task 7: Composer draft store (`draftKey` + Map) unit tests

**Files:**

- Create: `packages/ai-chat/src/services/composerDrafts.ts`
- Test: `packages/ai-chat/tests/composerDrafts.test.ts`

**Interfaces:**

```ts
export const SHARED_UNSENT = 'SHARED_UNSENT';

export interface ComposerDraft {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
}

export interface DraftSessionRef {
  kind: 'nomi' | 'tab';
  id: string;
  /** Nomi: messages.length; CLI: !!cliSessionId || carriedMessages > 0 */
  hasCommittedUserContent: boolean;
}

export function draftKey(ref: DraftSessionRef | null): string;

export function createComposerDraftStore(initial?: Map<string, ComposerDraft>): {
  read(key: string): ComposerDraft;
  write(key: string, draft: ComposerDraft): void;
  clear(key: string): void;
  dropPrivate(key: string): void; // delete map entry (session deleted)
};
```

Empty draft constant: `{ text: '', images: [], files: [] }`.

`draftKey`:

- `null` ref → `SHARED_UNSENT`
- `!hasCommittedUserContent` → `SHARED_UNSENT`
- else `nomi:${id}` or `tab:${id}`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { SHARED_UNSENT, createComposerDraftStore, draftKey } from '../src/services/composerDrafts';

describe('draftKey', () => {
  it('uses SHARED_UNSENT for empty Nomi and empty CLI', () => {
    expect(draftKey({ kind: 'nomi', id: 'c1', hasCommittedUserContent: false })).toBe(SHARED_UNSENT);
    expect(draftKey({ kind: 'tab', id: 't1', hasCommittedUserContent: false })).toBe(SHARED_UNSENT);
  });
  it('uses private keys after send', () => {
    expect(draftKey({ kind: 'nomi', id: 'c1', hasCommittedUserContent: true })).toBe('nomi:c1');
    expect(draftKey({ kind: 'tab', id: 't1', hasCommittedUserContent: true })).toBe('tab:t1');
  });
});

describe('createComposerDraftStore', () => {
  it('shares one bucket across empty sessions; send clear empties SHARED', () => {
    const s = createComposerDraftStore();
    s.write(SHARED_UNSENT, { text: 'hello', images: [], files: [] });
    expect(s.read(SHARED_UNSENT).text).toBe('hello');
    s.clear(SHARED_UNSENT);
    expect(s.read(SHARED_UNSENT).text).toBe('');
  });

  it('isolates private follow-up drafts', () => {
    const s = createComposerDraftStore();
    s.write('nomi:a', { text: 'a-draft', images: [], files: [] });
    s.write('tab:b', { text: 'b-draft', images: [], files: [] });
    expect(s.read('nomi:a').text).toBe('a-draft');
    expect(s.read('tab:b').text).toBe('b-draft');
    s.dropPrivate('nomi:a');
    expect(s.read('nomi:a').text).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @nomi-ai/ai-chat test -- composerDrafts.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement store**

```ts
import type { FileAttachment } from './fileAttachments';
import type { ImageAttachment } from '../types/chat'; // use the same ImageAttachment type MessageInput uses

export const SHARED_UNSENT = 'SHARED_UNSENT';

export interface ComposerDraft {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
}

export interface DraftSessionRef {
  kind: 'nomi' | 'tab';
  id: string;
  hasCommittedUserContent: boolean;
}

const EMPTY: ComposerDraft = { text: '', images: [], files: [] };

export function draftKey(ref: DraftSessionRef | null): string {
  if (!ref || !ref.hasCommittedUserContent) return SHARED_UNSENT;
  return ref.kind === 'nomi' ? `nomi:${ref.id}` : `tab:${ref.id}`;
}

export function createComposerDraftStore(initial?: Map<string, ComposerDraft>) {
  const map = initial ?? new Map<string, ComposerDraft>();
  return {
    read(key: string): ComposerDraft {
      return map.get(key) ?? { ...EMPTY, images: [], files: [] };
    },
    write(key: string, draft: ComposerDraft): void {
      map.set(key, {
        text: draft.text,
        images: [...draft.images],
        files: [...draft.files],
      });
    },
    clear(key: string): void {
      map.set(key, { text: '', images: [], files: [] });
    },
    dropPrivate(key: string): void {
      if (key === SHARED_UNSENT) return;
      map.delete(key);
    },
  };
}
```

Fix `ImageAttachment` import to the exact path MessageInput already uses (`../types/chat` or local type in MessageInput — match it).

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @nomi-ai/ai-chat test -- composerDrafts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/services/composerDrafts.ts \
  packages/ai-chat/tests/composerDrafts.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-chat): composer draft key store

EOF
)"
```

---

### Task 8: Wire MessageInput / App / fillComposer to draft store

**Files:**

- Modify: `packages/ai-chat/src/App.tsx`
- Modify: `packages/ai-chat/src/components/MessageInput/index.tsx`
- Test: `packages/ai-chat/tests/composerDraftSwitch.test.tsx` (new component/integration-style test with a thin harness)

**Interfaces:**

- Consumes: `createComposerDraftStore`, `draftKey`, `ComposerDraft`, existing `composerFill` / `fill`
- Produces: MessageInput props:

```ts
draftSession: DraftSessionRef | null;
draftStore: ReturnType<typeof createComposerDraftStore>;
```

Or a single `draftKey: string` plus store callbacks — prefer passing `draftKey` string + store object so MessageInput does not re-derive identity.

Behavior:

1. `App` creates `const draftStoreRef = useRef(createComposerDraftStore()).current` **above** the settings keepalive split (same component that always mounts the chat shell at line ~819 `chat-keepalive`).
2. Compute `activeDraftRef`:
   - CLI tab active: `{ kind: 'tab', id: tab.id, hasCommittedUserContent: !!tab.cliSessionId || (tab.carriedMessages ?? 0) > 0 }`
   - else Nomi: `{ kind: 'nomi', id: currentConversationId, hasCommittedUserContent: (store.getMessages(id)?.length ?? 0) > 0 }` — count any stored messages as committed content (user or assistant); empty new chat → shared.
3. `const key = draftKey(activeDraftRef)`.
4. MessageInput: on `draftKey` change, stash `{ message, images, files }` into previous key, hydrate next (setState). Do **not** remount via React `key=` on the whole MessageInput.
5. On send clear (every existing `setMessage('')` path that clears after enqueue/send): also `draftStore.clear(activeKeyAtSend)`.
6. `fill` effect: when `composerFill` arrives, append/set text on the **visible** composer and `draftStore.write(currentKey, …)`.
7. Session delete: `draftStore.dropPrivate('nomi:id'|'tab:id')`.

- [ ] **Step 1: Write failing switch test**

```tsx
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useComposerDraftBinding } from '../src/hooks/useComposerDraftBinding';
import { createComposerDraftStore, SHARED_UNSENT } from '../src/services/composerDrafts';

// Prefer extracting a tiny hook `useComposerDraftBinding` used by MessageInput
// so the switch logic is unit-testable without mounting the full composer.

describe('useComposerDraftBinding', () => {
  it('keeps shared text across empty sessions; isolates after send', () => {
    const store = createComposerDraftStore();
    const { result, rerender } = renderHook(({ key }) => useComposerDraftBinding(store, key), {
      initialProps: { key: SHARED_UNSENT },
    });
    act(() => result.current.setText('shared'));
    rerender({ key: SHARED_UNSENT }); // simulate switch empty→empty
    expect(result.current.text).toBe('shared');

    act(() => {
      result.current.clearActive(); // send
    });
    expect(store.read(SHARED_UNSENT).text).toBe('');

    act(() => result.current.setText('follow-a'));
    // after send, App would pass nomi:a
    rerender({ key: 'nomi:a' });
    expect(result.current.text).toBe('follow-a');
    rerender({ key: 'nomi:b' });
    expect(result.current.text).toBe('');
    rerender({ key: 'nomi:a' });
    expect(result.current.text).toBe('follow-a');
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @nomi-ai/ai-chat test -- composerDraftSwitch.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement hook + wire**

Create `packages/ai-chat/src/hooks/useComposerDraftBinding.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComposerDraft } from '../services/composerDrafts';

export function useComposerDraftBinding(
  store: {
    read(key: string): ComposerDraft;
    write(key: string, d: ComposerDraft): void;
    clear(key: string): void;
  },
  draftKey: string,
) {
  const keyRef = useRef(draftKey);
  const [text, setText] = useState(() => store.read(draftKey).text);
  const [images, setImages] = useState(() => store.read(draftKey).images);
  const [files, setFiles] = useState(() => store.read(draftKey).files);

  useEffect(() => {
    if (keyRef.current === draftKey) return;
    store.write(keyRef.current, { text, images, files });
    const next = store.read(draftKey);
    keyRef.current = draftKey;
    setText(next.text);
    setImages(next.images);
    setFiles(next.files);
    // eslint: intentional hydrate on key change only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Persist edits into active key (debounce not required — write on each change is fine for memory Map)
  useEffect(() => {
    store.write(keyRef.current, { text, images, files });
  }, [text, images, files, store]);

  const clearActive = useCallback(() => {
    setText('');
    setImages([]);
    setFiles([]);
    store.clear(keyRef.current);
  }, [store]);

  return { text, setText, images, setImages, files, setFiles, clearActive };
}
```

Refactor `MessageInput` to use this hook when `draftStore` + `draftKey` props are provided; keep local `useState` fallback only if props omitted (tests that mount MessageInput alone). Replace send-time `setMessage('')` (+ image/file clears) with `clearActive()`.

In `App.tsx`, construct store once, compute `draftKey`, pass props. Ensure Settings overlay still mounts the keepalive tree that owns MessageInput.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @nomi-ai/ai-chat test -- composerDraftSwitch.test.tsx composerDrafts.test.ts
```

Expected: PASS. Also spot-check MessageInput-related tests if any break:

```bash
pnpm --filter @nomi-ai/ai-chat test -- composerLayout.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/hooks/useComposerDraftBinding.ts \
  packages/ai-chat/src/components/MessageInput/index.tsx \
  packages/ai-chat/src/App.tsx \
  packages/ai-chat/tests/composerDraftSwitch.test.tsx
git commit -m "$(cat <<'EOF'
feat(ai-chat): isolate composer drafts by session

EOF
)"
```

---

### Task 9: Changeset + verify related tests

**Files:**

- Create: `.changeset/session-title-draft-collapse.md`

- [ ] **Step 1: Add changeset**

```md
---
'@nomi-ai/ai-chat': patch
'@nomi-ai/host-electron': patch
---

会话首条消息后用当前已选模型后台生成智能标题（失败则截取约 30 字）；空会话共用一份输入草稿、发出后按会话 id 隔离；侧栏「本机历史」可折叠（默认展开不记住）；工作台底部用量卡可折叠并记住偏好。
```

- [ ] **Step 2: Run verification suite**

```bash
pnpm check:i18n
pnpm --filter @nomi-ai/ai-chat test -- historySidebar.test.tsx endpointInfo.test.tsx sessionTitle.test.ts history.test.ts cliSmartTitle.test.ts composerDrafts.test.ts composerDraftSwitch.test.tsx
pnpm --filter @nomi-ai/core exec jest --watchman=false tests/unit/cli/HarnessTabs.test.ts
cd apps/desktop-go && go test ./internal/core/cli/harness/ -count=1
```

Expected: all green. Fix any fallout before committing.

- [ ] **Step 3: Commit**

```bash
git add .changeset/session-title-draft-collapse.md
git commit -m "$(cat <<'EOF'
chore(changeset): session title, draft isolation, collapse

EOF
)"
```

---

## Self-review

**1. Spec coverage**

| Spec requirement                                                                                          | Task      |
| --------------------------------------------------------------------------------------------------------- | --------- |
| Local history fold, default expanded, no persist                                                          | Task 1    |
| Endpoint card fold + `cd.sidebar.endpointCardCollapsed` `'1'`/`'0'`                                       | Task 2    |
| CLI send-time heuristic ~30 chars + `changed()`                                                           | Task 3    |
| Go parity for heuristic / pending / apply                                                                 | Task 4    |
| Smart title helper, current chat model, Nomi apply, attachments-only skip, manual rename wins via pending | Task 5    |
| CLI smart title only when free-form model exists; official → heuristic only; `applyAutoTitle` gate        | Task 6    |
| `SHARED_UNSENT` + private keys; never cwd                                                                 | Task 7    |
| App/MessageInput/fillComposer wiring; survive settings keepalive; no full remount                         | Task 8    |
| Changeset + verify                                                                                        | Task 9    |
| i18n four keys zh/en + Go embed copy                                                                      | Tasks 1–2 |
| `autoTitlePending` vs `isGeneratedTabTitle`                                                               | Tasks 3–6 |
| Electron + Go hosts                                                                                       | Tasks 3–4 |

**2. Placeholder scan:** No TBD/TODO left; prompts, storage encoding, key names, and skip rules are concrete.

**3. Type consistency:** `SHARED_UNSENT`, `draftKey`, `ComposerDraft`, `applyAutoTitle`, `armNomiAutoTitle` / `clearNomiAutoTitle`, `generateSmartTitle`, `TitleComplete`, `HEURISTIC_MAX=30`, `TITLE_MAX=40` used consistently across tasks.
