/**
 * Harness state files are written coalesced (one trailing async write per burst), flushed on
 * dispose, and visible to a new instance on the same root; window broadcasts are coalesced.
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sent: string[] = [];

import { until } from '../../helpers/wait';
import { CliHarnessService } from '../helpers/harness';

describe('CliHarnessService persistence', () => {
  let root: string;
  const made: CliHarnessService[] = [];
  const make = () => {
    const h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
    made.push(h);
    return h;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-persist-'));
    sent.length = 0;
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a burst of changes writes tabs.json once, after the debounce, with the final state', async () => {
    const h = make();
    const writes = jest.spyOn(fs.promises, 'writeFile');
    const ids = Array.from({ length: 10 }, () => h.createTab({ backend: 'claude' }).id);
    expect(fs.existsSync(path.join(root, 'tabs.json'))).toBe(false);
    const file = path.join(root, 'tabs.json');
    await until(() => fs.existsSync(file), { what: 'debounced tabs.json write' });
    // 写完之后不应再有第二次写入（同一波变更只写一次）
    await new Promise((r) => setTimeout(r, 50));
    const tabsWrites = writes.mock.calls.filter((c) => String(c[0]).includes('tabs.json'));
    expect(tabsWrites).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'tabs.json'), 'utf8'));
    expect(saved.tabs.map((t: { id: string }) => t.id)).toEqual(ids);
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    writes.mockRestore();
  });

  it('window broadcasts are coalesced per microtask turn', async () => {
    const h = make();
    // 推送经应用事件总线（契约事件 harness.*）
    h.attachEvents({ publish: (channel) => sent.push(channel) });
    sent.length = 0;
    for (let i = 0; i < 5; i++) h.createTab({ backend: 'claude' });
    expect(sent.filter((c) => c === 'harness.tabsChanged')).toHaveLength(0);
    await Promise.resolve();
    expect(sent.filter((c) => c === 'harness.tabsChanged')).toHaveLength(1);
    expect(sent.filter((c) => c === 'harness.changed')).toHaveLength(1);
  });

  it('dispose flushes; a new instance on the same root sees unflushed state', () => {
    const a = make();
    const tab = a.createTab({ backend: 'claude' });
    // no dispose, no wait: the constructor flushes pending writes under its root
    const b = make();
    expect(b.listTabs().tabs.some((t) => t.id === tab.id)).toBe(true);
    const c = b.createTab({ backend: 'codex' });
    b.dispose();
    expect(fs.readFileSync(path.join(root, 'tabs.json'), 'utf8')).toContain(c.id);
  });
});
