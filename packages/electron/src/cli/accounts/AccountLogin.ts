/**
 * 官方账号登录（docs/design/cli-plugin-architecture.md §5.10）：在账号目录里跑 CLI 自己的登录命令
 * （登录必须走官方自己的流程），把输出里的授权链接 / 设备码 / 「粘贴授权码」提示转成界面事件。
 * 凭据由 CLI 自己写进账号目录（或按目录区分的钥匙串条目），Nomi 不读取、不保存（S7）；
 * 登录完成后只读身份（邮箱 / 套餐）。新建账号的登录被取消或失败时，删掉这个空账号。
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, shell } from 'electron';

import { t } from '../../i18n';
import { guardedHandle } from '../../security/guardedIpc';
import { buildCliEnv } from '../cliEnv';
import { resolveHarnessBin } from '../CliHarnessService';
import { resolveHarnessLaunch } from '../cliLaunch';
import { AcpConnection } from '../gemini/acp';
import { geminiLoginEnv } from '../gemini/trust';
import { killProcessTree } from '../processTree';

import type { AccountService } from './AccountService';
import { loginArgs } from './homes';
import type { AccountKind, AccountView } from './types';

export type LoginState = 'starting' | 'waiting' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface LoginEvent {
  id: string;
  kind: AccountKind;
  state: LoginState;
  /** 授权页（只放 https 链接） */
  url?: string;
  /** 设备码（Codex / Grok） */
  code?: string;
  /** CLI 在等用户粘贴授权码（Claude） */
  needsCode?: boolean;
  message?: string;
  account?: AccountView;
}

/** 15 分钟：与 Codex 设备码有效期一致 */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** 去掉 ANSI 颜色与 OSC 8 超链接包装（Claude 的链接是 `ESC]8;;URL BEL text ESC]8;; BEL`） */
export function stripTerminal(s: string): string {
  /* eslint-disable no-control-regex -- 去掉终端转义序列本来就要匹配 ESC / BEL 控制字符 */
  return s
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  /* eslint-enable no-control-regex */
}

/** 从 CLI 输出里取授权链接、设备码、是否在等粘贴授权码（Claude 2.1.303 / Codex 0.163 / Grok 1.0.62 实测格式） */
export function parseLoginOutput(raw: string): { url?: string; code?: string; needsCode: boolean } {
  const text = stripTerminal(raw);
  const url = /https:\/\/[^\s"'<>]+/.exec(text)?.[0];
  const code =
    /one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(text)?.[1] ??
    /Confirm this code[^\n]*\n\s*\n?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(text)?.[1];
  return {
    ...(url ? { url } : {}),
    ...(code ? { code } : {}),
    needsCode: /Paste code here/i.test(text),
  };
}

interface Session {
  id: string;
  kind: AccountKind;
  /** 登录的账号 */
  accountId: string;
  /** 这次登录新建的账号：取消 / 失败时删掉 */
  created: boolean;
  /** 登录用的目录（账号目录；本机登录时为用户目录）作 cwd */
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  out: string;
  last: LoginEvent;
  timer: ReturnType<typeof setTimeout>;
  /** 已结束（成功 / 失败 / 取消 / 超时）：之后不再发事件、不再入库 */
  finished: boolean;
}

/** 暂存目录只给当前用户访问：目录 0700、文件 0600（Windows 上 mode 无效，靠 userData 的用户 ACL） */
export function tightenTree(dir: string): void {
  let entries: fs.Dirent[];
  try {
    fs.chmodSync(dir, 0o700);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tightenTree(p);
    else if (e.isFile()) {
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* 尽力而为 */
      }
    }
  }
}

