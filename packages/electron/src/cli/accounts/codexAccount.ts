/**
 * Codex 账号身份：`codex login status` 只给出「已登录 / 未登录」，没有邮箱；这里在账号目录里拉起官方
 * `codex app-server`，用官方 JSON-RPC 读身份（与 usage/codexRateLimits.ts 的握手一致，凭据始终留在
 * Codex 自己手里，Nomi 不读 auth.json，S7）。
 *
 * 协议（codex-cli 0.163.0 `codex app-server generate-ts` 实测）：
 *   → initialize → initialized
 *   → {"id":2,"method":"account/read","params":{}}
 *   ← {"account": {"type":"chatgpt","email":…,"planType":…} | {"type":"apiKey"} | {"type":"amazonBedrock",…} | null,
 *      "requiresOpenaiAuth": boolean}
 * account/read 不带账号 id；`account/rateLimits/read` 的结果里有 `accountId`（会向 OpenAI 发一次请求），
 * 所以只在调用方要求时（账号还没记过 id）才读，用来和 Codex 会话里的 creator_account_id 对上。
 *
 * 受限：`-s read-only -a never`，不开 thread；cwd 为空临时目录；stdout 总量 256KB；超时 15 秒；
 * stderr 丢弃；读完关 stdin 并终止进程。只取邮箱 / 套餐 / 账号 id，其余字段丢弃，不记录原始输出。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { killTree, STDOUT_LIMIT, windowsShimLaunch } from '../../usage/limitedProcess';
import { resolveCliBinAsync } from '../detect';

const ARGS = ['-s', 'read-only', '-a', 'never', '-c', 'analytics.enabled=false', 'app-server'];
const TIMEOUT_MS = 15_000;

export interface CodexAccountInfo {
  loggedIn: boolean;
  email?: string;
  plan?: string;
  /** ChatGPT 账号 id（只在 withAccountId 时读取；后端没给就没有） */
  accountId?: string;
  /** 用 API Key 登录（没有订阅身份） */
  apiKey?: boolean;
}

export interface CodexAccountDeps {
  resolveBin?: () => Promise<string | null>;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
  tmpRoot?: string;
  platform?: NodeJS.Platform;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** account/read 的结果 → 身份（只取白名单字段） */
export function mapCodexAccount(result: unknown): CodexAccountInfo | null {
  const r = rec(result);
  if (!r) return null;
  if (r.account === null) return { loggedIn: false };
  const a = rec(r.account);
  if (!a) return null;
  if (a.type === 'chatgpt') {
    const email = str(a.email);
    const plan = str(a.planType);
    return {
      loggedIn: true,
      ...(email ? { email } : {}),
      ...(plan && plan !== 'unknown' ? { plan } : {}),
    };
  }
  if (a.type === 'apiKey') return { loggedIn: true, apiKey: true };
  return { loggedIn: true };
}

/**
 * 在给定环境（账号目录变量已设好）里读一次 Codex 身份。app-server 起不来 / 超时 / 输出看不懂返回 null，
 * 调用方退回 `codex login status`。
 */
export async function readCodexAccount(
  env: NodeJS.ProcessEnv,
  extraArgs: readonly string[],
  opts: { withAccountId: boolean },
  d: CodexAccountDeps = {},
): Promise<CodexAccountInfo | null> {
  const bin = await (d.resolveBin ?? (() => resolveCliBinAsync('codex')))().catch(() => null);
  if (!bin) return null;
  const cwd = fs.mkdtempSync(path.join(d.tmpRoot ?? os.tmpdir(), 'nomi-codex-account-'));
  let child: ChildProcess | null = null;
  try {
    let file = bin;
    let args = [...extraArgs, ...ARGS];
    if ((d.platform ?? process.platform) === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      const l = windowsShimLaunch(bin, args, env);
      if (!l) return null;
      file = l.file;
      args = l.args;
    }
    child = (d.spawnFn ?? spawn)(file, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: file !== bin,
    });
    const rpc = new MiniRpc(child, d.timeoutMs ?? TIMEOUT_MS);
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'nomi_accounts', title: 'Nomi', version: '1.0.0' },
      });
      rpc.notify('initialized');
      const info = mapCodexAccount(await rpc.request('account/read', {}));
      if (!info) return null;
      if (opts.withAccountId && info.loggedIn && !info.apiKey) {
        // 只要 accountId；额度数字在这里丢弃（额度由用量模块自己读）
        const limits = await rpc.request('account/rateLimits/read').catch(() => null);
        const id = str(rec(limits)?.accountId);
        if (id) info.accountId = id;
      }
      return info;
    } finally {
      rpc.close();
    }
  } catch {
    return null;
  } finally {
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        /* 已关闭 */
      }
      killTree(child, 500);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** 按行的 JSON-RPC：只认带 id 的响应，通知与服务端请求一律忽略 */
class MiniRpc {
  private seq = 0;
  private buf = '';
  private total = 0;
  private dead: Error | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly child: ChildProcess,
    timeoutMs: number,
  ) {
    this.timer = setTimeout(() => this.fail(new Error('timeout')), timeoutMs);
    child.once('error', () => this.fail(new Error('spawn')));
    child.once('close', () => this.fail(new Error('closed')));
    child.stdin?.on('error', () => this.fail(new Error('closed')));
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (c: string | Buffer) => {
      const s = typeof c === 'string' ? c : c.toString('utf8');
      this.total += s.length;
      this.buf += s;
      if (this.total > STDOUT_LIMIT) return this.fail(new Error('output-limit'));
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.onLine(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin?.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  notify(method: string): void {
    this.child.stdin?.write(`${JSON.stringify({ method })}\n`);
  }

  close(): void {
    clearTimeout(this.timer);
    this.dead ??= new Error('closed');
  }

  private onLine(line: string) {
    let m: Record<string, unknown> | undefined;
    try {
      m = rec(JSON.parse(line));
    } catch {
      return;
    }
    const id = typeof m?.id === 'number' ? m.id : undefined;
    const p = id === undefined ? undefined : this.pending.get(id);
    if (!m || !p || id === undefined) return;
    this.pending.delete(id);
    if (m.error) p.reject(new Error('rpc'));
    else p.resolve(m.result);
  }

  private fail(e: Error) {
    if (this.dead) return;
    this.dead = e;
    clearTimeout(this.timer);
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
