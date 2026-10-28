/**
 * 本地数据导出与本地模型管理经宿主端口 / 事件总线工作（设计稿 §7.1「实施约定」）：
 * 导出用 dialogs.saveFile 选位置（取消不写文件），设置变化经 events 发 `ai:local:changed`。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

// 两个服务都不再 import electron；只有 guardedIpc / mascotCommand 还用到
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalHubService } from '../../../src/local/LocalHubService';
import { LocalModelService } from '../../../src/local/LocalModelService';
import { featureHost } from '../helpers/featureHost';

const logger = { info() {}, warn() {} };
let ud: string;

beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-local-ports-'));
});
afterEach(() => {
  fs.rmSync(ud, { recursive: true, force: true });
});

describe('LocalHubService.exportAll', () => {
  it('writes the zip to the path chosen in the save dialog', async () => {
    const out = path.join(ud, 'export.zip');
    const host = featureHost({ saveFile: [out] });
    const hub = new LocalHubService({
      root: path.join(ud, 'local'),
      userData: ud,
      logger,
      desktop: { audit: { append: jest.fn() } } as never,
      ports: host.ports,
    });
    const r = await hub.exportAll({ include: ['settings'] });
    expect(r).toMatchObject({ file: out });
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    expect(host.calls.saveFile).toHaveLength(1);
    expect(host.calls.saveFile[0]).toMatchObject({
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    expect(host.calls.saveFile[0]?.parent).toBeUndefined();
  });

  it('returns null and writes nothing when the dialog is cancelled', async () => {
    const host = featureHost();
    const audit = { append: jest.fn() };
    const hub = new LocalHubService({
      root: path.join(ud, 'local'),
      userData: ud,
      logger,
      desktop: { audit } as never,
      ports: host.ports,
    });
    expect(await hub.exportAll()).toBeNull();
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe('LocalModelService events', () => {
  it('publishes ai:local:changed to every window when settings change', () => {
    const host = featureHost();
    const svc = new LocalModelService({
      root: path.join(ud, 'local'),
      logger,
      desktop: { audit: { append: jest.fn() } } as never,
      gateway: () => null,
      events: host.events,
    });
    svc.setSettings({ autoStart: true });
    expect(host.events.published).toEqual([
      { channel: 'ai:local:changed', payload: null, surfaces: null },
    ]);
  });
});
