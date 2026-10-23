import { describe, expect, it } from 'vitest';

import type { ConvMessage } from '../src/types/conversation';
import { reconstructOldText } from '../src/utils/diffReconstruct';
import {
  aggregateSessionChanges,
  aggregateTurnChanges,
  buildChangeFileTree,
  mergeWorkspaceAndChanges,
  projectNameFromCwd,
  splitPathDisplay,
  summarizeChanges,
  type ChangeEntry,
} from '../src/utils/sessionChanges';
import { undoTurnChanges } from '../src/utils/undoTurnChanges';

describe('aggregateSessionChanges', () => {
  it('collects edit diffs from assistant traces', () => {
    const messages: ConvMessage[] = [
      { id: 'u1', role: 'user', text: 'edit', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        text: 'done',
        at: 2,
        trace: [
          {
            type: 'tool',
            name: 'Edit',
            status: 'done',
            input: JSON.stringify({
              file_path: 'src/a.ts',
              old_string: 'foo\n',
              new_string: 'bar\n',
            }),
          },
        ],
      },
    ];
    const changes = aggregateSessionChanges(messages);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]!.file).toContain('a.ts');
    expect(changes[0]!.added + changes[0]!.removed).toBeGreaterThan(0);
    expect(changes[0]!.letter).toMatch(/[MAD?]/);
    expect(changes[0]!.messageId).toBe('a1');
  });

  it('later write wins same path; summarize totals', () => {
    const messages: ConvMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        at: 1,
        trace: [
          {
            type: 'tool',
            name: 'Write',
            status: 'done',
            input: JSON.stringify({ file_path: 'f.txt', content: 'one' }),
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        text: '',
        at: 2,
        trace: [
          {
            type: 'tool',
            name: 'Write',
            status: 'done',
            input: JSON.stringify({ file_path: 'f.txt', content: 'two\nlines' }),
          },
        ],
      },
    ];
    const changes = aggregateSessionChanges(messages);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.messageId).toBe('a2');
    const s = summarizeChanges(changes);
    expect(s.files).toBe(1);
  });
});

describe('aggregateTurnChanges / tree / undo', () => {
  it('aggregates only one assistant turn', () => {
    const a1: ConvMessage = {
      id: 'a1',
      role: 'assistant',
      text: '',
      at: 1,
      trace: [
        {
          type: 'tool',
          name: 'Edit',
          status: 'done',
          input: JSON.stringify({
            file_path: 'src/a.ts',
            old_string: 'a\n',
            new_string: 'b\n',
          }),
        },
      ],
    };
    const a2: ConvMessage = {
      id: 'a2',
      role: 'assistant',
      text: '',
      at: 2,
      trace: [
        {
          type: 'tool',
          name: 'Write',
          status: 'done',
          input: JSON.stringify({ file_path: 'src/b.ts', content: 'x\n' }),
        },
      ],
    };
    expect(
      aggregateTurnChanges(a1)
        .map((e) => e.file)
        .join(','),
    ).toContain('a.ts');
    expect(aggregateTurnChanges(a1)).toHaveLength(1);
    expect(aggregateTurnChanges(a2)[0]!.messageId).toBe('a2');
  });

  it('builds nested file tree and path display', () => {
    const entries = [
      {
        file: 'packages/electron/src/a.ts',
        added: 1,
        removed: 0,
        status: 'modified' as const,
        letter: 'M' as const,
        messageId: 'm',
      },
      {
        file: 'packages/electron/src/b.ts',
        added: 2,
        removed: 1,
        status: 'modified' as const,
        letter: 'M' as const,
        messageId: 'm',
      },
      {
        file: 'packages/ai-chat/x.ts',
        added: 3,
        removed: 0,
        status: 'added' as const,
        letter: 'A' as const,
        messageId: 'm',
      },
    ];
    const tree = buildChangeFileTree(entries);
    expect(tree.some((n) => n.kind === 'dir' && n.name === 'packages')).toBe(true);
    const { dir, name } = splitPathDisplay('packages/ai-chat/x.ts');
    expect(dir).toBe('packages/ai-chat/');
    expect(name).toBe('x.ts');
    expect(projectNameFromCwd('/tmp/nomi-ai')).toBe('nomi-ai');
  });

  it('undo prefers reconstruct then delete for added', async () => {
    const writes: { rel: string; content: string }[] = [];
    const removes: string[] = [];
    const entryEdit = {
      file: 'a.ts',
      added: 1,
      removed: 1,
      status: 'modified' as const,
      letter: 'M' as const,
      messageId: 'm',
      diff: {
        file: 'a.ts',
        diff: {
          added: 1,
          removed: 1,
          lines: [
            { type: 'del' as const, text: 'old', oldNo: 1 },
            { type: 'add' as const, text: 'new', newNo: 1 },
          ],
        },
      },
    };
    expect(reconstructOldText(entryEdit.diff.diff)).toBe('old');
    const r1 = await undoTurnChanges('/cwd', [entryEdit], {
      write: async (_c, rel, content) => {
        writes.push({ rel, content });
        return { ok: true };
      },
      remove: async () => ({ ok: true }),
    });
    expect(r1[0]!.method).toBe('diff');
    expect(writes[0]!.content).toBe('old');

    const entryAdd = {
      file: 'new.ts',
      added: 1,
      removed: 0,
      status: 'added' as const,
      letter: 'A' as const,
      messageId: 'm',
      diff: {
        file: 'new.ts',
        summaryOnly: true as const,
        diff: { added: 1, removed: 0, lines: [] },
      },
    };
    const r2 = await undoTurnChanges('/cwd', [entryAdd], {
      write: async () => ({ ok: true }),
      remove: async (_c, rel) => {
        removes.push(rel);
        return { ok: true };
      },
    });
    expect(r2[0]!.method).toBe('delete');
    expect(removes[0]).toContain('new.ts');
  });
});

