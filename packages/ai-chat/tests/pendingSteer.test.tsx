// @vitest-environment happy-dom
/** 运行中发送：Enter 插入（工具开始 / 有工具在跑时交出去，交不出去改排队）、Ctrl+Enter 排队、Esc / 按钮打断发送、带图排队 */
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PendingDock } from '../src/components/PendingDock';
import { useSendQueue, type SteerChannel } from '../src/hooks/useSendQueue';
import {
  hasRunningTool,
  mergePending,
  mergePendingBatches,
  requeue,
  takeSteer,
  type PendingImage,
} from '../src/utils/pendingSends';

afterEach(cleanup);

const img = (n: number): PendingImage => ({
  id: `img-${n}`,
  mime: 'image/png',
  data: btoa(`img-${n}`),
  thumb: `data:image/png;base64,${btoa(`t-${n}`)}`,
  width: 100,
  height: 100,
  source: 'paste',
});

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

  it('交付途中切换了会话：迟到的失败不放进新会话的队列，也不在新会话里发出（#254）', async () => {
    let finish!: (ok: boolean) => void;
    const fns = new Set<() => void>();
    const ch: SteerChannel = {
      deliver: vi.fn(() => new Promise<boolean>((res) => (finish = res))),
      toolRunning: () => false,
      onToolStart: (fn) => {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      stop: vi.fn(),
    };
    const send = vi.fn();
    const { result, rerender } = renderHook(
      ({ busy, conv }) => useSendQueue(busy, send, conv, ch),
      { initialProps: { busy: true, conv: 'A' } },
    );
    act(() => result.current.enqueue('给 A 的补充'));
    await act(async () => {
      for (const fn of fns) fn();
    });
    expect(ch.deliver).toHaveBeenCalledTimes(1);
    // 交付还没返回：切到空闲的会话 B
    rerender({ busy: false, conv: 'B' });
    await act(async () => finish(false));
    expect(result.current.items).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    // B 自己排的消息照常发出，没有被旧回调挤掉
    rerender({ busy: true, conv: 'B' });
    act(() => result.current.enqueue('给 B 的', { mode: 'queue' }));
    rerender({ busy: false, conv: 'B' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('给 B 的', undefined);
  });

  it('A → B → A 切回来后迟到的失败也不回填：切走时队列已经清空（#254）', async () => {
    let finish!: (ok: boolean) => void;
    const fns = new Set<() => void>();
    const ch: SteerChannel = {
      deliver: vi.fn(() => new Promise<boolean>((res) => (finish = res))),
      toolRunning: () => false,
      onToolStart: (fn) => {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      stop: vi.fn(),
    };
    const send = vi.fn();
    const { result, rerender } = renderHook(
      ({ busy, conv }) => useSendQueue(busy, send, conv, ch),
      { initialProps: { busy: true, conv: 'A' } },
    );
    act(() => result.current.enqueue('给 A 的补充'));
    await act(async () => {
      for (const fn of fns) fn();
    });
    rerender({ busy: true, conv: 'B' });
    rerender({ busy: true, conv: 'A' });
    await act(async () => finish(false));
    // 会话归属是按切换判断的：A→B→A 不是同一次队列，旧交付的失败不复活
    expect(result.current.items).toEqual([]);
    expect(send).not.toHaveBeenCalled();
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

  it('带图片入队自动设为排队且不走纯文本 steer；空闲后带图自动发出', async () => {
    const { ch, delivered, toolStart } = channel({ running: true });
    const send = vi.fn();
    const images = [img(1), img(2)];
    const { result, rerender } = renderHook(({ busy }) => useSendQueue(busy, send, undefined, ch), {
      initialProps: { busy: true },
    });
    await act(async () => {
      result.current.enqueue('看下这两张图', { mode: 'steer', images });
    });
    await toolStart();
    expect(delivered).toEqual([]);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]!.mode).toBe('queue');
    expect(result.current.items[0]!.images).toEqual(images);

    rerender({ busy: false });
    expect(send).toHaveBeenCalledWith('看下这两张图', { images });
  });

  it('flush 合并文字与图片并在超过单轮上限时分批不丢图', () => {
    const { ch } = channel();
    const sent: Array<{ text: string; images?: readonly PendingImage[] }> = [];
    let release = () => undefined;
    const send = vi.fn((text: string, opts?: { images?: readonly PendingImage[] }) => {
      sent.push({ text, images: opts?.images });
      return new Promise<void>((r) => {
        release = r;
      });
    });
    const batch1 = [img(1), img(2), img(3), img(4)];
    const batch2 = [img(5), img(6), img(7)];
    expect(
      mergePendingBatches(
        [
          { id: '1', text: '一', mode: 'queue', images: batch1 },
          { id: '2', text: '二', mode: 'queue', images: batch2 },
        ],
        6,
      ).map((b) => [b.text, b.images?.length]),
    ).toEqual([
      ['一', 4],
      ['二', 3],
    ]);

    const { result, rerender } = renderHook(({ busy }) => useSendQueue(busy, send, undefined, ch), {
      initialProps: { busy: true },
    });
    act(() => {
      result.current.enqueue('第一批', { images: batch1 });
      result.current.enqueue('第二批', { images: batch2 });
    });
    act(() => {
      expect(result.current.flush()).toBe(true);
    });
    expect(ch.stop).toHaveBeenCalled();
    expect(result.current.items).toHaveLength(2);

    rerender({ busy: false });
    expect(sent).toEqual([{ text: '第一批', images: batch1 }]);
    rerender({ busy: true });
    act(() => release());
    rerender({ busy: false });
    expect(sent).toEqual([
      { text: '第一批', images: batch1 },
      { text: '第二批', images: batch2 },
    ]);
  });
});

describe('PendingDock 图片缩略图、撤回与停止并发送按钮', () => {
  it('展示带图缩略图与数量标记，点击撤回传出原条目，点击停止并发送触发 onFlush', () => {
    const onWithdraw = vi.fn();
    const onRemove = vi.fn();
    const onFlush = vi.fn();
    const item = {
      id: 'p1',
      text: '带着图发出去',
      mode: 'queue' as const,
      images: [img(1), img(2), img(3)],
    };
    const r = render(
      <PendingDock items={[item]} onWithdraw={onWithdraw} onRemove={onRemove} onFlush={onFlush} />,
    );
    const imagesEl = r.getByTestId('pending-images');
    expect(imagesEl.querySelector('img')?.getAttribute('src')).toBe(img(1).thumb);
    expect(imagesEl.textContent).toContain('+2');

    fireEvent.click(r.getByTestId('pending-withdraw'));
    expect(onWithdraw).toHaveBeenCalledWith(item);

    fireEvent.click(r.getByTestId('pending-flush'));
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});
