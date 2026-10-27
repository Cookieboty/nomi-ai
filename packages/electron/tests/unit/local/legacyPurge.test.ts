/**
 * v2.0.4 移除剪贴板历史与屏幕记忆后，启动时清掉旧数据：
 * 必须异步删除（不在主进程启动路径上做同步 IO），且只删旧数据目录。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), on: jest.fn(), removeHandler: jest.fn() },
  dialog: {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalHubService } from '../../../src/local/LocalHubService';
import { ScreenService } from '../../../src/screen/ScreenService';

const logger = { info() {}, warn() {}, error() {} };
let ud: string;

beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-purge-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(ud, { recursive: true, force: true });
});

describe('启动时清理已移除功能的旧数据', () => {
  it('剪贴板历史：异步删除 clipboard.json 与 clips/，保留 local/ 下其他文件', async () => {
    const root = path.join(ud, 'local');
    fs.mkdirSync(path.join(root, 'clips'), { recursive: true });
    fs.writeFileSync(path.join(root, 'clipboard.json'), '{}');
    fs.writeFileSync(path.join(root, 'clips', 'a.png'), 'x');
    fs.writeFileSync(path.join(root, 'keep.json'), '{}');
    const rmSync = jest.spyOn(fs, 'rmSync');
    const hub = new LocalHubService({ root, userData: ud, logger, desktop: {} } as never);
    expect(rmSync).not.toHaveBeenCalled();
    await hub.legacyPurged;
    expect(fs.existsSync(path.join(root, 'clipboard.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'clips'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'keep.json'))).toBe(true);
  });

  it('屏幕记忆：异步删除 screen-memory 目录；目录不存在也不报错', async () => {
    const root = path.join(ud, 'screen-memory');
    fs.mkdirSync(path.join(root, 'thumbs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'thumbs', 't.jpg'), 'x');
    const rmSync = jest.spyOn(fs, 'rmSync');
    const scr = new ScreenService({ root, logger, desktop: {} } as never);
    expect(rmSync).not.toHaveBeenCalled();
    await scr.legacyPurged;
    expect(fs.existsSync(root)).toBe(false);
    const again = new ScreenService({ root, logger, desktop: {} } as never);
    await expect(again.legacyPurged).resolves.toBeUndefined();
  });
});
