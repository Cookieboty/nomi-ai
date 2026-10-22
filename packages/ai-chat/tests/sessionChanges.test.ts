import { describe, expect, it } from 'vitest';

import type { ConvMessage } from '../src/types/conversation';
import { reconstructOldText } from '../src/utils/diffReconstruct';
import {
  aggregateSessionChanges,
  aggregateTurnChanges,
  buildChangeFileTree,
  projectNameFromCwd,
  splitPathDisplay,
  summarizeChanges,
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
