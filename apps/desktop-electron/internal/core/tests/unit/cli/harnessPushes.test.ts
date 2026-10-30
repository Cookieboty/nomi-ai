/**
 * 编排器的推送（harness.*）只经应用事件总线发给对话窗口（surface 'chat'），即契约事件
 * `harness.*`；接上事件总线之前没有订阅者，推送直接丢弃。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../helpers/harness';

describe('CliHarnessService push delivery', () => {
  let root: string;
  let h: CliHarnessService;
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));
  let published: Array<{ event: string; payload: unknown; surface: unknown }>;
  const attach = () =>
    h.attachEvents({
      publish: (event, payload, opts) => published.push({ event, payload, surface: opts?.surface }),
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-push-'));
    published = [];
    h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
  });
  afterEach(() => {
    h.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pushes go through the app event bus to the chat surface only', async () => {
    attach();
    h.createTab({ backend: 'claude' });
    await flushMicrotasks();
    expect(published.map(({ event, surface }) => ({ event, surface }))).toEqual([
      { event: 'harness.changed', surface: 'chat' },
      { event: 'harness.tabsChanged', surface: 'chat' },
    ]);
  });

  it('live event batches are published as harness.events', async () => {
    attach();
    (h as unknown as { emitEvent(tabId: string, ev: unknown): void }).emitEvent('main', {
      type: 'text-delta',
      text: 'hi',
    });
    await new Promise((r) => setTimeout(r, 50));
    const batch = published.find((s) => s.event === 'harness.events');
    expect(batch?.payload).toEqual([
      expect.objectContaining({ tabId: 'main', type: 'text-delta' }),
    ]);
    expect(batch?.surface).toBe('chat');
  });

  it('before attachEvents nothing is published and nothing throws', async () => {
    h.createTab({ backend: 'claude' });
    await flushMicrotasks();
    attach();
    expect(published).toEqual([]);
  });
});
