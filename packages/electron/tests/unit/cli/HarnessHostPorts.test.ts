/**
 * 编排层经宿主端口选择工作目录、判断应用是否在前台（不再直接用 dialog / BrowserWindow）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DialogsPort, PickDirectoryOptions, WindowsPort } from '@nomi-ai/host-ports';

// 只剩 guardedIpc 还要 ipcMain
jest.mock('electron', () => ({
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
}));

import { CliHarnessService, type HarnessTabFinished } from '../helpers/harness';

const logger = { info() {}, warn() {} };
const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');

/** 只关心 anyFocused 的窗口端口 */
const windows = (focused = false) => ({ anyFocused: () => focused }) as unknown as WindowsPort;

function fakeDialogs(result: string | null) {
  const pickDirectory = jest.fn(async (_o?: PickDirectoryOptions) => result);
  return { dialogs: { pickDirectory } as unknown as DialogsPort, pickDirectory };
}

describe('HarnessOrchestrator · 宿主端口', () => {
  const dirs: string[] = [];
  const tmp = (p: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const services: CliHarnessService[] = [];
  const make = (o: Partial<ConstructorParameters<typeof CliHarnessService>[0]> = {}) => {
    const root = tmp('harness-ports-');
    const h = new CliHarnessService({ root, logger, defaultCwd: root, ...o });
    services.push(h);
    return h;
  };
  afterEach(() => {
    for (const h of services.splice(0)) h.dispose();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('pickDirectory：不挂父窗口、允许新建文件夹，传入初始目录', async () => {
    const picked = tmp('harness-picked-');
    const { dialogs, pickDirectory } = fakeDialogs(picked);
    const h = make({ ports: { dialogs, windows: windows() } });
    await expect(h.pickDirectory('/start/here')).resolves.toBe(picked);
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    const opts = pickDirectory.mock.calls[0]![0]!;
    expect(opts).toMatchObject({ createDirectory: true, defaultPath: '/start/here' });
    expect(typeof opts.title).toBe('string');
    expect(opts.parent).toBeUndefined();
  });

  it('pickDirectory：取消返回 null；没有初始目录时不传 defaultPath', async () => {
    const { dialogs, pickDirectory } = fakeDialogs(null);
    const h = make({ ports: { dialogs, windows: windows() } });
    await expect(h.pickDirectory()).resolves.toBeNull();
    expect(pickDirectory.mock.calls[0]![0]).not.toHaveProperty('defaultPath');
  });

  it('pickTabCwd：选中的目录成为标签工作目录；取消时不变', async () => {
    const proj = tmp('harness-proj-');
    const picked = tmp('harness-picked-');
    let result: string | null = picked;
    const pickDirectory = jest.fn(async (_o?: PickDirectoryOptions) => result);
    const h = make({
      ports: { dialogs: { pickDirectory } as unknown as DialogsPort, windows: windows() },
    });
    const tab = h.createTab({ backend: 'claude', cwd: proj });
    const moved = await h.pickTabCwd(tab.id);
    expect(pickDirectory.mock.calls[0]![0]).toMatchObject({ defaultPath: proj });
    expect(path.resolve(moved.cwd)).toBe(path.resolve(picked));
    result = null;
    const same = await h.pickTabCwd(tab.id);
    expect(path.resolve(same.cwd)).toBe(path.resolve(picked));
  });

  it('测试缺省端口：选择器按取消处理', async () => {
    const h = make();
    await expect(h.pickDirectory('/x')).resolves.toBeNull();
  });

  describe('windows.anyFocused：一轮结束是否算后台完成', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env.NOMI_CODEX_BIN = path.join(mockDir, 'mock-codex.mjs');
      delete process.env.NOMI_USE_MOCK_CLI;
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    /** 在当前（活动）标签上跑完一轮，返回 tab-finished 事件与未读数 */
    const finishActive = async (anyFocused: () => boolean) => {
      const { dialogs } = fakeDialogs(null);
      const h = make({ ports: { dialogs, windows: { anyFocused } as unknown as WindowsPort } });
      const tab = h.createTab({ backend: 'codex' });
      expect(h.listTabs().activeTabId).toBe(tab.id);
      const finished: HarnessTabFinished[] = [];
      h.events.on('tab-finished', (e) => finished.push(e));
      await h.sendTab(tab.id, 'hi');
      return { finished, unread: h.listTabs().tabs.find((x) => x.id === tab.id)!.unread };
    };

    it('应用不在前台：活动标签的一轮也算后台完成，记未读', async () => {
      const { finished, unread } = await finishActive(() => false);
      expect(finished).toEqual([expect.objectContaining({ background: true, ok: true })]);
      expect(unread).toBe(1);
    });

    it('应用在前台：活动标签的一轮不算后台完成', async () => {
      const { finished, unread } = await finishActive(() => true);
      expect(finished).toEqual([expect.objectContaining({ background: false, ok: true })]);
      expect(unread).toBe(0);
    });

    it('端口抛错时按不在前台处理', async () => {
      const { finished } = await finishActive(() => {
        throw new Error('no windows');
      });
      expect(finished).toEqual([expect.objectContaining({ background: true })]);
    });
  });
});