describe('mergeWorkspaceAndChanges', () => {
  it('annotates disk files and keeps unchanged without stats', () => {
    const disk = [
      {
        kind: 'dir' as const,
        name: 'src',
        path: 'src',
        children: [
          { kind: 'file' as const, name: 'a.ts', path: 'src/a.ts' },
          { kind: 'file' as const, name: 'b.ts', path: 'src/b.ts' },
        ],
      },
    ];
    const changes: ChangeEntry[] = [
      {
        file: 'src/a.ts',
        added: 2,
        removed: 1,
        status: 'modified',
        letter: 'M',
        messageId: 'm1',
      },
    ];
    const tree = mergeWorkspaceAndChanges(disk, changes);
    expect(tree[0]?.kind).toBe('dir');
    if (tree[0]?.kind !== 'dir') return;
    const a = tree[0].children.find((c) => c.kind === 'file' && c.name === 'a.ts');
    const b = tree[0].children.find((c) => c.kind === 'file' && c.name === 'b.ts');
    expect(a && a.kind === 'file' && a.entry?.added).toBe(2);
    expect(b && b.kind === 'file' && b.entry).toBeUndefined();
  });

  it('inserts changed paths missing on disk', () => {
    const changes: ChangeEntry[] = [
      {
        file: 'new/x.ts',
        added: 1,
        removed: 0,
        status: 'added',
        letter: 'A',
        messageId: 'm1',
      },
    ];
    const tree = mergeWorkspaceAndChanges([], changes);
    expect(tree.some((n) => n.kind === 'dir' && n.name === 'new')).toBe(true);
  });
});

describe('change tree relative to cwd', () => {
  const entry = (file: string) => ({
    file,
    added: 1,
    removed: 0,
    status: 'modified' as const,
    letter: 'M' as const,
    messageId: 'm',
  });
  const cwd = '/Users/me/proj';

  it('groups by cwd-relative path and compacts single-child chains', () => {
    const tree = buildChangeFileTree(
      [entry(`${cwd}/packages/ai-chat/src/a.ts`), entry(`${cwd}/packages/ai-chat/src/b.ts`)],
      { cwd, compact: true },
    );
    expect(tree).toHaveLength(1);
    const dir = tree[0]!;
    expect(dir.kind === 'dir' && dir.name).toBe('packages/ai-chat/src');
    // 文件节点保留原路径（选中 / 定位用）
    expect(dir.kind === 'dir' && dir.children.map((c) => c.path)).toEqual([
      `${cwd}/packages/ai-chat/src/a.ts`,
      `${cwd}/packages/ai-chat/src/b.ts`,
    ]);
  });

  it('merges absolute change paths onto the relative disk tree', () => {
    const disk = [
      {
        kind: 'dir' as const,
        name: 'src',
        path: 'src',
        children: [{ kind: 'file' as const, name: 'a.ts', path: 'src/a.ts' }],
      },
    ];
    const tree = mergeWorkspaceAndChanges(disk, [entry(`${cwd}/src/a.ts`)], cwd);
    expect(tree).toHaveLength(1);
    const src = tree[0]!;
    expect(src.kind === 'dir' && src.children).toHaveLength(1);
    const file = src.kind === 'dir' ? src.children[0]! : null;
    expect(file?.kind === 'file' && file.entry?.file).toBe(`${cwd}/src/a.ts`);
  });
});