export class AccountLogin {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly d: {
      accounts: AccountService;
      emit: (e: LoginEvent) => void;
      logger: { warn(m: string, d?: unknown): void };
      /** 登录超时（测试用；默认 15 分钟） */
      timeoutMs?: number;
    },
  ) {}

  private send(s: Session, e: Omit<LoginEvent, 'id' | 'kind'>) {
    s.last = { id: s.id, kind: s.kind, ...e };
    this.d.emit(s.last);
  }

  /**
   * 开始登录。accountId 为空：新建一个账号并登录；否则在这个账号的目录里重新登录
   * （从旧版本迁移来的「需要重新登录」，或本机登录）。
   */
  async start(kind: AccountKind, accountId?: string): Promise<LoginEvent> {
    const bin = resolveHarnessBin(kind);
    if (!bin) throw new Error(t('未找到 {0}，请先安装', kind));
    const created = !accountId;
    const account = accountId ?? this.d.accounts.create(kind).id;
    await this.d.accounts.prepareLogin(account);
    const target = this.d.accounts.loginTarget(account);
    if (target.kind !== kind) throw new Error(t('账号不存在'));
    const id = account;
    if (this.sessions.has(id)) this.cancel(id);
    const cwd = target.dir ?? os.tmpdir();
    // 登录参数在插件里（Gemini 没有 login 子命令：起 ACP 进程后调用 authenticate）
    const args = loginArgs(kind);
    const script = bin.endsWith('.mjs') || bin.endsWith('.js');
    const env = buildCliEnv(target.env, {
      // Gemini：只信任这次登录用的目录，不是用户工作区
      ...(kind === 'gemini' && target.dir ? geminiLoginEnv(target.dir) : {}),
      ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    });
    const launch = resolveHarnessLaunch(
      script ? process.execPath : bin,
      script ? [bin, ...args] : args,
      env,
    );
    const child = spawn(launch.file, launch.args, {
      cwd,
      env: launch.env,
      windowsHide: true,
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    child.stdin.on('error', () => {});
    const s: Session = {
      id,
      kind,
      accountId: account,
      created,
      cwd,
      child,
      out: '',
      last: { id, kind, state: 'starting' },
      timer: setTimeout(
        () => this.fail(s, t('登录超时，请重试')),
        this.d.timeoutMs ?? LOGIN_TIMEOUT_MS,
      ),
      finished: false,
    };
    (s.timer as { unref?: () => void }).unref?.();
    this.sessions.set(id, s);
    const onData = (c: Buffer) => {
      s.out = (s.out + c.toString('utf8')).slice(-64 * 1024);
      // Gemini 的进度走 ACP，stderr 只留作出错时的说明
      if (s.kind === 'gemini') return;
      const p = parseLoginOutput(s.out);
      if (s.last.state === 'verifying') return;
      if (p.url || p.code || p.needsCode)
        this.send(s, { state: 'waiting', ...p, needsCode: p.needsCode });
    };
    if (kind === 'gemini') this.driveGemini(s);
    else child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => this.fail(s, e.message));
    child.on('close', (code) => void this.onExit(s, code));
    this.d.emit(s.last);
    return s.last;
  }

  /**
   * Gemini 0.62 的 ACP authenticate 直接打开浏览器（127.0.0.1 回调，5 分钟超时），
   * 登录链接不输出到 stdout / stderr，所以界面只能提示去浏览器里完成。完成后结束进程并收凭据。
   */
  private driveGemini(s: Session) {
    const conn = new AcpConnection(s.child, {
      onNotification: () => undefined,
      onRequest: async (method) => {
        throw new Error(`unsupported client method ${method}`);
      },
    });
    void (async () => {
      try {
        await conn.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });
        if (s.finished) return;
        this.send(s, {
          state: 'waiting',
          message: t('已在浏览器里打开 Google 登录页，请在那里完成授权（5 分钟内有效）。'),
        });
        // Gemini 自己的浏览器回调 5 分钟超时；多留 1 分钟余量，整体还有 LOGIN_TIMEOUT_MS 兜底
        await conn.request(
          'authenticate',
          { methodId: 'oauth-personal' },
          { timeoutMs: 6 * 60_000 },
        );
        if (s.finished) return;
        this.send(s, { state: 'verifying' });
        await this.collect(s);
      } catch (e) {
        this.fail(s, e instanceof Error ? e.message : String(e));
      } finally {
        if (!s.child.killed && s.child.exitCode === null) killProcessTree(s.child);
      }
    })();
  }

  /** 登录命令成功结束：只读身份（不读凭据），更新账号 */
  private async collect(s: Session) {
    if (s.finished) return;
    s.finished = true;
    try {
      const account = await this.d.accounts.refresh(s.accountId);
      if (!account.loggedIn) throw new Error(t('登录完成了，但 CLI 仍显示未登录'));
      this.send(s, { state: 'done', account });
      this.cleanup(s, false);
    } catch (e) {
      this.send(s, { state: 'error', message: e instanceof Error ? e.message : String(e) });
      this.cleanup(s, true);
    }
  }

  /** 把用户粘贴的授权码写给 CLI（Claude） */
  input(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.finished || !s.child.stdin.writable) return false;
    s.child.stdin.write(`${String(text).trim().slice(0, 2000)}\n`);
    this.send(s, { ...s.last, state: 'verifying', needsCode: false });
    return true;
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.finished) return false;
    s.finished = true;
    killProcessTree(s.child);
    this.send(s, { state: 'cancelled' });
    this.cleanup(s, true);
    return true;
  }

  private fail(s: Session, message: string) {
    if (s.finished) return;
    s.finished = true;
    killProcessTree(s.child);
    this.send(s, { state: 'error', message });
    this.cleanup(s, true);
  }

  private async onExit(s: Session, code: number | null) {
    if (s.finished) return;
    if (s.kind === 'gemini') {
      // ACP 进程只在出错时自己退出；成功路径由 driveGemini 收尾
      if (s.last.state !== 'verifying') return this.fail(s, this.tail(s) || t('登录没有完成'));
      return;
    }
    if (code !== 0) {
      return this.fail(s, this.tail(s) || t('登录没有完成（退出码 {0}）', String(code)));
    }
    try {
      await this.collect(s);
    } catch (e) {
      this.fail(s, e instanceof Error ? e.message : String(e));
    }
  }

  private tail(s: Session) {
    return stripTerminal(s.out).trim().split('\n').slice(-3).join('\n');
  }

  /** 结束一次登录；这次新建的账号没登录成功就删掉（目录里没有凭据，不用登出） */
  private cleanup(s: Session, failed: boolean) {
    clearTimeout(s.timer);
    this.sessions.delete(s.id);
    if (!failed || !s.created) return;
    const drop = () =>
      void this.d.accounts
        // force：这次新建的空账号；子进程已退出。无 lsof / Windows unknown 时仍须清掉，不能留下孤儿目录。
        .remove(s.accountId, { force: true })
        .catch((e) => this.d.logger.warn('login account cleanup failed', String(e)));
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.once('close', drop);
    else drop();
  }

  /** 退出：取消所有进行中的登录 */
  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
  }

  registerIpc(): void {
    const owner = 'AccountLogin';
    guardedHandle(
      'ai:cli-account:login-start',
      (k, accountId) =>
        this.start(String(k) as AccountKind, accountId ? String(accountId) : undefined),
      { owner },
    );
    guardedHandle(
      'ai:cli-account:login-input',
      (id, text) => this.input(String(id), String(text)),
      {
        owner,
      },
    );
    guardedHandle('ai:cli-account:login-cancel', (id) => this.cancel(String(id)), { owner });
    guardedHandle(
      'ai:cli-account:open-url',
      async (u) => {
        if (!isLoginUrl(String(u))) return false;
        await shell.openExternal(String(u));
        return true;
      },
      { owner },
    );
  }
}

/** 只放行官方登录页（https + 已知域名），避免被拿来打开任意链接 */
const LOGIN_HOSTS = [
  'claude.com',
  'claude.ai',
  'anthropic.com',
  'auth.openai.com',
  'accounts.x.ai',
  'auth.x.ai',
  'accounts.google.com',
];
export function isLoginUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      LOGIN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

export function broadcastLogin(e: LoginEvent): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send('ai:cli-account:login', e);
}
