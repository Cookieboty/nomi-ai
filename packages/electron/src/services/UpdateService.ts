/**
 * Auto-update via electron-updater + GitHub Releases (Cookieboty/nomi-ai).
 *
 * Packaged builds only: checks on launch (delayed), on a periodic timer, and when the user
 * clicks "Check for updates" in Settings. Download is automatic once an update is found;
 * installing requires an explicit user consent (quitAndInstall).
 *
 * Dev / unpackaged: status stays "idle" / "unavailable"; check() returns a clear reason so
 * Settings can explain that updates only apply to installed builds.
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, app } from 'electron';
import {
  autoUpdater as defaultAutoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater';

import { guardedHandle } from '../security/guardedIpc';
import { writePrivateFileAtomic } from '../utils/privateFile';

import { type ILoggerService } from './LoggerService';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unavailable';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
  /** 失败在哪一步（status 为 error 时）：检查 / 下载 / 安装——界面据此说明，并给「重试」 */
  errorStage?: 'check' | 'download' | 'install';
  /** last successful check (ms since epoch) */
  checkedAt?: number;
  autoCheck: boolean;
}

/** Narrow surface we need from electron-updater (injectable for unit tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{
    updateInfo: UpdateInfo;
    /** autoDownload 时自动开始的下载可以用它取消（卡住时重试要先取消，否则一直复用卡住的下载） */
    cancellationToken?: { cancel(): void };
    downloadPromise?: Promise<unknown> | null;
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
}

export interface UpdateServiceOptions {
  updater?: UpdaterLike;
  /** delay before the first automatic check (ms); 0 = skip launch check */
  launchDelayMs?: number;
  /** periodic re-check interval (ms); 0 = no timer */
  intervalMs?: number;
  /** force "packaged" for tests */
  packaged?: boolean;
  /** 检查 / 下载多久没有任何进展算卡住（ms）；0 = 不检测 */
  stallMs?: number;
  /**
   * Where the "check automatically" switch is persisted. Defaults to
   * `<userData>/update-settings.json`; `null` disables persistence.
   */
  settingsFile?: string | null;
}

interface StoredUpdateSettings {
  version: 1;
  autoCheck: boolean;
}

function defaultSettingsFile(): string | null {
  try {
    return path.join(app.getPath('userData'), 'update-settings.json');
  } catch {
    return null;
  }
}

/** Only an explicit stored `false` turns the switch off; a missing / corrupt file keeps the default (on). */
function loadAutoCheck(file: string | null): boolean {
  if (!file) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredUpdateSettings> | null;
    return raw?.autoCheck !== false;
  } catch {
    return true;
  }
}

const CHANNEL = {
  get: 'updates:get',
  check: 'updates:check',
  download: 'updates:download',
  install: 'updates:install',
  setAutoCheck: 'updates:set-auto-check',
  changed: 'updates:changed',
} as const;

const DEFAULT_LAUNCH_DELAY = 15_000;
/**
 * 下载卡住的判定：Electron net 请求上 electron-updater 的 socket 超时不生效，连接静默断开时
 * 既没有进度也没有 error，状态会永远停在「正在下载」、按钮一直禁用。
 */
const DEFAULT_STALL_MS = 90_000;
const DEFAULT_INTERVAL = 6 * 60 * 60 * 1000; // 6h

export class UpdateService {
  private readonly updater: UpdaterLike;
  private readonly packaged: boolean;
  private readonly launchDelayMs: number;
  private readonly intervalMs: number;
  private autoCheck: boolean;
  private readonly settingsFile: string | null;
  private state: UpdateState;
  private launchTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly stallMs: number;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** 正在进行的自动下载的取消令牌（来自 checkForUpdates 的返回） */
  private downloadToken: { cancel(): void } | null = null;

