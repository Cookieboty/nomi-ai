// @vitest-environment happy-dom
/** 操作进行中切换工作区：旧操作晚到的结果不写进新工作区（#152） */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGitOps } from '../src/components/SessionWorkspace/GitCommitBox';
import { harnessClient, type GitOpResult } from '../src/services/harnessClient';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    gitDiscard: vi.fn(),
    gitDiscardUndo: vi.fn(async () => ({ ok: true })),
    gitSuggestMessage: vi.fn(),
    gitCommit: vi.fn(),
  },
}));

const h = vi.mocked(harnessClient);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => vi.clearAllMocks());

describe('useGitOps 工作区归属', () => {
  it('A 放弃 → 切到 B → A 完成：B 没有可撤销的提示，撤销也不会发到 B', async () => {
    window.confirm = vi.fn(() => true);
    const d = deferred<GitOpResult & { stashes?: string[] }>();
    h.gitDiscard.mockReturnValue(d.promise as never);
    const { result, rerender } = renderHook(({ cwd }) => useGitOps(cwd, () => {}), {
      initialProps: { cwd: '/repo/a' },
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.discard(['x.ts']);
    });
    rerender({ cwd: '/repo/b' });
    await act(async () => {
      d.resolve({ ok: true, stashes: ['c'.repeat(40)] });
      await pending;
    });
    expect(result.current.notice).toBeNull();
    await act(() => result.current.undo());
    expect(h.gitDiscardUndo).not.toHaveBeenCalled();
  });

  it('生成的提交信息晚到时不填进新工作区的输入框', async () => {
    const d = deferred<GitOpResult>();
    h.gitSuggestMessage.mockReturnValue(d.promise as never);
    const { result, rerender } = renderHook(({ cwd }) => useGitOps(cwd, () => {}), {
      initialProps: { cwd: '/repo/a' },
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.suggest(undefined);
    });
    rerender({ cwd: '/repo/b' });
    act(() => result.current.setMessage('draft for b'));
    await act(async () => {
      d.resolve({ ok: true, message: 'feat: for a' });
      await pending;
    });
    expect(result.current.message).toBe('draft for b');
  });

  it('同一工作区：放弃后撤销照常发给原工作区', async () => {
    window.confirm = vi.fn(() => true);
    h.gitDiscard.mockResolvedValue({ ok: true, stashes: ['d'.repeat(40)] } as never);
    const { result } = renderHook(() => useGitOps('/repo/a', () => {}));
    await act(() => result.current.discard(['x.ts']));
    expect(result.current.notice?.undo).toBeTruthy();
    await act(() => result.current.undo());
    expect(h.gitDiscardUndo).toHaveBeenCalledWith('/repo/a', ['d'.repeat(40)]);
  });
});
