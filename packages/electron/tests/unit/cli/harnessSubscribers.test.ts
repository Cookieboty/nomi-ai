/**
 * ai:harness:* 推送只发给调过 ai:harness:* 的窗口（对话窗口），不广播给看板娘等其它窗口；
 * 销毁的窗口自动移除，未受信的 sender 不会被登记。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const mascotSent: string[] = [];
jest.mock('electron', () => ({
  // 从不调 ai:harness:* 的窗口（看板娘）：旧实现会经 getAllWindows 发给它
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        isFocused: () => false,
        webContents: {
          id: 99,
          isDestroyed: () => false,
          send: (c: string) => mascotSent.push(c),
        },
      },
    ],
  },
  app: { isPackaged: true },
  ipcMain: {
    removeHandler: (ch: string) => handlers.delete(ch),
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(ch, fn),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

import { CliHarnessService } from '../../../src/cli/CliHarnessService';
import {
  RendererSubscribers,
  type SubscriberContents,
} from '../../../src/cli/harness/rendererSubscribers';

class FakeContents implements SubscriberContents {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  private destroyed = false;
  private readonly onDestroyed: Array<() => void> = [];
  constructor(
    readonly id: number,
    private readonly url = 'file:///app/ai-chat/index.html',
  ) {}
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, payload?: unknown) {
    this.sent.push({ channel, payload });
  }
  once(_event: 'destroyed', fn: () => void) {
    this.onDestroyed.push(fn);
    return this;
  }
  destroy() {
    this.destroyed = true;
    for (const fn of this.onDestroyed.splice(0)) fn();
  }
  channels() {
    return this.sent.map((s) => s.channel);
  }
}

describe('RendererSubscribers', () => {
  it('sends only to registered contents', () => {
    const subs = new RendererSubscribers();
    const a = new FakeContents(1);
    const b = new FakeContents(2);
    subs.add(a);
    subs.send('ai:harness:tabs', { n: 1 });
    expect(a.sent).toEqual([{ channel: 'ai:harness:tabs', payload: { n: 1 } }]);
    expect(b.sent).toEqual([]);
  });

  it('registering the same contents twice delivers once and hooks destroyed once', () => {
    const subs = new RendererSubscribers();
    const a = new FakeContents(1);
    const once = jest.spyOn(a, 'once');
    subs.add(a);
    subs.add(a);
    subs.send('x', 1);
    expect(a.sent).toHaveLength(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(subs.size).toBe(1);
  });

  it('drops contents on destroyed', () => {
    const subs = new RendererSubscribers();
    const a = new FakeContents(1);
    subs.add(a);
    a.destroy();
    expect(subs.size).toBe(0);
    subs.send('x', 1);
    expect(a.sent).toEqual([]);
  });

  it('skips and drops contents that are destroyed without the event firing', () => {
    const subs = new RendererSubscribers();
    const a = new FakeContents(1);
    subs.add(a);
    jest.spyOn(a, 'isDestroyed').mockReturnValue(true);
    subs.send('x', 1);
    expect(a.sent).toEqual([]);
    expect(subs.size).toBe(0);
  });

  it('ignores missing or already-destroyed contents, and a throwing send does not block others', () => {
    const subs = new RendererSubscribers();
    subs.add(null);
    subs.add(undefined);
    const dead = new FakeContents(1);
    dead.destroy();
    subs.add(dead);
    expect(subs.size).toBe(0);
    const bad = new FakeContents(2);
    jest.spyOn(bad, 'send').mockImplementation(() => {
      throw new Error('gone');
    });
    const good = new FakeContents(3);
    subs.add(bad);
    subs.add(good);
    subs.send('x', 1);
    expect(good.sent).toHaveLength(1);
  });
});

describe('CliHarnessService push delivery', () => {
  let root: string;
  let h: CliHarnessService;
  const invoke = (ch: string, sender: FakeContents, ...args: unknown[]) =>
    handlers.get(ch)!({ sender }, ...args);
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-subs-'));
    mascotSent.length = 0;
    h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
    h.registerIpc();
  });
  afterEach(() => {
    h.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a window that invoked ai:harness:* receives changed / tabs; other windows do not', async () => {
    const chat = new FakeContents(1);
    const idle = new FakeContents(2);
    await invoke('ai:harness:tabs', chat);
    h.createTab({ backend: 'claude' });
    await flushMicrotasks();
    expect(chat.channels()).toEqual(['ai:harness:changed', 'ai:harness:tabs']);
    expect(idle.sent).toEqual([]);
    expect(mascotSent).toEqual([]);
  });

  it('live event batches go only to subscribers', async () => {
    const chat = new FakeContents(1);
    await invoke('ai:harness:state', chat);
    chat.sent.length = 0;
    (h as unknown as { emitEvent(tabId: string, ev: unknown): void }).emitEvent('main', {
      type: 'text-delta',
      text: 'hi',
    });
    await new Promise((r) => setTimeout(r, 50));
    const batch = chat.sent.find((s) => s.channel === 'ai:harness:events');
    expect(batch?.payload).toEqual([
      expect.objectContaining({ tabId: 'main', type: 'text-delta' }),
    ]);
    expect(mascotSent).toEqual([]);
  });

  it('a destroyed window stops receiving and is removed', async () => {
    const chat = new FakeContents(1);
    const other = new FakeContents(2);
    await invoke('ai:harness:tabs', chat);
    await invoke('ai:harness:tabs', other);
    chat.destroy();
    h.createTab({ backend: 'claude' });
    await flushMicrotasks();
    expect(chat.sent).toEqual([]);
    expect(other.channels()).toEqual(['ai:harness:changed', 'ai:harness:tabs']);
  });

  it('an untrusted sender is rejected and never registered', async () => {
    const evil = new FakeContents(3, 'https://evil.example/');
    await expect(invoke('ai:harness:tabs', evil)).rejects.toThrow(/untrusted sender/);
    h.createTab({ backend: 'claude' });
    await flushMicrotasks();
    expect(evil.sent).toEqual([]);
  });
});