  constructor(
    private readonly logger: ILoggerService,
    opts: UpdateServiceOptions = {},
  ) {
    this.updater = opts.updater ?? (defaultAutoUpdater as unknown as UpdaterLike);
    this.packaged = opts.packaged ?? app.isPackaged;
    this.launchDelayMs = opts.launchDelayMs ?? DEFAULT_LAUNCH_DELAY;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    // 必须在 start() 之前就恢复用户的选择：启动检查 / 定时器都读这个值
    this.settingsFile = opts.settingsFile === undefined ? defaultSettingsFile() : opts.settingsFile;
    this.autoCheck = loadAutoCheck(this.settingsFile);
    this.state = {
      status: this.packaged ? 'idle' : 'unavailable',
      currentVersion: app.getVersion(),
      autoCheck: this.autoCheck,
    };
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  registerIpc(): void {
    const opts = { owner: 'UpdateService', wrapErrors: false };
    guardedHandle(CHANNEL.get, () => this.getState(), opts);
    guardedHandle(CHANNEL.check, () => this.check(), opts);
    guardedHandle(CHANNEL.download, () => this.download(), opts);
    guardedHandle(CHANNEL.install, () => this.install(), opts);
    guardedHandle(
      CHANNEL.setAutoCheck,
      (on) => {
        this.setAutoCheck(on === true);
        return this.getState();
      },
      opts,
    );
  }

  /** Wire updater events and schedule launch / periodic checks. Safe to call once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false; // require explicit consent
    this.updater.allowPrerelease = false;
    this.updater.logger = {
      info: (m: string) => this.logger.info(`[updater] ${m}`),
      warn: (m: string) => this.logger.warn(`[updater] ${m}`),
      error: (m: string) => this.logger.error(`[updater] ${m}`),
      debug: (m: string) => this.logger.debug(`[updater] ${m}`),
    };

    this.updater.on('checking-for-update', () => this.patch({ status: 'checking' }));
    this.updater.on('update-available', (info) => {
      const i = info as UpdateInfo;
      this.patch({
        status: 'available',
        availableVersion: i.version,
        releaseName: i.releaseName,
        releaseNotes: typeof i.releaseNotes === 'string' ? i.releaseNotes : null,
        checkedAt: Date.now(),
        error: undefined,
      });
    });
    this.updater.on('update-not-available', () =>
      this.patch({
        status: 'not-available',
        availableVersion: undefined,
        checkedAt: Date.now(),
        error: undefined,
      }),
    );
    this.updater.on('download-progress', (p) => {
      const info = p as ProgressInfo;
      this.patch({
        status: 'downloading',
        percent: info.percent,
        bytesPerSecond: info.bytesPerSecond,
        transferred: info.transferred,
        total: info.total,
      });
    });
    this.updater.on('update-downloaded', (info) => {
      const i = info as UpdateInfo;
      this.patch({
        status: 'downloaded',
        availableVersion: i.version,
        releaseName: i.releaseName,
        percent: 100,
        error: undefined,
      });
    });
    this.updater.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('[updater] error', { error: msg });
      this.fail(msg);
    });

    if (!this.packaged) {
      this.logger.info('[updater] skipped (unpackaged / dev build)');
      return;
    }
    if (this.launchDelayMs > 0) {
      this.launchTimer = setTimeout(() => {
        if (this.autoCheck) void this.check().catch(() => undefined);
      }, this.launchDelayMs);
    }
    this.rescheduleInterval();
  }

  stop(): void {
    this.clearStall();
    if (this.launchTimer) clearTimeout(this.launchTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.launchTimer = null;
    this.intervalTimer = null;
    this.updater.removeAllListeners();
    this.started = false;
  }

  setAutoCheck(on: boolean): void {
    this.autoCheck = on;
    this.persistAutoCheck();
    this.patch({ autoCheck: on });
    this.rescheduleInterval();
  }

  private persistAutoCheck(): void {
    if (!this.settingsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      const data: StoredUpdateSettings = { version: 1, autoCheck: this.autoCheck };
      writePrivateFileAtomic(this.settingsFile, JSON.stringify(data));
    } catch (err) {
      this.logger.warn('[updater] failed to persist autoCheck', { error: String(err) });
    }
  }

  async check(): Promise<UpdateState> {
    if (!this.packaged) {
      this.patch({
        status: 'unavailable',
        error: 'updates only apply to installed builds',
        checkedAt: Date.now(),
      });
      return this.getState();
    }
    // 上一次的自动下载还挂着（卡住 / 失败后重试）：先取消，否则 electron-updater 会一直复用它
    this.cancelDownload();
    this.patch({ status: 'checking', error: undefined, errorStage: undefined });
    try {
      const r = await this.updater.checkForUpdates();
      this.downloadToken = r?.cancellationToken ?? null;
      // 自动下载的失败已经通过 error 事件反映到状态上；这里只防止未处理的 rejection
      void r?.downloadPromise?.catch(() => undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.fail(msg, 'check');
      this.patch({ checkedAt: Date.now() });
    }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (!this.packaged) return this.getState();
    try {
      await this.updater.downloadUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.fail(msg, 'download');
    }
    return this.getState();
  }

  /** User confirmed: quit and install the downloaded update. */
  install(): UpdateState {
    if (this.state.status !== 'downloaded') {
      return this.getState();
    }
    this.logger.info('[updater] quitAndInstall');
    // isSilent=false, isForceRunAfter=true → relaunch after install
    try {
      this.updater.quitAndInstall(false, true);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err), 'install');
    }
    return this.getState();
  }

  /** 失败在哪一步：没指定时按失败前的状态推断（下载中 / 刚发现 → 下载，已下载 → 安装，其余 → 检查） */
  private fail(msg: string, stage?: UpdateState['errorStage']): void {
    const prev = this.state.status;
    const inferred: UpdateState['errorStage'] =
      prev === 'downloading' || prev === 'available'
        ? 'download'
        : prev === 'downloaded'
          ? 'install'
          : 'check';
    this.downloadToken = null;
    this.patch({ status: 'error', error: msg, errorStage: stage ?? inferred });
  }

  private cancelDownload(): void {
    const token = this.downloadToken;
    this.downloadToken = null;
    try {
      token?.cancel();
    } catch {
      /* 已结束 */
    }
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /**
   * 下载中每次有进展都重新计时；超过 stallMs 没动静就取消并转为失败，让用户能重试。
   * 「发现新版本」也算：总是自动下载，第一个进度到达前就卡住时状态还停在 available。
   */
  private watchStall(): void {
    this.clearStall();
    const active = () => this.state.status === 'downloading' || this.state.status === 'available';
    if (this.stallMs <= 0 || !active()) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (!active()) return;
      const secs = Math.round(this.stallMs / 1000);
      this.logger.warn('[updater] download stalled', { secs });
      this.cancelDownload();
      this.fail(`download stalled: no progress for ${secs}s`, 'download');
    }, this.stallMs);
    // 不阻止应用退出
    if (typeof this.stallTimer === 'object' && 'unref' in this.stallTimer) this.stallTimer.unref();
  }

  private rescheduleInterval(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.intervalTimer = null;
    if (!this.packaged || !this.autoCheck || this.intervalMs <= 0) return;
    this.intervalTimer = setInterval(() => {
      if (this.autoCheck) void this.check().catch(() => undefined);
    }, this.intervalMs);
  }

  private patch(partial: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...partial,
      currentVersion: app.getVersion(),
      autoCheck: this.autoCheck,
    };
    if (this.state.status !== 'error') this.state.errorStage = undefined;
    this.watchStall();
    this.broadcast();
  }

  private broadcast(): void {
    const snap = this.getState();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(CHANNEL.changed, snap);
    }
  }
}

let singleton: UpdateService | null = null;

export function getUpdateService(
  logger?: ILoggerService,
  opts?: UpdateServiceOptions,
): UpdateService {
  if (!singleton) {
    if (!logger) throw new Error('UpdateService requires a logger on first call');
    singleton = new UpdateService(logger, opts);
  }
  return singleton;
}

/** test-only */
export function _resetUpdateServiceForTests(): void {
  singleton?.stop();
  singleton = null;
}

export const UPDATE_IPC = CHANNEL;
