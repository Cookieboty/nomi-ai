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
import { BrowserWindow, app } from 'electron';
import {
  autoUpdater as defaultAutoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater';

import { guardedHandle } from '../security/guardedIpc';

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
  checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null>;
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
const DEFAULT_INTERVAL = 6 * 60 * 60 * 1000; // 6h

export class UpdateService {
  private readonly updater: UpdaterLike;
  private readonly packaged: boolean;
  private readonly launchDelayMs: number;
  private readonly intervalMs: number;
  private autoCheck = true;
  private state: UpdateState;
  private launchTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly logger: ILoggerService,
    opts: UpdateServiceOptions = {},
  ) {
    this.updater = opts.updater ?? (defaultAutoUpdater as unknown as UpdaterLike);
    this.packaged = opts.packaged ?? app.isPackaged;
    this.launchDelayMs = opts.launchDelayMs ?? DEFAULT_LAUNCH_DELAY;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL;
    this.state = {
      status: this.packaged ? 'idle' : 'unavailable',
      currentVersion: app.getVersion(),
      autoCheck: true,
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
      this.patch({ status: 'error', error: msg });
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
    if (this.launchTimer) clearTimeout(this.launchTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.launchTimer = null;
    this.intervalTimer = null;
    this.updater.removeAllListeners();
    this.started = false;
  }

  setAutoCheck(on: boolean): void {
    this.autoCheck = on;
    this.patch({ autoCheck: on });
    this.rescheduleInterval();
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
    this.patch({ status: 'checking', error: undefined });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.patch({ status: 'error', error: msg, checkedAt: Date.now() });
    }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (!this.packaged) return this.getState();
    try {
      await this.updater.downloadUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.patch({ status: 'error', error: msg });
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
    this.updater.quitAndInstall(false, true);
    return this.getState();
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
