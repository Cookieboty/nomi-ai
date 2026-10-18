// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSendQueue } from '../src/hooks/useSendQueue';

describe('useSendQueue', () => {
  it('忙碌时只排队；空闲后按顺序逐条发送，不会并发派发', async () => {
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const send = vi.fn((text: string) => {
      sent.push(text);
      return new Promise<void>((r) => {
        release = r;
      });
    });
    const { result, rerender } = renderHook(({ busy }) => useSendQueue(busy, send), {
      initialProps: { busy: true },
    });
    act(() => {
      result.current.enqueue('一');
      result.current.enqueue('二');
    });
    expect(sent).toEqual([]);
    expect(result.current.queue).toEqual(['一', '二']);

    rerender({ busy: false });
    expect(sent).toEqual(['一']);
    expect(result.current.queue).toEqual(['二']);
    // 状态还没变忙碌时不会提前派发第二条
    rerender({ busy: false });
    expect(sent).toEqual(['一']);

    rerender({ busy: true });
    await act(async () => {
      release();
    });
    rerender({ busy: false });
    expect(sent).toEqual(['一', '二']);
    expect(result.current.queue).toEqual([]);
  });

  it('可移出队列；resetKey 变化清空队列', () => {
    const { result, rerender } = renderHook(({ k }) => useSendQueue(true, () => undefined, k), {
      initialProps: { k: 'a' },
    });
    act(() => {
      result.current.enqueue('一');
      result.current.enqueue('二');
    });
    act(() => result.current.remove(0));
    expect(result.current.queue).toEqual(['二']);
    rerender({ k: 'b' });
    expect(result.current.queue).toEqual([]);
  });
});
