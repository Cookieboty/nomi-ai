// @vitest-environment happy-dom
/** 运行中发送：Enter 插入（工具开始 / 有工具在跑时交出去，交不出去改排队）、Ctrl+Enter 排队、Esc 合成发送 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSendQueue, type SteerChannel } from '../src/hooks/useSendQueue';
import { hasRunningTool, mergePending, requeue, takeSteer } from '../src/utils/pendingSends';

function channel(o: { ok?: boolean; running?: boolean } = {}) {
  const fns = new Set<() => void>();
  const delivered: string[] = [];
  const ch: SteerChannel = {
    deliver: vi.fn(async (text: string) => {
      delivered.push(text);
      return o.ok ?? true;
    }),
    toolRunning: () => o.running ?? false,
    onToolStart: (fn) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    stop: vi.fn(),
  };
  const toolStart = async () => {
    await act(async () => {
      for (const fn of fns) fn();
    });
  };
  return { ch, delivered, toolStart };
}

describe('pendingSends', () => {
  it('合成、取插入、改排队、判断有工具在跑', () => {
    const a = { id: '1', text: '一', mode: 'steer' as const };
    const b = { id: '2', text: '二', mode: 'queue' as const };
    const c = { id: '3', text: '三', mode: 'steer' as const };
    expect(mergePending([a, c])).toBe('一\n\n三');
    expect(takeSteer([a, b, c])).toEqual({ steer: [a, c], rest: [b] });
    expect(requeue([b], [a]).map((i) => [i.id, i.mode])).toEqual([
      ['1', 'queue'],
      ['2', 'queue'],
    ]);
    expect(hasRunningTool([{ type: 'tool', name: 'Bash', status: 'start', id: 'x' }])).toBe(true);
    expect(
      hasRunningTool([
        { type: 'tool', name: 'Bash', status: 'start', id: 'x' },
        { type: 'tool', name: 'Bash', status: 'done', id: 'x' },
      ]),
    ).toBe(false);
  });
});

describe('useSendQueue 插入', () => {
  it('Enter 插入：先进列表，下一个工具开始时合成一条交出去', async () => {
    const { ch, delivered, toolStart } = channel();
    const { result } = renderHook(() => useSendQueue(true, () => undefined, undefined, ch));
    act(() => {
      result.current.enqueue('先看看测试');
      result.current.enqueue('再改文档');
    });
    expect(result.current.items.map((i) => i.mode)).toEqual(['steer', 'steer']);
    expect(delivered).toEqual([]);
    await toolStart();
    expect(delivered).toEqual(['先看看测试\n\n再改文档']);
    expect(result.current.items).toEqual([]);
  });

  it('入列时正好有工具在跑：马上交出去', async () => {
    const { ch, delivered } = channel({ running: true });
    const { result } = renderHook(() => useSendQueue(true, () => undefined, undefined, ch));
    await act(async () => {
      result.current.enqueue('补充一句');
    });
    expect(delivered).toEqual(['补充一句']);
  });

  it('交不出去：改为排队，这一轮结束后作为新的一轮发出', async () => {
    const { ch, toolStart } = channel({ ok: false });
    const send = vi.fn();
    const { result, rerender } = renderHook(({ busy }) => useSendQueue(busy, send, undefined, ch), {
      initialProps: { busy: true },
    });
    act(() => result.current.enqueue('插不进去的'));
    await toolStart();
    expect(result.current.items.map((i) => [i.text, i.mode])).toEqual([['插不进去的', 'queue']]);
    rerender({ busy: false });
    expect(send).toHaveBeenCalledWith('插不进去的', undefined);
  });

  it('Ctrl+Enter 排队：工具开始时不交出去；可撤回（删除）', async () => {
    const { ch, delivered, toolStart } = channel();
    const { result } = renderHook(() => useSendQueue(true, () => undefined, undefined, ch));
    act(() => {
      result.current.enqueue('等这轮结束', { mode: 'queue' });
      result.current.enqueue('插入的');
    });
    act(() => result.current.remove(result.current.items[1]!.id));
    await toolStart();
    expect(delivered).toEqual([]);
    expect(result.current.items.map((i) => i.text)).toEqual(['等这轮结束']);
  });

  it('Esc：停止这一轮，整个列表合成一条，停下后马上发出', () => {
    const { ch } = channel();
    const send = vi.fn();
    const { result, rerender } = renderHook(({ busy }) => useSendQueue(busy, send, undefined, ch), {
      initialProps: { busy: true },
    });
    act(() => {
      result.current.enqueue('一', { mode: 'queue' });
      result.current.enqueue('二');
    });
    let ok = false;
    act(() => {
      ok = result.current.flush();
    });
    expect(ok).toBe(true);
    expect(ch.stop).toHaveBeenCalled();
    expect(result.current.items.map((i) => i.text)).toEqual(['一\n\n二']);
    rerender({ busy: false });
    expect(send).toHaveBeenCalledWith('一\n\n二', undefined);
  });

  it('没有插入通道（不支持的后端）：Enter 也只排队', () => {
    const { result } = renderHook(() => useSendQueue(true, () => undefined));
    act(() => result.current.enqueue('x'));
    expect(result.current.items[0]!.mode).toBe('queue');
  });
});
