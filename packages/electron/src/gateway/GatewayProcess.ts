/**
 * 网关子进程守护（docs/design/unified-gateway.md §5.3）：
 * - 用 utilityProcess 拉起网关，推送配置快照；配置变了就推新的（进程不重启，进行中的请求用旧快照）；
 * - 进程意外退出后按指数退避重启（1s、2s、4s…，最长 30s）；
 * - 崩溃熔断：滑动窗口内失败次数超预算（默认 60s 内 5 次）则停止自动重启并标 failed，界面「重试」清零计数；
 * - 网关就绪前发起的请求由调用方用 whenReady() 等待（最长 10 秒）。
 * fork 可注入：单测里不需要 Electron。
 */
import * as fs from 'fs';
import * as path from 'path';

import type {
  BindingAck,
  BindingMessage,
  GatewayConfig,
  KeyStatusEvent,
  LearnEvent,
  UsageEvent,
  WorkerInbound,
  WorkerOutbound,
} from '@nomi-ai/gateway';

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

/** 滑动窗口内失败次数达到此值则熔断 */
export const CRASH_FUSE_MAX = 5;
/** 熔断滑动窗口（毫秒） */
export const CRASH_FUSE_WINDOW_MS = 60_000;
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
  /** 最近失败时间戳（滑动窗口熔断） */
  private failureTimes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private readyWaiters: Array<(ok: boolean) => void> = [];

  constructor(
    private readonly d: {
      logger: Logger;
      onUsage?: (e: UsageEvent) => void;
      onLearn?: (e: LearnEvent) => void;
      onKeyStatus?: (e: KeyStatusEvent) => void;
      onStatus?: (s: GatewayStatus) => void;
      fork?: ForkGateway;
      /** 网关入口文件（默认与本文件同目录的 worker.js） */
      modulePath?: string;
      /** 测试注入 */
      backoffMs?: (attempt: number) => number;
      /** 测试注入时钟 */
      now?: () => number;
      crashFuseMax?: number;
      crashFuseWindowMs?: number;
    },
  ) {}

  getStatus(): GatewayStatus {
    return this.status;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private fuseMax(): number {
    return this.d.crashFuseMax ?? CRASH_FUSE_MAX;
  }

  private fuseWindow(): number {
    return this.d.crashFuseWindowMs ?? CRASH_FUSE_WINDOW_MS;
  }

  /** 记录一次失败；若窗口内次数达熔断阈值返回 true */
  private noteFailure(): boolean {
    const now = this.now();
    const windowMs = this.fuseWindow();
    this.failureTimes.push(now);
    this.failureTimes = this.failureTimes.filter((t) => now - t <= windowMs);
    return this.failureTimes.length >= this.fuseMax();
  }

  private clearFailures(): void {
    this.failureTimes = [];
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

  private tabHooks: { ack?: (m: BindingAck) => void; spawn?: () => void | Promise<void> } = {};

  /**
   * 标签绑定（§6.7）：ack = 网关的应答；spawn = 拉起了新的网关进程（配置已推送），
   * 调用方据此重新登记还活着的绑定。
   */
  bindTabs(h: { ack: (m: BindingAck) => void; spawn: () => void | Promise<void> }): void {
    this.tabHooks = h;
  }

  /** 发一条绑定消息；没有网关进程时返回 false（调用方报错，不启动 CLI） */
  send(m: BindingMessage): boolean {
    if (!this.child) return false;
    this.child.postMessage(m);
    return true;
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
    void Promise.resolve(this.tabHooks.spawn?.()).catch((e) =>
      this.d.logger.warn('gateway tab bindings replay failed', String(e)),
    );
  }

  private onMessage(child: GatewayChild, m: WorkerOutbound) {
    if (child !== this.child) return;
    if (m.type === 'listening') {
      this.clearFailures();
      this.setStatus({ state: 'running', port: m.port, url: m.url });
      this.d.logger.info('gateway running', m.url);
    } else if (m.type === 'usage') {
      this.d.onUsage?.(m.event);
    } else if (m.type === 'learn') {
      this.d.onLearn?.(m.event);
    } else if (m.type === 'key-status') {
      this.d.onKeyStatus?.(m.event);
    } else if (m.type === 'binding:ok' || m.type === 'binding:error') {
      this.tabHooks.ack?.(m);
    } else if (m.type === 'error') {
      this.d.logger.warn('gateway error', m.message);
      // 端口被占用等启动失败：换配置前不再重试
      if (m.fatal) {
        this.clearFailures();
        this.noteFailure();
        // 直接标 failed（致命启动错误不走滑动窗口重试）
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
    const fused = this.noteFailure();
    const n = this.failureTimes.length;
    this.d.logger.warn('gateway exited', { code, failures: n, windowMs: this.fuseWindow() });
    if (fused) {
      this.setStatus({
        state: 'failed',
        error: tr(
          '网关进程在 {0} 秒内异常退出 {1} 次（最近退出码 {2}），已停止自动重启',
          Math.round(this.fuseWindow() / 1000),
          this.fuseMax(),
          code,
        ),
      });
      return;
    }
    const delay = this.d.backoffMs?.(n) ?? Math.min(30_000, 1000 * 2 ** (n - 1));
    this.setStatus({ state: 'starting' });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }

  /** 失败后用户点「重试」：清零熔断计数重新拉起 */
  retry(): void {
    this.clearFailures();
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
