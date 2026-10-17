/**
 * Codex 额度：用户点「刷新」且会话日志里的额度缺失 / 过期时，拉起官方 `codex app-server`，
 * 通过官方 JSON-RPC `account/rateLimits/read` 读取。登录凭据始终留在 Codex 自己手里，
 * Nomi 不读 auth.json、不调用 chatgpt.com 的未文档接口、不经手任何 token。
 *
 * 握手（已用 codex-cli 0.162.1 实测，与 openai/codex 的 app-server 协议、CodexBar 一致）：
 *   → {"id":1,"method":"initialize","params":{"clientInfo":{"name":…,"version":…}}}
 *   ← {"id":1,"result":{…}}
 *   → {"method":"initialized"}
 *   → {"id":2,"method":"account/rateLimits/read"}
 *   ← （期间可能夹着通知，没有 id 的一律忽略）{"id":2,"result":{"rateLimits":{primary,secondary,planType,…},…}}
 * 未登录 / API Key 账号会得到 error -32600 "… authentication required to read rate limits"。
 *
 * 受限：`codex -s read-only -a never app-server`，不开 thread、不发对话；cwd 为空临时目录；
 * 每一行 stdout 最多 256KB、总量 256KB；超时 20 秒；stderr 丢弃；读完就关 stdin 并终止进程。
 * 隐私：响应里的邮箱 / 账号 id 只进 sha256 指纹（换号检测），其余字段一概丢弃，不记录原始输出。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCliBinAsync, withCliPath } from '../cli/detect';

import { STDOUT_LIMIT, killTree, windowsShimLaunch } from './limitedProcess';
import type { QuotaReading, QuotaWindow } from './quota';
import type { FetchOutcome } from './quotaCache';
import { fingerprint } from './quotaIdentity';

export const CODEX_APP_SERVER_ARGS = [
  '-s',
  'read-only',
  '-a',
  'never',
  '-c',
  'analytics.enabled=false',
  'app-server',
];
export const CODEX_RPC_TIMEOUT_MS = 20_000;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** 把 account/rateLimits/read 的响应映射成额度读数；只取百分比 / 窗口 / 重置时间 / 套餐 */
export function mapCodexRateLimits(
  result: unknown,
  now: number,
  salt: string,
): { reading: QuotaReading; identity: string | null } | null {
  const r = rec(result);
  if (!r) return null;
  // 优先 codex 这个计量桶，其次历史单桶字段
  const byId = rec(r.rateLimitsByLimitId);
  const snap = rec(byId?.codex) ?? rec(r.rateLimits);
  if (!snap) return null;
  const windows: QuotaWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const w = rec(snap[id]);
    const used = num(w?.usedPercent);
    if (!w || used === undefined || used < 0) continue;
    const mins = num(w.windowDurationMins);
    const at = num(w.resetsAt);
    windows.push({
      id,
      usedPercent: Math.min(100, used),
      ...(mins && mins > 0 ? { windowMinutes: mins } : {}),
      // 官方是 Unix 秒
      ...(at && at > 0 ? { resetAt: at < 1e11 ? at * 1000 : at } : {}),
    });
  }
  if (!windows.length) return null;
  const planRaw = typeof snap.planType === 'string' ? snap.planType : undefined;
  const plan = planRaw && planRaw !== 'unknown' ? (PLAN_LABEL[planRaw] ?? planRaw) : undefined;
  const accountId = typeof r.accountId === 'string' ? r.accountId : null;
  return {
    reading: { windows, updatedAt: now, origin: 'app-server', ...(plan ? { plan } : {}) },
    identity: fingerprint(salt, [accountId]),
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: RpcError) => void };
class RpcError extends Error {
  constructor(
    readonly kind: 'rpc' | 'timeout' | 'output-limit' | 'closed' | 'spawn',
    readonly code?: number,
    readonly rpcMessage = '',
  ) {
    super(kind);
  }
}

/** JSON-RPC 的 error.message 里「需要登录」的线索（只在内存里匹配，不记录） */
export function isCodexAuthError(code: number | undefined, message: string): boolean {
  const m = message.toLowerCase();
  return (
    /authentication required/.test(m) ||
    /not logged in|log in|sign in|signed in|unauthorized/.test(m) ||
    code === 401
  );
}

export interface CodexRpcDeps {
  resolveBin?: () => Promise<string | null>;
  /** 测试注入：自己造子进程 */
  spawnFn?: typeof spawn;
  env?: () => NodeJS.ProcessEnv;
  tmpRoot?: string;
  now?: () => number;
  timeoutMs?: number;
  salt: () => string;
  platform?: NodeJS.Platform;
  clientVersion?: string;
}

export class CodexRateLimitReader {
  constructor(private readonly d: CodexRpcDeps) {}

