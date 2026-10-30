jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'fs';
import os from 'os';
import path from 'path';

import { CoalescedWriter, flushPendingWritesSync } from '../../../src/utils/coalescedWriter';

describe('CoalescedWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = (f: string) => fs.readFileSync(f, 'utf8');

  it('coalesces a burst into one trailing async write of the latest state', async () => {
    const w = new CoalescedWriter(20);
    const f = path.join(dir, 'a.json');
    let n = 0;
    let produced = 0;
    for (let i = 0; i < 50; i++) {
      n = i;
      w.schedule(f, () => {
        produced++;
        return String(n);
      });
    }
    expect(fs.existsSync(f)).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    await w.flush();
    expect(read(f)).toBe('49');
    expect(produced).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['a.json']); // no temp files left
    w.dispose();
  });

  it('flushSync writes now; a slower async write never renames stale data over it', async () => {
    const w = new CoalescedWriter(1000);
    const f = path.join(dir, 'b.json');
    w.schedule(f, () => 'old');
    const p = w.flush(); // async write of "old" in flight
    w.schedule(f, () => 'new');
    w.flushSync();
    await p;
    expect(read(f)).toBe('new');
    w.dispose();
  });

  it('cancel drops a pending write (deleted file is not recreated)', async () => {
    const w = new CoalescedWriter(10);
    const f = path.join(dir, 'c.json');
    w.schedule(f, () => 'x');
    w.cancel(f);
    await new Promise((r) => setTimeout(r, 30));
    await w.flush();
    expect(fs.existsSync(f)).toBe(false);
    w.dispose();
  });

  it('dispose / flushPendingWritesSync(dir) flush pending files under a directory', () => {
    const w = new CoalescedWriter(10_000);
    const f = path.join(dir, 'd.json');
    w.schedule(f, () => 'd');
    flushPendingWritesSync(path.join(os.tmpdir(), 'elsewhere'));
    expect(fs.existsSync(f)).toBe(false);
    flushPendingWritesSync(dir);
    expect(read(f)).toBe('d');
    w.schedule(f, () => 'e');
    w.dispose();
    expect(read(f)).toBe('e');
  });

  it('flushSync / the read barrier cover an async write that is already in flight (#81)', async () => {
    const w = new CoalescedWriter(1000);
    const f = path.join(dir, 'e.json');
    w.schedule(f, () => 'first');
    w.flushSync();
    w.schedule(f, () => 'second');
    const p = w.flush(); // "second" produced, async write not renamed yet
    expect(read(f)).toBe('first');
    // 读屏障看得到在途写入，同步补写后立刻读到新值
    flushPendingWritesSync(dir);
    expect(read(f)).toBe('second');
    await p; // 迟到的 rename 被代次作废，不会写回别的内容
    expect(read(f)).toBe('second');
    expect(fs.readdirSync(dir)).toEqual(['e.json']);
    // 在途写入结束后不再算待写
    expect(w.hasPendingUnder(dir)).toBe(false);
    w.dispose();
  });

  it('dispose writes an in-flight async write synchronously', async () => {
    const w = new CoalescedWriter(1000);
    const f = path.join(dir, 'g.json');
    w.schedule(f, () => 'late');
    const p = w.flush();
    w.dispose();
    expect(read(f)).toBe('late');
    await p;
  });
});
