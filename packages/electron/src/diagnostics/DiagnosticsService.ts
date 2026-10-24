/**
 * 诊断日志开关：方便排查第三方供应商、编程助手、网关的问题。
 * - 开发版（未打包）必开，界面上显示为开且不可关；
 * - 正式版默认关，用户在「设置 → 隐私与权限」里打开，持久化在 userData/diagnostics.json。
 * 开着时：
 * - app.log 记到 DEBUG 级别；
 * - 网关把每次请求的请求体 / 响应正文写到 userData/gateway/trace（脱敏，24 小时后删除）；
 * - 编程助手子进程的原始收发写到 userData/logs/cli-*.jsonl（见 cliTrace.ts，7 天后删除）。
 * 模型请求的元数据（发给谁、哪个模型、成没成）不含对话内容，不受开关影响，一直记在 app.log。
 */
import fs from 'node:fs';
import path from 'node:path';

import { app, shell } from 'electron';

import { guardedHandle } from '../security/guardedIpc';
import { LogLevel, type LoggerService } from '../services/LoggerService';
import { writePrivateFile } from '../utils/privateFile';

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
}

export interface DiagnosticsDeps {
  userData: string;
  logger: LoggerService;
  /** 未打包（开发版）：必开 */
  dev?: boolean;
  /** 开关变化（网关据此刷新追踪目录） */
  onChange?: (enabled: boolean) => void;
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

  view(): DiagnosticsView {
    return {
      enabled: this.enabled(),
      forced: this.forced,
      saveLogs: this.saveLogs,
      dir: this.logDir,
    };
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
