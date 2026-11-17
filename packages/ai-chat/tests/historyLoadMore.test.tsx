// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoryBackend, HistorySession } from '../src/services/historyClient';

const listMock = vi.hoisted(() => vi.fn());

vi.mock('../src/services/historyClient', async (orig) => {
  const real = await orig<typeof import('../src/services/historyClient')>();
  return {
    ...real,
    historyClient: {
      available: () => true,
      list: listMock,
      open: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const { useCliHistory } = await import('../src/hooks/useCliHistory');

afterEach(() => {
  cleanup();
  listMock.mockReset();
});

const item = (i: number): HistorySession =>
  ({
    key: `claude:s${i}`,
    backend: 'claude',
    sessionId: `s${i}`,
    title: `会话${i}`,
    updatedAt: 1000 - i,
  }) as HistorySession;

const page = (from: number, count: number, hasMore: boolean) => ({
  items: Array.from({ length: count }, (_, k) => item(from + k)),
  nextOffset: hasMore ? from + count : null,
  hasMore,
});

const backends: HistoryBackend[] = ['claude'];

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });

describe('侧栏「加载更多」', () => {
  it('点一次能多加载一页，并且窗口重新聚焦不会被打回第一页', async () => {
    listMock
      .mockResolvedValueOnce(page(0, 20, true)) // 首屏
      .mockResolvedValueOnce(page(20, 20, true)) // loadMore
      .mockResolvedValueOnce(page(0, 20, true)); // focus 触发的整页重载（不该发生）

    const { result } = renderHook(() => useCliHistory(true, backends, 'v1'));
    await settle();
    expect(result.current.items('claude')).toHaveLength(20);

    act(() => result.current.loadMore('claude'));
    await settle();
    expect(result.current.items('claude')).toHaveLength(40);

    // 窗口失焦再聚焦：已展开的列表不该被重置回 20 条
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(result.current.items('claude')).toHaveLength(40);
  });

  it('整页重载打断了 loadMore 时，不能把 loading 卡在 true（否则按钮永久禁用）', async () => {
    let releaseMore: (v: unknown) => void = () => undefined;
    listMock
      .mockResolvedValueOnce(page(0, 20, true)) // 首屏
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseMore = resolve;
          }),
      ) // loadMore 挂着
      .mockResolvedValueOnce(page(0, 20, true)); // 中途来一次整页重载

    const { result } = renderHook(() => useCliHistory(true, backends, 'v1'));
    await settle();

    act(() => result.current.loadMore('claude'));
    // 还没返回时切了窗口焦点 → 整页重载作废这一页
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();

    await act(async () => {
      releaseMore(page(20, 20, true));
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.loading).toBe(false);
    // 解锁之后还能继续加载
    listMock.mockResolvedValueOnce(page(20, 20, true));
    act(() => result.current.loadMore('claude'));
    await settle();
    expect(result.current.items('claude').length).toBeGreaterThan(20);
  });
});
