/**
 * 网关请求日志与调试追踪开关（docs/design/unified-gateway.md §14、§4.5）：
 * - 最近 200 条请求的元数据放在内存里，防抖写到 userData/gateway/requests.json（0600）；
 * - 「调试模式」开关（默认关）持久化在 userData/gateway/observe.json；打开时 traceDir() 给出
 *   userData/gateway/trace，GatewayService 把它放进网关配置，由网关进程写追踪文件（@nomi-ai/gateway trace.ts）；
 * - 追踪文件超过 24 小时自动删除：网关写入时顺带清理，这里在启动时和每小时再清一次（开关关掉后也会清）。
 *
 * 网关事件不写入用量账本，口径见 gatewayRequests.ts 顶部说明。
 */
import fs from 'node:fs';
import path from 'node:path';

import { pruneTraces } from '@nomi-ai/gateway';
import { BrowserWindow } from 'electron';

import { guardedHandle } from '../security/guardedIpc';
import { writePrivateFile } from '../utils/privateFile';

import {
  aggregateGateway,
  GATEWAY_REQUEST_CAP,
  sanitizeEntries,
  toEntry,
  type GatewayRequestEntry,
  type GatewayUsageEventLike,
} from './gatewayRequests';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export interface GatewayRequestLogDeps {
  /** userData/gateway */
  root: string;
  logger: Logger;
  /** 供应商 id / Key id → 显示名（Key 只给名字或掩码） */
  names?: (providerId?: string, keyId?: string) => { provider?: string; key?: string };
  /** 调试模式开关变化：重新给网关推一次配置 */
  onTraceChange?: (enabled: boolean) => void;
  now?: () => number;
  /** 写盘防抖（ms），默认 2000 */
  flushMs?: number;
  /** 追踪清理间隔（ms），默认 1 小时；0 = 不定时清理（测试） */
  pruneMs?: number;
  broadcast?: (channel: string, payload: unknown) => void;
}

const REQUESTS_FILE = 'requests.json';
const OBSERVE_FILE = 'observe.json';
const TRACE_DIR = 'trace';

export class GatewayRequestLog {
  private entries: GatewayRequestEntry[] = [];
  private trace = false;
  private seq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: GatewayRequestLogDeps) {
    this.load();
    this.prune();
    const every = d.pruneMs ?? 60 * 60 * 1000;
    if (every > 0) {
      this.pruneTimer = setInterval(() => this.prune(), every);
      (this.pruneTimer as { unref?: () => void }).unref?.();
    }
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.d.root, REQUESTS_FILE), 'utf8'));
      this.entries = sanitizeEntries((raw as { requests?: unknown })?.requests);
    } catch {
      this.entries = [];
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.d.root, OBSERVE_FILE), 'utf8'));
      this.trace = (raw as { trace?: unknown })?.trace === true;
    } catch {
      this.trace = false;
    }
  }

  /** 记一条网关请求（所有客户端都记，含 Nomi 自己；只是元数据，不计入用量账本） */
  add(e: GatewayUsageEventLike): GatewayRequestEntry {
    const names = this.d.names?.(e.provider, e.keyId) ?? {};
    const entry = toEntry(e, `${e.startedAt}-${++this.seq}`, names);
    this.entries.push(entry);
    if (this.entries.length > GATEWAY_REQUEST_CAP)
      this.entries.splice(0, this.entries.length - GATEWAY_REQUEST_CAP);
    this.scheduleFlush();
    this.changed();
    return entry;
  }

  /** 新的在前 */
  list(): GatewayRequestEntry[] {
    return [...this.entries].reverse();
  }

  view() {
    return {
      requests: this.list(),
      ...aggregateGateway(this.entries),
      trace: { enabled: this.trace, dir: this.traceDirPath() },
    };
  }

  clear(): void {
    this.entries = [];
    this.flush();
    this.changed();
  }

  // ---------------------------------------------------------------- 调试追踪

  private traceDirPath(): string {
    return path.join(this.d.root, TRACE_DIR);
  }

  /** 调试模式打开时的追踪目录；关着返回 undefined（网关配置里就不带 traceDir） */
  traceDir(): string | undefined {
    return this.trace ? this.traceDirPath() : undefined;
  }

  traceEnabled(): boolean {
    return this.trace;
  }

  setTrace(enabled: boolean): { enabled: boolean; dir: string } {
    if (enabled !== this.trace) {
      this.trace = enabled;
      try {
        fs.mkdirSync(this.d.root, { recursive: true });
        writePrivateFile(
          path.join(this.d.root, OBSERVE_FILE),
          JSON.stringify({ version: 1, trace: enabled }),
        );
      } catch (e) {
        this.d.logger.warn('gateway observe settings save failed', { error: (e as Error).message });
      }
      this.d.logger.info('gateway debug trace', { enabled });
      this.prune();
      this.d.onTraceChange?.(enabled);
      this.changed();
    }
    return { enabled: this.trace, dir: this.traceDirPath() };
  }

  /** 删除超过 24 小时的追踪文件 */
  prune(): number {
    return pruneTraces(this.traceDirPath(), this.now());
  }

  // ---------------------------------------------------------------- 持久化

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.d.flushMs ?? 2000);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      fs.mkdirSync(this.d.root, { recursive: true });
      writePrivateFile(
        path.join(this.d.root, REQUESTS_FILE),
        JSON.stringify({ version: 1, requests: this.entries }),
      );
    } catch (e) {
      this.d.logger.warn('gateway request log save failed', { error: (e as Error).message });
    }
  }

  dispose(): void {
    if (this.flushTimer) this.flush();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  // ---------------------------------------------------------------- IPC

  private changed(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      if (this.d.broadcast) {
        this.d.broadcast('ai:usage:gateway-changed', null);
        return;
      }
      for (const w of BrowserWindow.getAllWindows())
        if (!w.isDestroyed()) w.webContents.send('ai:usage:gateway-changed', null);
    }, 1000);
    (this.broadcastTimer as { unref?: () => void }).unref?.();
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'GatewayRequestLog' });
    handle('ai:usage:gateway-requests', () => this.view());
    handle('ai:usage:gateway-trace-set', (v) => this.setTrace(v === true));
    handle('ai:usage:gateway-clear', () => {
      this.clear();
      return this.view();
    });
  }
}

let inst: GatewayRequestLog | null = null;
export function initGatewayRequestLog(d: GatewayRequestLogDeps): GatewayRequestLog {
  inst?.dispose();
  inst = new GatewayRequestLog(d);
  return inst;
}
export function getGatewayRequestLog(): GatewayRequestLog | null {
  return inst;
}
