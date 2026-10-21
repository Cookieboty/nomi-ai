/**
 * 网关子进程守护（docs/design/unified-gateway.md §5.3）：
 * - 用 utilityProcess 拉起网关，推送配置快照；配置变了就推新的（进程不重启，进行中的请求用旧快照）；
 * - 进程意外退出后按指数退避重启（1s、2s、4s…，最长 30s），连续 3 次启动失败就停下并报告；
 * - 网关就绪前发起的请求由调用方用 whenReady() 等待（最长 10 秒）。
 * fork 可注入：单测里不需要 Electron。
 */
import * as fs from 'fs';
import * as path from 'path';

import type { GatewayConfig, UsageEvent, WorkerInbound, WorkerOutbound } from '@nomi-ai/gateway';

import { t as tr } from '../i18n';

export interface GatewayChild {
  postMessage(m: WorkerInbound): void;
  on(ev: 'message', fn: (m: WorkerOutbound) => void): void;
  on(ev: 'exit', fn: (code: number) => void): void;
  kill(): boolean;
}

export type ForkGateway = (modulePath: string) => GatewayChild;

export type GatewayStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; port: number; url: string }
  | { state: 'failed'; error: string };

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

const MAX_FAILURES = 3;
const READY_TIMEOUT_MS = 10_000;

function defaultFork(): ForkGateway | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 单测（纯 Node）里没有 electron
    const e = require('electron') as {
      utilityProcess?: {
        fork(
          p: string,
          a?: string[],
          o?: { serviceName?: string; stdio?: 'ignore' | 'inherit' | 'pipe' },
        ): GatewayChild;
      };
    };
    const up = e?.utilityProcess;
    return up ? (p) => up.fork(p, [], { serviceName: 'nomi-gateway', stdio: 'ignore' }) : null;
  } catch {
    return null;
  }
}

export class GatewayProcess {
  private child: GatewayChild | null = null;
  private config: GatewayConfig | null = null;
  private status: GatewayStatus = { state: 'stopped' };
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private readyWaiters: Array<(ok: boolean) => void> = [];

  constructor(
    private readonly d: {
      logger: Logger;
      onUsage?: (e: UsageEvent) => void;
      onStatus?: (s: GatewayStatus) => void;
      fork?: ForkGateway;
      /** 网关入口文件（默认与本文件同目录的 worker.js） */
      modulePath?: string;
      /** 测试注入 */
      backoffMs?: (attempt: number) => number;
    },
  ) {}

  getStatus(): GatewayStatus {
    return this.status;
  }

  private setStatus(s: GatewayStatus) {
    this.status = s;
    this.d.onStatus?.(s);
    if (s.state === 'running' || s.state === 'failed' || s.state === 'stopped') {
      const ok = s.state === 'running';
      this.readyWaiters.splice(0).forEach((w) => w(ok));
    }
  }

  /** 推送配置；还没起进程就先起 */
  apply(config: GatewayConfig): void {
    this.config = config;
    this.stopping = false;
    if (this.child) this.child.postMessage({ type: 'config', config });
    else if (!this.restartTimer) this.spawn();
  }

  /** 等网关就绪（已经在运行就立即返回 true；失败 / 超时返回 false） */
  whenReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
    if (this.status.state === 'running') return Promise.resolve(true);
    if (this.status.state === 'failed') return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.readyWaiters.push(done);
    });
  }

  private spawn(): void {
    const fork = this.d.fork ?? defaultFork();
    const modulePath = this.d.modulePath ?? path.join(__dirname, 'worker.js');
    if (!fork || (!this.d.fork && !fs.existsSync(modulePath))) {
      this.setStatus({ state: 'failed', error: tr('当前环境无法启动网关进程') });
      return;
    }
    this.setStatus({ state: 'starting' });
    const child = fork(modulePath);
    this.child = child;
    child.on('message', (m) => this.onMessage(child, m));
    child.on('exit', (code) => this.onExit(child, code));
    if (this.config) child.postMessage({ type: 'config', config: this.config });
  }

  private onMessage(child: GatewayChild, m: WorkerOutbound) {
    if (child !== this.child) return;
    if (m.type === 'listening') {
      this.failures = 0;
      this.setStatus({ state: 'running', port: m.port, url: m.url });
      this.d.logger.info('gateway running', m.url);
    } else if (m.type === 'usage') {
      this.d.onUsage?.(m.event);
    } else if (m.type === 'error') {
      this.d.logger.warn('gateway error', m.message);
      // 端口被占用等启动失败：换配置前不再重试
      if (m.fatal) {
        this.failures = MAX_FAILURES;
        this.setStatus({ state: 'failed', error: m.message });
        this.kill();
      }
    }
  }

  private onExit(child: GatewayChild, code: number) {
    if (child !== this.child) return;
    this.child = null;
    if (this.stopping) {
      this.setStatus({ state: 'stopped' });
      return;
    }
    if (this.status.state === 'failed') return;
    this.failures++;
    this.d.logger.warn('gateway exited', { code, failures: this.failures });
    if (this.failures >= MAX_FAILURES) {
      this.setStatus({
        state: 'failed',
        error: tr('网关进程连续 {0} 次异常退出（{1}）', MAX_FAILURES, code),
      });
      return;
    }
    const delay =
      this.d.backoffMs?.(this.failures) ?? Math.min(30_000, 1000 * 2 ** (this.failures - 1));
    this.setStatus({ state: 'starting' });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }

  /** 失败后用户点「重试」：清零计数重新拉起 */
  retry(): void {
    this.failures = 0;
    this.kill();
    if (this.config) this.spawn();
  }

  private kill() {
    const c = this.child;
    this.child = null;
    try {
      c?.kill();
    } catch {
      /* 已退出 */
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.postMessage({ type: 'stop' });
    this.kill();
    this.setStatus({ state: 'stopped' });
  }
}
