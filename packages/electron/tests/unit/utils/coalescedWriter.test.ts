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
});