  async fetch(): Promise<FetchOutcome> {
    const bin = await (this.d.resolveBin ?? (() => resolveCliBinAsync('codex')))().catch(
      () => null,
    );
    if (!bin) return { kind: 'transient', reason: 'not-installed' };
    const dir = fs.mkdtempSync(path.join(this.d.tmpRoot ?? os.tmpdir(), 'nomi-codex-usage-'));
    let child: ChildProcess | null = null;
    try {
      const env = (this.d.env ?? withCliPath)();
      const platform = this.d.platform ?? process.platform;
      let file = bin;
      let args = CODEX_APP_SERVER_ARGS;
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
        const l = windowsShimLaunch(bin, args, env);
        if (!l) return { kind: 'transient', reason: 'spawn-failed' };
        file = l.file;
        args = l.args;
      }
      const sp = this.d.spawnFn ?? spawn;
      try {
        child = sp(file, args, {
          cwd: dir,
          env,
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          windowsVerbatimArguments: file !== bin,
        });
      } catch (e) {
        return {
          kind: 'transient',
          reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'spawn-failed',
        };
      }
      const result = await this.session(child);
      const mapped = mapCodexRateLimits(
        result,
        this.d.now ? this.d.now() : Date.now(),
        this.d.salt(),
      );
      if (!mapped) return { kind: 'transient', reason: 'no-limits' };
      return { kind: 'ok', reading: mapped.reading, identity: mapped.identity };
    } catch (e) {
      if (e instanceof RpcError) {
        if (e.kind === 'timeout') return { kind: 'transient', reason: 'timeout' };
        if (e.kind === 'output-limit') return { kind: 'transient', reason: 'output-limit' };
        if (e.kind === 'spawn')
          return { kind: 'transient', reason: e.code === -2 ? 'not-installed' : 'spawn-failed' };
        if (e.kind === 'rpc') {
          if (isCodexAuthError(e.code, e.rpcMessage)) {
            // API Key 账号的提示是「chatgpt authentication required …」
            return {
              kind: 'auth',
              reason: /chatgpt/i.test(e.rpcMessage) ? 'api-account' : 'not-signed-in',
            };
          }
          return { kind: 'transient', reason: 'bad-output' };
        }
      }
      return { kind: 'transient', reason: 'spawn-failed' };
    } finally {
      if (child) {
        try {
          child.stdin?.end();
        } catch {
          /* 已关闭 */
        }
        killTree(child, 500);
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 握手 + 读额度；返回 account/rateLimits/read 的 result（原始，由调用方只取白名单字段） */
  private session(child: ChildProcess): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const pending = new Map<number, Pending>();
      let buf = '';
      let total = 0;
      let done = false;
      const fail = (e: RpcError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const p of pending.values()) p.reject(e);
        reject(e);
      };
      const timer = setTimeout(
        () => fail(new RpcError('timeout')),
        this.d.timeoutMs ?? CODEX_RPC_TIMEOUT_MS,
      );
      const send = (o: Record<string, unknown>) => {
        child.stdin?.write(`${JSON.stringify(o)}\n`);
      };
      const request = (id: number, method: string, params?: unknown) =>
        new Promise<unknown>((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          send({ id, method, ...(params === undefined ? {} : { params }) });
        });
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let m: Record<string, unknown> | undefined;
        try {
          m = rec(JSON.parse(line));
        } catch {
          return; // 非 JSON 行（日志）直接忽略，不记录
        }
        const id = m && typeof m.id === 'number' ? m.id : undefined;
        if (id === undefined || !m) return; // 通知 / 服务端请求：全部忽略
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        const err = rec(m.error);
        if (err)
          p.reject(
            new RpcError(
              'rpc',
              num(err.code),
              typeof err.message === 'string' ? err.message.slice(0, 300) : '',
            ),
          );
        else p.resolve(m.result);
      };
      child.once('error', (e) =>
        fail(
          new RpcError('spawn', (e as NodeJS.ErrnoException).code === 'ENOENT' ? -2 : undefined),
        ),
      );
      child.once('close', () => fail(new RpcError('closed')));
      child.stdin?.on('error', () => fail(new RpcError('closed')));
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (c: string | Buffer) => {
        const s = typeof c === 'string' ? c : c.toString('utf8');
        total += s.length;
        buf += s;
        if (total > STDOUT_LIMIT || buf.length > STDOUT_LIMIT)
          return fail(new RpcError('output-limit'));
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      (async () => {
        await request(1, 'initialize', {
          clientInfo: {
            name: 'nomi_usage',
            title: 'Nomi',
            version: this.d.clientVersion ?? '1.0.0',
          },
        });
        send({ method: 'initialized' });
        const r = await request(2, 'account/rateLimits/read');
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(r);
        }
      })().catch((e: unknown) => fail(e instanceof RpcError ? e : new RpcError('closed')));
    });
  }
}
