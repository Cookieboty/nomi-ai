# Composer `@` Path Mention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the chat composer open a workspace path picker on `@` and insert `@relative/path` (directories as `@dir/`) without creating attachment chips.

**Architecture:** Pure helpers in `packages/ai-chat/src/slash/` detect the active `@` token, flatten/filter `WorkspaceTreeNode`s, and apply replacements. A thin `AtPathPalette` (styled like `SlashPalette`) is driven from `MessageInput` keyboard handling. Tree data comes from existing `harnessClient.workspaceList(cwd)`. `App.tsx` passes the same workspace cwd used by the files rail (`railCwd`), not `slashCwd` (which is empty for the Nomi backend).

**Tech Stack:** React + TypeScript in `@nomi-ai/ai-chat`, Vitest, existing harness IPC (`harness.workspaceList`), `@nomi-ai/ui` `t()` + `@nomi-ai/i18n` locale JSON.

## Global Constraints

- Insert text only: `@rel` or `@dir/` — never `FileAttachment` / chips.
- No palette when `cwd` is empty/null; `@` stays a normal character.
- Trigger: any `@` that starts the active token under the caret (including mid-string); Esc dismisses.
- Files and directories are both selectable; directory insert includes trailing `/`.
- Do not change slash `/` behavior; when both could apply, prefer existing slash rules if the line starts with `/` and slash palette is open — `@` palette only when slash/agent/model palettes are not open.
- Cap filtered results at 50 entries.
- Spec: `docs/superpowers/specs/2026-11-03-composer-at-path-mention-design.md`.

## File map

