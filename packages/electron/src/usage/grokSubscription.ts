/**
 * Grok 账户额度读取。
 *
 * 官方 Grok CLI 在 ACP 中提供了自己的 `_x.ai/billing` 扩展。这里让 CLI
 * 自己读取登录态，只保留账户周期的百分比、周期时间和套餐名；Nomi 不读
 * auth.json，也不把 billing 原始响应写入日志或磁盘。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCliBinAsync, withCliPath } from '../cli/detect';

import { killTree, STDOUT_LIMIT, resolveCliLaunch } from './limitedProcess';
import type { QuotaReading, QuotaWindow } from './quota';
import type { FetchOutcome } from './quotaCache';

export const GROK_BILLING_ARGS = ['agent', 'stdio'];
export const GROK_BILLING_TIMEOUT_MS = 15_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;

function dateMs(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

/** `_x.ai/billing` response → the small quota shape used by the UI. */
export function parseGrokBilling(raw: unknown, now = Date.now()): QuotaReading | null {
  const root = obj(raw);
  const config = obj(root?.config);
  const period = obj(config?.currentPeriod);
  const usedRaw = config?.creditUsagePercent;
  const used =
    typeof usedRaw === 'number'
      ? usedRaw
      : typeof usedRaw === 'string' && usedRaw.trim()
        ? Number(usedRaw)
        : NaN;
  const usedPercent = Number.isFinite(used) && used >= 0 ? Math.min(100, used) : undefined;
  const start = dateMs(period?.start);
  const end = dateMs(period?.end);
  if (usedPercent === undefined || start === undefined || end === undefined || end <= start)
    return null;
  const type = typeof period?.type === 'string' ? period.type : '';
  const windowMinutes = Math.max(1, Math.round((end - start) / 60_000));
  const window: QuotaWindow = {
    id: type || 'current-period',
    usedPercent,
    windowMinutes,
    resetAt: end,
  };
  const tier = typeof root?.subscription_tier === 'string' ? root.subscription_tier.trim() : '';
  return {
    windows: [window],
    updatedAt: now,
    origin: 'grok-acp',
    ...(tier ? { plan: tier } : {}),
  };
}

export interface GrokBillingDeps {
  resolveBin?: () => Promise<string | null>;
  spawnFn?: typeof spawn;
  env?: () => NodeJS.ProcessEnv;
  tmpRoot?: string;
  now?: () => number;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** One-shot ACP initialize → initialized → billing request. */
export class GrokBillingFetcher {
  private unsupported = false;
  constructor(private readonly d: GrokBillingDeps = {}) {}

  async fetch(): Promise<FetchOutcome> {
    if (this.unsupported) return { kind: 'transient', reason: 'unsupported' };
    const bin = await (this.d.resolveBin ?? (() => resolveCliBinAsync('grok')))().catch(() => null);
    if (!bin) return { kind: 'transient', reason: 'not-installed' };
    const dir = fs.mkdtempSync(path.join(this.d.tmpRoot ?? os.tmpdir(), 'nomi-grok-billing-'));
    const env = (this.d.env ?? withCliPath)();
    const platform = this.d.platform ?? process.platform;
    const launch = resolveCliLaunch(bin, GROK_BILLING_ARGS, env, platform);
    if (!launch) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { kind: 'transient', reason: 'spawn-failed' };
    }
    const file = launch.file;
    const args = launch.args;
    let child: ChildProcess | null = null;
    try {
      child = await new Promise<ChildProcess | null>((resolve) => {
        try {
          resolve(
            (this.d.spawnFn ?? spawn)(file, args, {
              cwd: dir,
              env: { ...env, NO_COLOR: '1' },
              stdio: ['pipe', 'pipe', 'ignore'],
              windowsHide: true,
              windowsVerbatimArguments: launch.via === 'cmd-shim',
            }),
          );
        } catch {
          resolve(null);
        }
      });
      if (!child) return { kind: 'transient', reason: 'spawn-failed' };
      const now = this.d.now ? this.d.now() : Date.now();
      const result = await new Promise<{ raw?: unknown; error?: Obj; timedOut?: boolean }>(
        (resolve) => {
          let settled = false;
          let bytes = 0;
          let buf = '';
          const finish = (v: { raw?: unknown; error?: Obj; timedOut?: boolean }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(v);
          };
          const timer = setTimeout(
            () => finish({ timedOut: true }),
            this.d.timeoutMs ?? GROK_BILLING_TIMEOUT_MS,
          );
          child!.once('error', () => finish({}));
          child!.once('close', () => finish({}));
          child!.stdout?.setEncoding?.('utf8');
          let billingSent = false;
          const send = (message: Obj) => {
            try {
              child!.stdin?.write(`${JSON.stringify(message)}\n`);
            } catch {
              finish({});
            }
          };
          child!.stdout?.on('data', (chunk: string | Buffer) => {
            const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            bytes += Buffer.byteLength(s);
            if (bytes > STDOUT_LIMIT) return finish({});
            buf += s;
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              let message: any;
              try {
                message = JSON.parse(line);
              } catch {
                continue;
              }
              if (message?.id === 1 && message.error && typeof message.error === 'object') {
                finish({ error: message.error });
                return;
              }
              if (message?.id === 1 && message.result && !billingSent) {
                billingSent = true;
                send({ jsonrpc: '2.0', method: 'initialized', params: {} });
                send({ jsonrpc: '2.0', id: 2, method: '_x.ai/billing', params: {} });
              } else if (message?.id === 2) {
                if (message.error && typeof message.error === 'object')
                  finish({ error: message.error });
                else finish({ raw: message.result });
                return;
              }
            }
          });
          send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: 1,
              clientInfo: { name: 'nomi_usage', title: 'Nomi', version: '1.0.0' },
              clientCapabilities: {},
            },
          });
        },
      );
      if (result.timedOut) return { kind: 'transient', reason: 'timeout' };
      if (result.error) {
        if (result.error.code === -32601) {
          this.unsupported = true;
          return { kind: 'transient', reason: 'unsupported' };
        }
        return { kind: 'transient', reason: 'network' };
      }
      const reading = parseGrokBilling(result.raw, now);
      return reading ? { kind: 'ok', reading } : { kind: 'transient', reason: 'no-limits' };
    } catch {
      return { kind: 'transient', reason: 'spawn-failed' };
    } finally {
      if (child) killTree(child, 200);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
