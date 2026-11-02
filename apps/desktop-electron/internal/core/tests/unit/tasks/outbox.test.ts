jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MERGE_WINDOW_MS, Outbox, type OutboxItem } from '../../../src/tasks/outbox';

import { FakeClock } from './runtimeHarness';

const T0 = 1_800_000_000_000;

function setup(opts: { quietUntil?: () => number | null; fail?: () => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  const clock = new FakeClock(T0);
  const sent: { title: string; text: string }[] = [];
  const delivered: string[][] = [];
  const warns: unknown[] = [];
  let ids = 0;
  const make = () =>
    new Outbox({
      file: path.join(dir, 'outbox.json'),
      now: clock.now,
      setTimer: clock.setTimer,
      newId: () => `o${++ids}`,
      send: (n) => {
        if (opts.fail?.()) throw new Error('down');
        sent.push(n);
      },
      ...(opts.quietUntil ? { quietUntil: opts.quietUntil } : {}),
      mergedText: (items: OutboxItem[]) => ({
        title: 'T',
        text: `${items.length}:${items.map((x) => x.taskTitle).join(',')}`,
      }),
      delivered: (items) => delivered.push(items.map((x) => x.taskId)),
      logger: { warn: (...a: unknown[]) => warns.push(a) },
    });
  return { dir, clock, sent, delivered, warns, make };
}

const item = (n: number) => ({
  taskId: `task_${n}`,
  taskTitle: `t${n}`,
  title: 'T',
  text: `msg${n}`,
});

describe('Outbox', () => {
  it('第一条立即发；窗口内的攒起来，窗口结束合并成一条', () => {
    const h = setup();
    const ob = h.make();
    ob.push(item(1));
    expect(h.sent).toEqual([{ title: 'T', text: 'msg1' }]);
    h.clock.advance(1000);
    ob.push(item(2));
    ob.push(item(3));
    expect(h.sent).toHaveLength(1);
    h.clock.advance(MERGE_WINDOW_MS);
    expect(h.sent[1]).toEqual({ title: 'T', text: '2:t2,t3' });
    expect(h.delivered).toEqual([['task_1'], ['task_2', 'task_3']]);
    expect(ob.pending()).toEqual([]);
    // 窗口过后又是第一条：立即发
    h.clock.advance(MERGE_WINDOW_MS + 1);
    ob.push(item(4));
    expect(h.sent[2]).toEqual({ title: 'T', text: 'msg4' });
  });

  it('免打扰期间只攒不发，结束时合并成一条', () => {
    let until: number | null = T0 + 3600_000;
    const h = setup({ quietUntil: () => (until !== null && until > h.clock.t ? until : null) });
    const ob = h.make();
    ob.push(item(1));
    ob.push(item(2));
    expect(h.sent).toEqual([]);
    h.clock.advance(3600_000);
    expect(h.sent).toEqual([{ title: 'T', text: '2:t1,t2' }]);
    until = null;
  });

  it('发送失败按 2s 翻倍重试；连续 3 次才记问题；成功后清零', () => {
    let down = 3;
    const h = setup({ fail: () => down-- > 0 });
    const ob = h.make();
    ob.push(item(1));
    expect(h.sent).toEqual([]);
    h.clock.advance(2000);
    h.clock.advance(4000);
    expect(h.warns).toHaveLength(1);
    expect(h.sent).toEqual([]);
    h.clock.advance(8000);
    expect(h.sent).toEqual([{ title: 'T', text: 'msg1' }]);
  });

  it('先存再发：重启后补发没发出去的', () => {
    const h = setup({ fail: () => true });
    const ob = h.make();
    ob.push(item(1));
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'outbox.json'), 'utf8')).items).toHaveLength(
      1,
    );
    ob.stop();
    const h2 = { ...h };
    const ob2 = new Outbox({
      file: path.join(h.dir, 'outbox.json'),
      now: h.clock.now,
      setTimer: h.clock.setTimer,
      newId: () => 'x',
      send: (n) => h2.sent.push(n),
      mergedText: () => ({ title: 'T', text: 'merged' }),
      logger: { warn: () => undefined },
    });
    ob2.start();
    h.clock.advance(0);
    expect(h.sent).toEqual([{ title: 'T', text: 'msg1' }]);
    expect(ob2.pending()).toEqual([]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  });
});
