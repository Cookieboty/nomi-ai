import { describe, expect, it } from 'vitest';

import { createDragReporter, type DragPoint } from '../../src/avatar/dragReporter';

/** 可手动结算的 sink：记录调用顺序，每次调用返回一个待结算的 promise */
function fakeSink() {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const call = (name: string) => {
    calls.push(name);
    return new Promise<void>((resolve) => pending.push(resolve));
  };
  const pt = (p: DragPoint) => `${p.screenX},${p.screenY}`;
  return {
    calls,
    inFlight: () => pending.length,
    /** 结算最早的一个调用并等后续 pump 跑完 */
    async settle() {
      pending.shift()?.();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    sink: {
      dragStart: (p: DragPoint) => call(`start ${pt(p)}`),
      dragMove: (p: DragPoint) => call(`move ${pt(p)}`),
      dragEnd: () => call('end'),
    },
  };
}

function frames() {
  const queued: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => void queued.push(fn),
    tick() {
      const fns = queued.splice(0);
      for (const fn of fns) fn();
    },
    pending: () => queued.length,
  };
}

describe('createDragReporter', () => {
  it('串行发送：上一条回应前不发下一条，start → move → end 顺序不变', async () => {
    const f = fakeSink();
    const fr = frames();
    const r = createDragReporter(f.sink, fr.schedule);
    r.start({ screenX: 0, screenY: 0 });
    r.move({ screenX: 1, screenY: 1 });
    r.end();
    expect(f.calls).toEqual(['start 0,0']);
    await f.settle();
    expect(f.calls).toEqual(['start 0,0', 'move 1,1']);
    await f.settle();
    expect(f.calls).toEqual(['start 0,0', 'move 1,1', 'end']);
    await f.settle();
    expect(f.inFlight()).toBe(0);
  });

  it('move 合并：在途期间只留最新坐标，每帧最多一条', async () => {
    const f = fakeSink();
    const fr = frames();
    const r = createDragReporter(f.sink, fr.schedule);
    r.start({ screenX: 0, screenY: 0 });
    await f.settle();
    // 第一条 move 立即发（本帧还没发过）
    r.move({ screenX: 1, screenY: 1 });
    for (let i = 2; i <= 30; i++) r.move({ screenX: i, screenY: i });
    expect(f.calls).toEqual(['start 0,0', 'move 1,1']);
    await f.settle();
    // 回应到了，但本帧已经发过 move：等下一帧，只发最新的
    expect(f.calls).toHaveLength(2);
    expect(fr.pending()).toBe(1);
    r.move({ screenX: 31, screenY: 31 });
    fr.tick();
    expect(f.calls).toEqual(['start 0,0', 'move 1,1', 'move 31,31']);
    await f.settle();
    expect(fr.pending()).toBe(0);
  });

  it('排着 end 时不等帧：窗口隐藏 rAF 不触发也会收尾', async () => {
    const f = fakeSink();
    const fr = frames();
    const r = createDragReporter(f.sink, fr.schedule);
    r.start({ screenX: 0, screenY: 0 });
    await f.settle();
    r.move({ screenX: 1, screenY: 1 });
    r.move({ screenX: 2, screenY: 2 });
    r.end();
    await f.settle();
    await f.settle();
    expect(f.calls).toEqual(['start 0,0', 'move 1,1', 'move 2,2', 'end']);
    expect(fr.pending()).toBe(0);
  });

  it('上报失败不阻塞后面的上报', async () => {
    const calls: string[] = [];
    const r = createDragReporter(
      {
        dragStart: async () => {
          calls.push('start');
          throw new Error('boom');
        },
        dragMove: async () => void calls.push('move'),
        dragEnd: () => {
          calls.push('end');
          throw new Error('sync boom');
        },
      },
      (fn) => fn(),
    );
    r.start({ screenX: 0, screenY: 0 });
    r.move({ screenX: 1, screenY: 1 });
    r.end();
    r.start({ screenX: 2, screenY: 2 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls).toEqual(['start', 'move', 'end', 'start']);
  });
});
