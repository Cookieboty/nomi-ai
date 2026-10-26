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
  isReleasePendingError,
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
    expect(await svc.check()).toMatchObject({ status: 'error', errorStage: 'check' });
  });

  describe('最新 Release 缺本平台 latest*.yml（#146）', () => {
    /** 模拟 electron-updater GitHubProvider：先发 error 事件再 reject（与真实 AppUpdater 一致） */
    const missingManifest = (file: string) => {
      const err = Object.assign(
        new Error(
          `Cannot find ${file} in the latest release artifacts (https://github.com/Cookieboty/nomi-ai/releases/download/v2.0.3/${file}): HttpError: 404 \n"method: GET url: ..."\n    at createHttpError (httpExecutor.js:53:12)`,
        ),
        { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
      );
      updater.checkForUpdates = async () => {
        updater.emit('checking-for-update');
        updater.emit('error', err);
        throw err;
      };
      return err;
    };

    it.each(['latest.yml', 'latest-mac.yml', 'latest-linux.yml'])(
      '%s 404：手动检查 → 暂无可用更新 + 发布中提示，不带错误堆栈',
      async (file) => {
        missingManifest(file);
        svc.start();
        const s = await svc.check({ manual: true });
        expect(s).toMatchObject({ status: 'not-available', notice: 'release-pending' });
        expect(s.error).toBeUndefined();
        expect(s.errorStage).toBeUndefined();
        expect(s.checkedAt).toEqual(expect.any(Number));
      },
    );

    it('自动检查（启动 / 定时）静默：not-available 且不带提示', async () => {
      missingManifest('latest.yml');
      svc.start();
      const s = await svc.check();
      expect(s.status).toBe('not-available');
      expect(s.notice).toBeUndefined();
      expect(s.error).toBeUndefined();
    });

    it('只有 message、没有 code 的 404 也识别（旧版 electron-updater）', async () => {
      const err = new Error(
        'Cannot find latest.yml in the latest release artifacts (https://x/latest.yml): HttpError: 404',
      );
      updater.checkError = err;
      svc.start();
      expect(await svc.check({ manual: true })).toMatchObject({
        status: 'not-available',
        notice: 'release-pending',
      });
    });

    it('下一次检查开始时清掉提示；产物传齐后正常发现新版本', async () => {
      missingManifest('latest.yml');
      svc.start();
      await svc.check({ manual: true });
      updater.checkForUpdates = FakeUpdater.prototype.checkForUpdates.bind(updater);
      const s = await svc.check({ manual: true });
      expect(s).toMatchObject({ status: 'available', availableVersion: '1.0.1' });
      expect(s.notice).toBeUndefined();
    });

    it('其他真实错误（含别的 404）仍按失败处理', async () => {
      updater.checkError = Object.assign(
        new Error('Unable to find latest version on GitHub (https://x): HttpError: 404'),
        { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' },
      );
      svc.start();
      expect(await svc.check({ manual: true })).toMatchObject({
        status: 'error',
        errorStage: 'check',
      });
    });

    it('isReleasePendingError 判定', () => {
      expect(isReleasePendingError({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })).toBe(true);
      expect(
        isReleasePendingError(new Error('Cannot find channel "latest-mac.yml" update info: 404')),
      ).toBe(true);
      expect(isReleasePendingError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
      expect(isReleasePendingError(new Error('HttpError: 404 on Nomi-2.0.3.exe'))).toBe(false);
      expect(isReleasePendingError(null)).toBe(false);
    });
  });

  describe('失败后能重试', () => {
    /** 模拟 electron-updater：检查后自动下载（autoDownload），返回取消令牌与下载 promise */
    const autoDownloadUpdater = (initial: 'fail' | 'stall' | 'ok') => {
      const u = new FakeUpdater();
      const ctl = { mode: initial };
      const tokens: Array<{ cancel: jest.Mock }> = [];
      u.checkForUpdates = async () => {
        u.emit('checking-for-update');
        u.emit('update-available', { version: '1.0.1' });
        const cancellationToken = { cancel: jest.fn() };
        tokens.push(cancellationToken);
        let downloadPromise: Promise<unknown>;
        if (ctl.mode === 'fail') {
          u.emit('download-progress', {
            percent: 10,
            bytesPerSecond: 1,
            transferred: 1,
            total: 10,
          });
          const err = new Error('ECONNRESET');
          u.emit('error', err);
          downloadPromise = Promise.reject(err);
        } else if (ctl.mode === 'stall') {
          u.emit('download-progress', {
            percent: 30,
            bytesPerSecond: 1,
            transferred: 3,
            total: 10,
          });
          downloadPromise = new Promise(() => undefined); // 连接静默断开：永远不结束
        } else {
          u.emit('update-downloaded', { version: '1.0.1' });
          downloadPromise = Promise.resolve([]);
        }
        return { updateInfo: { version: '1.0.1' }, cancellationToken, downloadPromise } as never;
      };
      return { u, tokens, ctl };
    };

    it('下载失败：标成「下载失败」，再检查会重新下载直到完成', async () => {
      const { u, ctl } = autoDownloadUpdater('fail');
      const s = new UpdateService(logger as never, {
        updater: u,
        packaged: true,
        launchDelayMs: 0,
        intervalMs: 0,
      });
      s.start();
      expect(await s.check()).toMatchObject({
        status: 'error',
        errorStage: 'download',
        error: 'ECONNRESET',
      });
      ctl.mode = 'ok';
      expect(await s.check()).toMatchObject({ status: 'downloaded', errorStage: undefined });
      s.stop();
    });

    it('下载卡住（没有进度也没有 error）：超时后取消并转为失败；重试先取消旧下载再重新检查', async () => {
      jest.useFakeTimers();
      try {
        const { u, tokens } = autoDownloadUpdater('stall');
        const s = new UpdateService(logger as never, {
          updater: u,
          packaged: true,
          launchDelayMs: 0,
          intervalMs: 0,
          stallMs: 5000,
        });
        s.start();
        expect((await s.check()).status).toBe('downloading');
        jest.advanceTimersByTime(4999);
        expect(s.getState().status).toBe('downloading');
        jest.advanceTimersByTime(1);
        expect(s.getState()).toMatchObject({ status: 'error', errorStage: 'download' });
        expect(tokens[0]!.cancel).toHaveBeenCalledTimes(1);
        // 重试：又卡住时，第二次的令牌在下一次重试前被取消
        await s.check();
        expect(tokens).toHaveLength(2);
        await s.check();
        expect(tokens[1]!.cancel).toHaveBeenCalledTimes(1);
        s.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    it('检查卡住（checkForUpdates 一直不返回）：超时后转为「检查失败」，能再次检查', async () => {
      jest.useFakeTimers();
      try {
        const u = new FakeUpdater();
        let hang = true;
        u.checkForUpdates = (() => {
          u.emit('checking-for-update');
          return hang ? new Promise(() => undefined) : Promise.resolve(null);
        }) as never;
        const s = new UpdateService(logger as never, {
          updater: u,
          packaged: true,
          launchDelayMs: 0,
          intervalMs: 0,
          stallMs: 5000,
        });
        s.start();
        void s.check();
        expect(s.getState().status).toBe('checking');
        jest.advanceTimersByTime(4999);
        expect(s.getState().status).toBe('checking');
        jest.advanceTimersByTime(1);
        expect(s.getState()).toMatchObject({ status: 'error', errorStage: 'check' });
        expect(s.getState().error).toMatch(/check stalled/);
        // 正常的检查结果到来不会被旧计时器打断
        hang = false;
        void s.check();
        expect(s.getState().status).toBe('checking');
        s.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    it('有进度就不算卡住', async () => {
      jest.useFakeTimers();
      try {
        const { u } = autoDownloadUpdater('stall');
        const s = new UpdateService(logger as never, {
          updater: u,
          packaged: true,
          launchDelayMs: 0,
          intervalMs: 0,
          stallMs: 5000,
        });
        s.start();
        await s.check();
        for (let i = 0; i < 5; i++) {
          jest.advanceTimersByTime(4000);
          u.emit('download-progress', {
            percent: 40 + i,
            bytesPerSecond: 1,
            transferred: 4,
            total: 10,
          });
        }
        expect(s.getState().status).toBe('downloading');
        s.stop();
      } finally {
        jest.useRealTimers();
      }
    });

    it('安装失败标成「安装失败」', async () => {
      svc.start();
      await svc.check();
      await svc.download();
      updater.quitAndInstall = () => {
        throw new Error('not in /Applications');
      };
      expect(svc.install()).toMatchObject({ status: 'error', errorStage: 'install' });
    });
  });

  it('check() surfaces updater errors (message)', async () => {
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
