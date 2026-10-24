/**
 * 网关正文追踪目录与旧「最近请求」的迁移：
 * - 正文追踪开不开由诊断日志开关决定（traceOn，docs/design/cli-plugin-architecture.md §8.1）；开着时
 *   traceDir() 给出 userData/gateway/trace，GatewayService 放进网关配置，由网关进程写追踪文件
 *   （@nomi-ai/gateway trace.ts）；
 * - 追踪文件超过 24 小时自动删除：网关写入时顺带清理，这里在启动时、每小时、开关变化时再清一次；
 * - 旧版的「最近请求」（userData/gateway/requests.json）首次启动时导入模型质量账本后删除
 *   （docs/design/model-quality.md §4.2），请求明细从此由「模型质量」提供。
 */
import fs from 'node:fs';
import path from 'node:path';

import { pruneTraces } from '@nomi-ai/gateway';
import type { QualityRecord } from '@nomi-ai/types';

import { sanitizeEntries } from './gatewayRequests';
import { recordFromEntry } from './quality/legacy';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export interface GatewayRequestLogDeps {
  /** userData/gateway */
  root: string;
  logger: Logger;
  /** 正文追踪是否开着（诊断日志开关） */
  traceOn: () => boolean;
  /** 旧 requests.json 的条目导入模型质量账本 */
  importLegacy?: (records: QualityRecord[]) => void;
  now?: () => number;
  /** 追踪清理间隔（ms），默认 1 小时；0 = 不定时清理（测试） */
  pruneMs?: number;
}

const REQUESTS_FILE = 'requests.json';
const OBSERVE_FILE = 'observe.json';
const TRACE_DIR = 'trace';

export class GatewayRequestLog {
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: GatewayRequestLogDeps) {
    this.migrateLegacy();
    this.prune();
    const every = d.pruneMs ?? 60 * 60 * 1000;
    if (every > 0) {
      this.pruneTimer = setInterval(() => this.prune(), every);
      (this.pruneTimer as { unref?: () => void }).unref?.();
    }
  }

  /** 旧的 requests.json：导入质量账本一次后删除；读不懂的文件留着不动 */
  private migrateLegacy(): void {
    const file = path.join(this.d.root, REQUESTS_FILE);
    if (!this.d.importLegacy || !fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { requests?: unknown };
      const entries = sanitizeEntries(raw?.requests);
      if (entries.length) this.d.importLegacy(entries.map(recordFromEntry));
      fs.rmSync(file, { force: true });
    } catch (e) {
      this.d.logger.warn('gateway request log migration failed', { error: (e as Error).message });
    }
  }

  private traceDirPath(): string {
    return path.join(this.d.root, TRACE_DIR);
  }

  /** 正文追踪开着时的追踪目录；关着返回 undefined（网关配置里就不带 traceDir） */
  traceDir(): string | undefined {
    return this.d.traceOn() ? this.traceDirPath() : undefined;
  }

  /** 诊断日志开关变了：清理过期追踪 */
  traceStateChanged(): void {
    this.prune();
  }

  /** 删除超过 24 小时的追踪文件 */
  prune(): number {
    return pruneTraces(this.traceDirPath(), (this.d.now ?? Date.now)());
  }

  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}

/** 旧版「调试模式」开关（userData/gateway/observe.json）：诊断日志开关首次启动时据此迁移 */
export function readLegacyGatewayTrace(root: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, OBSERVE_FILE), 'utf8'));
    return (raw as { trace?: unknown })?.trace === true;
  } catch {
    return false;
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