| File                                                             | Role                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/ai-chat/src/slash/atPathComplete.ts`                   | Pure: token detect, replace, flatten tree, filter/rank |
| `packages/ai-chat/tests/atPathComplete.test.ts`                  | Unit tests for helpers                                 |
| `packages/ai-chat/src/components/AtPathPalette/index.tsx`        | Floating list UI                                       |
| `packages/ai-chat/src/components/AtPathPalette/index.module.css` | Reuse SlashPalette visual tokens where possible        |
| `packages/ai-chat/src/components/MessageInput/index.tsx`         | Wire open/keyboard/replace; load tree                  |
| `packages/ai-chat/src/App.tsx`                                   | Pass `cwd={railCwd ?? undefined}` into `MessageInput`  |
| `packages/i18n/src/locales/zh/ui/session-workspace.json`         | Empty / label strings (zh source of truth)             |
| `packages/i18n/src/locales/en/ui/session-workspace.json`         | English strings                                        |
| `.changeset/composer-at-path-mention.md`                         | Changeset for `@nomi-ai/ai-chat` (and i18n if needed)  |

---

### Task 1: Pure `@` token helpers

**Files:**

- Create: `packages/ai-chat/src/slash/atPathComplete.ts`
- Test: `packages/ai-chat/tests/atPathComplete.test.ts`

**Interfaces:**

- Consumes: none (pure)
- Produces:
  - `export interface AtPathToken { start: number; end: number; query: string }`
  - `export function atPathToken(text: string, caret: number): AtPathToken | null`
  - `export function replaceAtPathToken(text: string, token: AtPathToken, insert: string): { text: string; caret: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { atPathToken, replaceAtPathToken } from '../src/slash/atPathComplete';

describe('atPathToken', () => {
  it('finds @query under the caret', () => {
    expect(atPathToken('see @src/Ap', 11)).toEqual({ start: 4, end: 11, query: 'src/Ap' });
  });
  it('opens on mid-string @ (email-like)', () => {
    expect(atPathToken('a@b', 3)).toEqual({ start: 1, end: 3, query: 'b' });
  });
  it('returns null when caret is not inside an @ token', () => {
    expect(atPathToken('hello', 5)).toBeNull();
    expect(atPathToken('x @y z', 1)).toBeNull();
  });
});

describe('replaceAtPathToken', () => {
  it('replaces the token and places caret after the insert', () => {
    const r = replaceAtPathToken('see @src/Ap please', { start: 4, end: 11, query: 'src/Ap' }, '@src/App.tsx');
    expect(r).toEqual({ text: 'see @src/App.tsx please', caret: 16 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathComplete.test.ts`

Expected: FAIL (module not found / exports missing)

- [ ] **Step 3: Write minimal implementation**

```ts
export interface AtPathToken {
  start: number;
  end: number;
  query: string;
}

/** Active @-token ending at caret: from nearest @ left of caret with no whitespace between @ and caret. */
export function atPathToken(text: string, caret: number): AtPathToken | null {
  const c = Math.max(0, Math.min(caret, text.length));
  const left = text.slice(0, c);
  const at = left.lastIndexOf('@');
  if (at < 0) return null;
  const between = left.slice(at + 1);
  if (/[\s\n]/.test(between)) return null;
  return { start: at, end: c, query: between };
}

export function replaceAtPathToken(text: string, token: AtPathToken, insert: string): { text: string; caret: number } {
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathComplete.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/slash/atPathComplete.ts packages/ai-chat/tests/atPathComplete.test.ts
git commit -m "feat(ai-chat): add @ path token parse and replace helpers"
```

---

### Task 2: Flatten, filter, and format path entries

**Files:**

- Modify: `packages/ai-chat/src/slash/atPathComplete.ts`
- Test: `packages/ai-chat/tests/atPathComplete.test.ts`

**Interfaces:**

- Consumes: `WorkspaceTreeNode` from `../services/harnessClient` (`kind`, `name`, `path`, `children?`)
- Produces:
  - `export interface AtPathOption { path: string; kind: 'file' | 'dir'; label: string }`
  - `export function flattenWorkspacePaths(nodes: readonly WorkspaceTreeNode[]): AtPathOption[]`
  - `export function filterAtPathOptions(options: readonly AtPathOption[], query: string, limit = 50): AtPathOption[]`
  - `export function formatAtPathInsert(option: AtPathOption): string` → `@path` or `@path/`

- [ ] **Step 1: Write the failing tests (append)**

```ts
import type { WorkspaceTreeNode } from '../src/services/harnessClient';
import { filterAtPathOptions, flattenWorkspacePaths, formatAtPathInsert } from '../src/slash/atPathComplete';

const tree: WorkspaceTreeNode[] = [
  {
    kind: 'dir',
    name: 'src',
    path: 'src',
    children: [
      { kind: 'file', name: 'App.tsx', path: 'src/App.tsx' },
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
    ],
  },
  { kind: 'file', name: 'README.md', path: 'README.md' },
];

describe('flattenWorkspacePaths', () => {
  it('lists files and dirs with relative paths', () => {
    const flat = flattenWorkspacePaths(tree);
    expect(flat).toEqual(
      expect.arrayContaining([
        { path: 'src', kind: 'dir', label: 'src' },
        { path: 'src/App.tsx', kind: 'file', label: 'App.tsx' },
        { path: 'README.md', kind: 'file', label: 'README.md' },
      ]),
    );
  });
});

describe('filterAtPathOptions', () => {
  it('prefers basename hits over path-only hits', () => {
    const all = flattenWorkspacePaths(tree);
    const hit = filterAtPathOptions(all, 'app');
    expect(hit[0]?.path).toBe('src/App.tsx');
  });
  it('matches path substrings case-insensitively', () => {
    const all = flattenWorkspacePaths(tree);
    expect(filterAtPathOptions(all, 'SRC/').some((o) => o.path === 'src/main.ts')).toBe(true);
  });
});

describe('formatAtPathInsert', () => {
  it('prefixes @ and adds trailing slash for dirs', () => {
    expect(formatAtPathInsert({ path: 'src/App.tsx', kind: 'file', label: 'App.tsx' })).toBe('@src/App.tsx');
    expect(formatAtPathInsert({ path: 'src', kind: 'dir', label: 'src' })).toBe('@src/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathComplete.test.ts`

Expected: FAIL on missing exports

- [ ] **Step 3: Write minimal implementation**

```ts
import type { WorkspaceTreeNode } from '../services/harnessClient';

export interface AtPathOption {
  path: string;
  kind: 'file' | 'dir';
  label: string;
}

export function flattenWorkspacePaths(nodes: readonly WorkspaceTreeNode[]): AtPathOption[] {
  const out: AtPathOption[] = [];
  const walk = (list: readonly WorkspaceTreeNode[]) => {
    for (const n of list) {
      out.push({ path: n.path.replace(/\\/g, '/'), kind: n.kind, label: n.name });
      if (n.kind === 'dir' && n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function filterAtPathOptions(options: readonly AtPathOption[], query: string, limit = 50): AtPathOption[] {
  const q = query.trim().toLowerCase();
  const scored = options
    .map((o) => {
      const path = o.path.toLowerCase();
      const base = o.label.toLowerCase();
      if (!q) return { o, score: 1 };
      if (base.includes(q)) return { o, score: 2 };
      if (path.includes(q)) return { o, score: 1 };
      return null;
    })
    .filter((x): x is { o: AtPathOption; score: number } => !!x)
    .sort((a, b) => b.score - a.score || a.o.path.localeCompare(b.o.path));
  return scored.slice(0, limit).map((x) => x.o);
}

export function formatAtPathInsert(option: AtPathOption): string {
  const p = option.path.replace(/\\/g, '/').replace(/\/+$/, '');
  return option.kind === 'dir' ? `@${p}/` : `@${p}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathComplete.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/slash/atPathComplete.ts packages/ai-chat/tests/atPathComplete.test.ts
git commit -m "feat(ai-chat): filter workspace paths for @ mention"
```

---

### Task 3: i18n strings for the palette

**Files:**

- Modify: `packages/i18n/src/locales/zh/ui/session-workspace.json`
- Modify: `packages/i18n/src/locales/en/ui/session-workspace.json`

**Interfaces:**

- Produces keys:
  - `ui.session-workspace.at-path-menu` = path menu aria label
  - `ui.session-workspace.at-path-empty` = empty state
  - `ui.session-workspace.at-path-dir` = optional dir suffix marker (can be unused if `/` in label is enough)

- [ ] **Step 1: Add zh keys**

In `packages/i18n/src/locales/zh/ui/session-workspace.json` add:

```json
  "ui.session-workspace.at-path-menu": "工作区路径",
  "ui.session-workspace.at-path-empty": "无匹配路径"
```

- [ ] **Step 2: Add en keys**

In `packages/i18n/src/locales/en/ui/session-workspace.json` add:

```json
  "ui.session-workspace.at-path-menu": "Workspace paths",
  "ui.session-workspace.at-path-empty": "No matching paths"
```

- [ ] **Step 3: Validate i18n**

Run: `cd /workspace/nomi-ai && pnpm check:i18n`

Expected: PASS (zh/en key sets match)

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/zh/ui/session-workspace.json packages/i18n/src/locales/en/ui/session-workspace.json
git commit -m "i18n: add @ path mention palette strings"
```

---

### Task 4: `AtPathPalette` component

**Files:**

- Create: `packages/ai-chat/src/components/AtPathPalette/index.tsx`
- Create: `packages/ai-chat/src/components/AtPathPalette/index.module.css`
- Test: `packages/ai-chat/tests/atPathPalette.test.tsx`

**Interfaces:**

- Consumes: `AtPathOption` from `../../slash/atPathComplete`
- Produces: `export const AtPathPalette: React.FC<{ options: readonly AtPathOption[]; active: number; query: string; onPick: (o: AtPathOption) => void; onHover: (i: number) => void }>`

- [ ] **Step 1: Write the failing RTL test**

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtPathPalette } from '../src/components/AtPathPalette';

afterEach(cleanup);

describe('AtPathPalette', () => {
  it('renders options and empty state', () => {
    const { rerender } = render(
      <AtPathPalette
        options={[{ path: 'src/App.tsx', kind: 'file', label: 'App.tsx' }]}
        active={0}
        query="App"
        onPick={vi.fn()}
        onHover={vi.fn()}
      />,
    );
    expect(screen.getByTestId('at-path-menu')).toBeTruthy();
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
    rerender(<AtPathPalette options={[]} active={0} query="zzz" onPick={vi.fn()} onHover={vi.fn()} />);
    expect(screen.getByTestId('at-path-empty')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathPalette.test.tsx`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement component + CSS**

Copy structure from `SlashPalette/index.tsx` / `index.module.css` (menu, empty, item, active). Show `option.path` as primary text; for dirs append `/` in the visible label if not already present. Use `data-testid="at-path-menu"` / `at-path-empty` / `at-path-item`. Call `t('ui.session-workspace.at-path-menu')` and `t('ui.session-workspace.at-path-empty')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathPalette.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/components/AtPathPalette packages/ai-chat/tests/atPathPalette.test.tsx
git commit -m "feat(ai-chat): add AtPathPalette UI"
```

---

### Task 5: Wire `MessageInput` + `App` cwd

**Files:**

- Modify: `packages/ai-chat/src/components/MessageInput/index.tsx`
- Modify: `packages/ai-chat/src/App.tsx` (pass `cwd={railCwd ?? undefined}`)
- Test: `packages/ai-chat/tests/atPathMention.input.test.tsx`

**Interfaces:**

- Consumes: helpers from Task 1–2, `AtPathPalette`, `harnessClient.workspaceList`
- Produces: new optional prop `cwd?: string | null` on `MessageInputProps`

Behavior rules to encode in the test and implementation:

1. `atOpen` only when `cwd` is non-empty, `atPathToken(message, caret)` non-null, and `!slashOpen && !agentOpen && !modelOpen`.
2. On open / cwd change: `harnessClient.workspaceList(cwd)` once (cache in state); flatten + `filterAtPathOptions`.
3. Keyboard: same as slash — ArrowUp/Down move `atIdx`; Enter/Tab pick; Esc close (`atClosed` guard like `agentClosed`).
4. Pick: `formatAtPathInsert` + `replaceAtPathToken`; set textarea caret to returned `caret`.
5. Do not create file chips.

- [ ] **Step 1: Write failing integration-style test**

Use existing MessageInput test patterns (see `composerLayout.test.tsx` / `fileAttachments.test.tsx` for render helpers). Minimal case:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/harnessClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/harnessClient')>();
  return {
    ...actual,
    harnessClient: {
      ...actual.harnessClient,
      available: () => true,
      workspaceList: vi.fn(async () => ({
        ok: true,
        entries: [
          {
            kind: 'dir',
            name: 'src',
            path: 'src',
            children: [{ kind: 'file', name: 'App.tsx', path: 'src/App.tsx' }],
          },
        ],
      })),
    },
  };
});

// Import MessageInput after mock; render with cwd="/tmp/proj", onSend=vi.fn(), minimal props.
// Type "@App", wait for at-path-menu, press Enter, expect textarea value to contain "@src/App.tsx".
```

Adapt imports/render to match how other MessageInput tests mount providers. If mounting full `MessageInput` is too heavy, test a small extracted hook `useAtPathMention` in the same file as the helpers — preferred only if existing tests do not mount MessageInput with textarea; otherwise prefer MessageInput.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathMention.input.test.tsx`

Expected: FAIL

- [ ] **Step 3: Implement wiring**

In `MessageInputProps` add `cwd?: string | null`. Track caret via `onSelect`/`onKeyUp`/`onClick` on the textarea (`selectionStart`). Compute token + `atOpen`. Load tree when `atOpen && cwd`. Render `{atOpen && <AtPathPalette ... />}` near slash palette. In `handleKeyDown`, handle `atOpen` before send, after/alongside agent/slash blocks (mirror agent block).

In `App.tsx` on `<MessageInput ... />` add `cwd={railCwd ?? undefined}`.

- [ ] **Step 4: Run tests**

Run:

```bash
cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathComplete.test.ts tests/atPathPalette.test.tsx tests/atPathMention.input.test.tsx
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ai-chat/src/components/MessageInput/index.tsx packages/ai-chat/src/App.tsx packages/ai-chat/tests/atPathMention.input.test.tsx
git commit -m "feat(ai-chat): wire @ path mention into composer"
```

---

### Task 6: Changeset + verification

**Files:**

- Create: `.changeset/composer-at-path-mention.md`

- [ ] **Step 1: Add changeset**

```md
---
'@nomi-ai/ai-chat': minor
'@nomi-ai/i18n': patch
---

Composer: type @ to insert a workspace-relative path (directories end with /).
```

(Adjust package names if ai-chat is not independently versioned — match neighboring changesets under `.changeset/`.)

- [ ] **Step 2: Full related test pass**

Run: `cd /workspace/nomi-ai/packages/ai-chat && pnpm test tests/atPathComplete.test.ts tests/atPathPalette.test.tsx tests/atPathMention.input.test.tsx`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add .changeset/composer-at-path-mention.md
git commit -m "chore(changeset): composer @ path mention"
```

---

## Spec coverage checklist

| Spec requirement                         | Task                |
| ---------------------------------------- | ------------------- |
| Insert `@rel` / `@dir/` text only        | 2, 5                |
| No palette without cwd                   | 5                   |
| Any-position `@` token                   | 1, 5                |
| Files + dirs selectable                  | 2, 4, 5             |
| Slash-palette-style UI                   | 4                   |
| Reuse workspace tree IPC                 | 5 (`workspaceList`) |
| TDD                                      | 1–5                 |
| No attachment chips / no people mentions | Global + Task 5     |

## Self-review notes

- Types `AtPathToken` / `AtPathOption` / `formatAtPathInsert` are consistent across tasks.
- `railCwd` is required because `slashCwd` is `''` for Nomi backend — covered in Task 5.
- No TBD placeholders remain; MessageInput mount details may need minor adaptation to existing test harness — keep behavior assertions unchanged.
