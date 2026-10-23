// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGitBranch } from '../src/hooks/useGitBranch';

const mock = (reply: unknown) => {
  const invoke = vi.fn(async (ch: string) => (ch === 'ai:harness:git-branch' ? reply : null));
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
};
afterEach(() => {
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('useGitBranch（右栏「改动 · 文件」顶部的分支）', () => {
  it('分支名 / 游离 HEAD 的短提交号 / 不是仓库时 null', async () => {
    const invoke = mock({ branch: 'merge/202610' });
    const a = renderHook(() => useGitBranch('/w/proj'));
    await waitFor(() => expect(a.result.current).toBe('merge/202610'));
    expect(invoke).toHaveBeenCalledWith('ai:harness:git-branch', '/w/proj');
    a.unmount();

    mock({ branch: null, detached: 'abc1234' });
    const d = renderHook(() => useGitBranch('/w/proj'));
    await waitFor(() => expect(d.result.current).toBe('abc1234'));
    d.unmount();

    mock(null);
    const n = renderHook(() => useGitBranch('/w/proj'));
    await waitFor(() => expect(n.result.current).toBeNull());
  });

  it('运行中不读；跑完、手动刷新（nonce）时重读', async () => {
    const invoke = mock({ branch: 'main' });
    const h = renderHook(({ running, nonce }) => useGitBranch('/w', running, nonce), {
      initialProps: { running: true, nonce: 0 },
    });
    expect(invoke).not.toHaveBeenCalled();
    h.rerender({ running: false, nonce: 0 });
    await waitFor(() => expect(h.result.current).toBe('main'));
    h.rerender({ running: false, nonce: 1 });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });
});
