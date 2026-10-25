/**
 * 诊断日志开关：方便排查第三方供应商、编程助手、网关的问题。
 * - 开发版（未打包）必开，界面上显示为开且不可关；
 * - 正式版默认关，用户在「设置 → 隐私与权限」里打开，持久化在 userData/diagnostics.json。
 * 开着时：
 * - app.log 记到 DEBUG 级别；
 * - 网关把每次请求的请求体 / 响应正文写到 userData/gateway/trace（脱敏，24 小时后删除）；
 * - 编程助手子进程的原始收发写到 userData/logs/cli-*.jsonl（见 cliTrace.ts，7 天后删除）。
 * 模型请求的元数据（发给谁、哪个模型、成没成）不含对话内容，不受开关影响，一直记在 app.log。
 * 网关正文追踪可以单独关掉：NOMI_DIAG_BODY=0（例如开发版压测时）。
 * 用量面板旧的「调试模式」并入这个开关（§8.1）：首次启动时沿用它的状态。
 */
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, dialog, shell } from 'electron';

import { t } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { LogLevel, type LoggerService } from '../services/LoggerService';
import { writePrivateFile } from '../utils/privateFile';

import { buildDiagnosticsBundle } from './bundle';
import { configureCliTrace } from './cliTrace';

const FILE = 'diagnostics.json';

export interface DiagnosticsView {
  /** 现在是否在记录 */
  enabled: boolean;
  /** 开发版必开（界面上不能关） */
  forced: boolean;
  /** 用户的选择（正式版） */
  saveLogs: boolean;
  /** 日志目录 */
  dir: string;
  /** 网关正文追踪是否在记（NOMI_DIAG_BODY=0 时诊断开着也不记） */
  bodyTrace: boolean;
}

export interface DiagnosticsExportResult {
  ok: boolean;
  path?: string;
  /** 收进诊断包的文件（包内路径） */
  files?: string[];
  error?: string;
}

export interface DiagnosticsDeps {
  userData: string;
  logger: LoggerService;
  /** 未打包（开发版）：必开 */
  dev?: boolean;
  /** 开关变化（网关据此刷新追踪目录） */
  onChange?: (enabled: boolean) => void;
  /** 还没有 diagnostics.json 时的初值：旧版「调试模式」开着就沿用 */
  legacyEnabled?: () => boolean;
  /** 网关追踪目录（userData/gateway/trace），导出时一并打包 */
  traceDir?: string;
  /** 环境变量（测试注入），默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 导出时选保存位置（测试注入）；返回 null = 取消 */
  pickSavePath?: (defaultName: string) => Promise<string | null>;
  now?: () => number;
}

export class DiagnosticsService {
  private saveLogs: boolean;
  private readonly forced: boolean;
  private readonly file: string;
  private readonly logDir: string;

  constructor(private readonly d: DiagnosticsDeps) {
    this.forced = d.dev ?? !app.isPackaged;
    this.file = path.join(d.userData, FILE);
    this.logDir = path.join(d.userData, 'logs');
    this.saveLogs = this.load();
    configureCliTrace({ dir: this.logDir, enabled: () => this.enabled() });
    this.apply();
  }

  enabled(): boolean {
    return this.forced || this.saveLogs;
  }

  /** 网关正文追踪：诊断开着，且没有用 NOMI_DIAG_BODY=0 单独关掉 */
  bodyTrace(): boolean {
    return this.enabled() && (this.d.env ?? process.env).NOMI_DIAG_BODY !== '0';
  }

  view(): DiagnosticsView {
    return {
      enabled: this.enabled(),
      forced: this.forced,
      saveLogs: this.saveLogs,
      dir: this.logDir,
      bodyTrace: this.bodyTrace(),
    };
  }

  /** 导出最近 24 小时的诊断包（zip，打包前再脱敏一遍） */
  async exportBundle(): Promise<DiagnosticsExportResult> {
    const now = this.d.now?.() ?? Date.now();
    const name = `nomi-diagnostics-${new Date(now).toISOString().replace(/[:.]/g, '-')}.zip`;
    const file = await (this.d.pickSavePath ?? pickSavePath)(name);
    if (!file) return { ok: false };
    try {
      const { data, files } = buildDiagnosticsBundle(
        {
          logDir: this.logDir,
          traceDir: this.d.traceDir ?? path.join(this.d.userData, 'gateway', 'trace'),
        },
        { now, meta: { version: app.getVersion?.() ?? '', platform: process.platform } },
      );
      fs.writeFileSync(file, data, { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* Windows 等平台忽略 */
      }
      this.d.logger.info('diagnostics bundle exported', { files: files.length });
      return { ok: true, path: file, files };
    } catch (e) {
      this.d.logger.warn('diagnostics bundle export failed', { error: (e as Error).message });
      return { ok: false, error: (e as Error).message };
    }
  }

  set(on: boolean): DiagnosticsView {
    if (on !== this.saveLogs) {
      const before = this.enabled();
      this.saveLogs = on;
      try {
        writePrivateFile(this.file, JSON.stringify({ version: 1, saveLogs: on }));
      } catch (e) {
        this.d.logger.warn('diagnostics settings save failed', { error: (e as Error).message });
      }
      this.apply();
      this.d.logger.info('diagnostics logs', { saveLogs: on, enabled: this.enabled() });
      if (before !== this.enabled()) this.d.onChange?.(this.enabled());
    }
    return this.view();
  }

  registerIpc(): void {
    const opts = { owner: 'DiagnosticsService' };
    guardedHandle('diagnostics:get', () => this.view(), opts);
    guardedHandle('diagnostics:set', (on) => this.set(on === true), opts);
    guardedHandle('diagnostics:export', () => this.exportBundle(), opts);
    guardedHandle(
      'diagnostics:open-folder',
      async () => {
        fs.mkdirSync(this.logDir, { recursive: true });
        const err = await shell.openPath(this.logDir);
        if (err) throw new Error(err);
        return true;
      },
      opts,
    );
  }

  private load(): boolean {
    if (!fs.existsSync(this.file)) {
      let legacy: boolean;
      try {
        legacy = this.d.legacyEnabled?.() === true;
      } catch {
        legacy = false;
      }
      if (legacy) {
        try {
          writePrivateFile(this.file, JSON.stringify({ version: 1, saveLogs: true }));
        } catch {
          /* 下次启动再迁移 */
        }
      }
      return legacy;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { saveLogs?: unknown };
      return raw.saveLogs === true;
    } catch {
      return false;
    }
  }

  private apply(): void {
    const dev = process.env.NODE_ENV === 'development';
    this.d.logger.setLevel(this.enabled() || dev ? LogLevel.DEBUG : LogLevel.INFO);
  }
}

async function pickSavePath(defaultName: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    title: t('electron.common.export-diagnostics-bundle'),
    defaultPath: defaultName,
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}
