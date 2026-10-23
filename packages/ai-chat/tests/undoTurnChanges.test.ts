import { describe, expect, it, vi } from 'vitest';

import { reverseApplyDiff } from '../src/utils/diffReconstruct';
import type { ChangeEntry } from '../src/utils/sessionChanges';
import { diffsOf } from '../src/utils/toolTrace';
import { undoTurnChanges, type UndoIo } from '../src/utils/undoTurnChanges';

const FILE =
  ['line 1', 'line 2', 'export const a = 1;', 'line 4', 'line 5', 'line 6'].join('\n') + '\n';

function editCall(oldS: string, newS: string, name = 'Edit') {
  return {
    id: 'c1',
    name,
    status: 'done' as const,
    input: JSON.stringify({ file_path: 'src/a.ts', old_string: oldS, new_string: newS }),
  };
}

function entryOf(call: ReturnType<typeof editCall>): ChangeEntry {
  const d = diffsOf(call)[0]!;
  return {
    file: 'src/a.ts',
    added: d.diff.added,
    removed: d.diff.removed,
    status: d.diff.added && !d.diff.removed ? 'added' : 'modified',
    letter: 'M',
    diff: d,
    messageId: 'm1',
  };
}

function io(content: string | null): UndoIo & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    read: vi.fn(async () =>
      content == null ? { ok: false, code: 'not-found' } : { ok: true, content },
    ),
    write: vi.fn(async (_c, _r, text) => {
      writes.push(text);
      return { ok: true };
    }),
    remove: vi.fn(async () => ({ ok: true })),
    gitCheckout: vi.fn(async () => ({ ok: false, code: 'not-git' })),
  } as UndoIo & { writes: string[] };
}

describe('撤销本轮变更：只还原改动处，不覆盖整个文件', () => {
  it('Edit：把新片段换回旧片段，其余内容和结尾换行不动', async () => {
    const after = FILE.replace('export const a = 1;', 'export const a = 2;');
    const h = io(after);
    const res = await undoTurnChanges(
      '/w',
      [entryOf(editCall('export const a = 1;', 'export const a = 2;'))],
      h,
    );
    expect(res).toEqual([{ file: 'src/a.ts', ok: true, method: 'diff', error: undefined }]);
    expect(h.writes).toEqual([FILE]);
  });

  it('只新增行的 Edit（带上下文）撤销后不会把文件截成一小段，也不会删文件', async () => {
    const after = FILE.replace('line 4', 'line 4\ninserted');
    const h = io(after);
    const res = await undoTurnChanges('/w', [entryOf(editCall('line 4', 'line 4\ninserted'))], h);
    expect(res[0]!.ok).toBe(true);
    expect(h.writes).toEqual([FILE]);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('文件之后又被改过（找不到新片段）：拒绝，不写盘、不删除、不 checkout', async () => {
    const h = io('completely different\n');
    const res = await undoTurnChanges(
      '/w',
      [entryOf(editCall('export const a = 1;', 'export const a = 2;'))],
      h,
    );
    expect(res[0]).toMatchObject({ ok: false, error: 'changed' });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.gitCheckout).not.toHaveBeenCalled();
  });

  it('新片段出现多次（无法确定是哪一处）：拒绝', async () => {
    const h = io('x = 2;\ny = 2;\nx = 2;\n');
    const res = await undoTurnChanges('/w', [entryOf(editCall('x = 1;', 'x = 2;'))], h);
    expect(res[0]).toMatchObject({ ok: false, error: 'changed' });
    expect(h.write).not.toHaveBeenCalled();
  });

  it('CRLF 文件也能还原，保持 CRLF', async () => {
    const after = 'a\r\nexport const a = 2;\r\nb\r\n';
    const h = io(after);
    const res = await undoTurnChanges(
      '/w',
      [entryOf(editCall('a\nexport const a = 1;\nb', 'a\nexport const a = 2;\nb'))],
      h,
    );
    expect(res[0]!.ok).toBe(true);
    expect(h.writes).toEqual(['a\r\nexport const a = 1;\r\nb\r\n']);
  });

  it('整文件 Write：内容还是当时写入的 → 先 git checkout，失败则删除', async () => {
    const call = {
      id: 'w1',
      name: 'Write',
      status: 'done' as const,
      input: JSON.stringify({ file_path: 'src/new.ts', content: 'export const x = 1;\n' }),
    };
    const d = diffsOf(call)[0]!;
    const entry: ChangeEntry = {
      file: 'src/new.ts',
      added: d.diff.added,
      removed: 0,
      status: 'added',
      letter: 'A',
      diff: d,
      messageId: 'm1',
    };
    const h = io('export const x = 1;\n');
    const res = await undoTurnChanges('/w', [entry], h);
    expect(res[0]).toMatchObject({ ok: true, method: 'delete' });
    expect(h.gitCheckout).toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalled();

    // 之后被改过：不删
    const h2 = io('export const x = 1;\n// my later edit\n');
    const res2 = await undoTurnChanges('/w', [entry], h2);
    expect(res2[0]).toMatchObject({ ok: false, error: 'changed' });
    expect(h2.remove).not.toHaveBeenCalled();
  });

  it('没有读取能力时不猜测：报错而不是覆盖', async () => {
    const h = io(FILE);
    delete (h as { read?: unknown }).read;
    const res = await undoTurnChanges('/w', [entryOf(editCall('line 4', 'line 4\nx'))], h);
    expect(res[0]).toMatchObject({ ok: false, error: 'no-read' });
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('reverseApplyDiff', () => {
  it('多段 hunk 逐段还原', () => {
    const diff = {
      added: 2,
      removed: 2,
      lines: [
        { type: 'ctx' as const, text: 'a' },
        { type: 'del' as const, text: 'b' },
        { type: 'add' as const, text: 'B' },
        { type: 'hunk' as const, text: '…' },
        { type: 'ctx' as const, text: 'x' },
        { type: 'del' as const, text: 'y' },
        { type: 'add' as const, text: 'Y' },
      ],
    };
    expect(reverseApplyDiff('a\nB\nmid\nx\nY\nz\n', diff)).toBe('a\nb\nmid\nx\ny\nz\n');
    expect(reverseApplyDiff('nothing', diff)).toBeNull();
  });
});
