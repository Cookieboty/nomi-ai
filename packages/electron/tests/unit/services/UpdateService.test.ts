jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
}));

jest.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    logger: null,
    checkForUpdates: jest.fn(),
    downloadUpdate: jest.fn(),
    quitAndInstall: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
}));

import {
  UpdateService,
  _resetUpdateServiceForTests,
  type UpdaterLike,
} from '../../../src/services/UpdateService';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  logger: unknown = null;
  checkResult: { updateInfo: { version: string } } | null = {
    updateInfo: { version: '1.0.1' },
  };
  checkError: Error | null = null;
  downloaded = false;
  installed = false;

  async checkForUpdates() {
    if (this.checkError) throw this.checkError;
    this.emit('checking-for-update');
    if (this.checkResult) {
      this.emit('update-available', this.checkResult.updateInfo);
      return this.checkResult as never;
    }
    this.emit('update-not-available', { version: '1.0.0' });
    return null;
  }

  async downloadUpdate() {
    this.emit('download-progress', {
      percent: 42,
      bytesPerSecond: 1000,
      transferred: 42,
      total: 100,
    });
    this.emit('update-downloaded', { version: '1.0.1', releaseName: 'v1.0.1' });
    this.downloaded = true;
    return [];
  }

  quitAndInstall() {
    this.installed = true;
  }
}

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('UpdateService', () => {
  let updater: FakeUpdater;
  let svc: UpdateService;

  beforeEach(() => {
    _resetUpdateServiceForTests();
    updater = new FakeUpdater();
    svc = new UpdateService(logger as never, {
      updater,
      packaged: true,
      launchDelayMs: 0,
      intervalMs: 0,
    });
  });

  afterEach(() => {
    svc.stop();
    _resetUpdateServiceForTests();
  });

  it('starts with idle and wires autoDownload + consent-only install', () => {
    svc.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(svc.getState()).toMatchObject({
      status: 'idle',
      currentVersion: '1.0.0',
      autoCheck: true,
    });
  });

  it('check() reports available then download() reaches downloaded', async () => {
    svc.start();
    const available = await svc.check();
    expect(available.status).toBe('available');
    expect(available.availableVersion).toBe('1.0.1');

    const dl = await svc.download();
    expect(dl.status).toBe('downloaded');
    expect(dl.percent).toBe(100);
    expect(updater.downloaded).toBe(true);
  });

  it('check() reports not-available when updater finds nothing', async () => {
    updater.checkResult = null;
    svc.start();
    const s = await svc.check();
    expect(s.status).toBe('not-available');
  });

  it('check() surfaces updater errors', async () => {
    updater.checkError = new Error('network down');
    svc.start();
    const s = await svc.check();
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/network down/);
  });

  it('install() only runs after download and calls quitAndInstall', async () => {
    svc.start();
    expect(svc.install().status).toBe('idle');
    expect(updater.installed).toBe(false);
    await svc.check();
    await svc.download();
    svc.install();
    expect(updater.installed).toBe(true);
  });

  it('unpackaged builds stay unavailable', async () => {
    const dev = new UpdateService(logger as never, {
      updater,
      packaged: false,
      launchDelayMs: 0,
      intervalMs: 0,
    });
    dev.start();
    const s = await dev.check();
    expect(s.status).toBe('unavailable');
    expect(s.error).toMatch(/installed builds/i);
    dev.stop();
  });

  it('setAutoCheck(false) is reflected in state', () => {
    svc.start();
    svc.setAutoCheck(false);
    expect(svc.getState().autoCheck).toBe(false);
  });

  describe('autoCheck 持久化（#32）', () => {
    let dir: string;
    let file: string;
    const make = (opts: { launchDelayMs?: number; intervalMs?: number } = {}) =>
      new UpdateService(logger as never, {
        updater,
        packaged: true,
        launchDelayMs: opts.launchDelayMs ?? 15_000,
        intervalMs: opts.intervalMs ?? 6 * 60 * 60 * 1000,
        settingsFile: file,
      });

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
      file = path.join(dir, 'nested', 'update-settings.json');
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('关闭后重建服务（模拟重启）仍为关闭：启动延迟与 6 小时后都不自动检查', async () => {
      const a = make();
      a.setAutoCheck(false);
      a.stop();

      const spy = jest.spyOn(updater, 'checkForUpdates');
      const b = make();
      expect(b.getState().autoCheck).toBe(false);
      b.start();
      await jest.advanceTimersByTimeAsync(15_000 + 1000);
      await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 1000);
      expect(spy).not.toHaveBeenCalled();

      // 手动检查不受影响
      const s = await b.check();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(s.status).toBe('available');
      b.stop();
    });

    it('默认开启；重新打开后重启仍开启并自动检查', async () => {
      const a = make();
      expect(a.getState().autoCheck).toBe(true);
      a.setAutoCheck(false);
      a.setAutoCheck(true);
      a.stop();
      const spy = jest.spyOn(updater, 'checkForUpdates');
      const b = make();
      expect(b.getState().autoCheck).toBe(true);
      b.start();
      await jest.advanceTimersByTimeAsync(15_000 + 1000);
      expect(spy).toHaveBeenCalledTimes(1);
      b.stop();
    });

    it('设置文件损坏 / 内容异常时回退到默认开启，不抛错', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not json');
      expect(make().getState().autoCheck).toBe(true);
      fs.writeFileSync(file, JSON.stringify({ autoCheck: 'no' }));
      expect(make().getState().autoCheck).toBe(true);
    });

    it('文件带版本号且为 0600', () => {
      const a = make();
      a.setAutoCheck(false);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, autoCheck: false });
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});
