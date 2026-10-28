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

import { CliHarnessService } from '../../../src/cli/CliHarnessService';

const logger = { info() {}, warn() {} };

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

  it('没有 dialogs 端口（测试 / 无界面）：选择器按取消处理', async () => {
    const h = make();
    await expect(h.pickDirectory('/x')).resolves.toBeNull();
  });
});
