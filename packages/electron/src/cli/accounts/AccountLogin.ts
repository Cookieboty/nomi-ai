/**
 * 官方账号登录（docs/design/cli-official-accounts.md §4）：在暂存目录里跑 CLI 自己的登录命令，
 * 把输出里的授权链接 / 设备码 / 「粘贴授权码」提示转成界面事件；成功后从暂存目录读出凭据存进保险箱，
 * 再删除暂存目录（macOS 上一并删除暂存用的钥匙串条目）。用户现有的全局登录全程不受影响。
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
import { adapterFor, claudeAccountName, claudeKeychainService, type AdapterEnv } from './adapters';
import { macKeychain } from './keychain';
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

const LOGIN_ARGS: Record<AccountKind, { env: string; args: string[] }> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', args: ['auth', 'login', '--claudeai'] },
  codex: {
    env: 'CODEX_HOME',
    args: ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'],
  },
  grok: { env: 'GROK_HOME', args: ['login', '--device-auth'] },
  // Gemini 没有 login 子命令：起 ACP 进程后调用 authenticate（oauth-personal），由 CLI 自己开浏览器
  gemini: { env: 'GEMINI_CLI_HOME', args: ['--acp'] },
};

interface Session {
  id: string;
  kind: AccountKind;
  dir: string;
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
  /** 还没删完的暂存目录（退出时等它们删完） */
  private readonly pendingCleanup = new Set<Promise<void>>();

  constructor(
    private readonly d: {
      root: string;
      accounts: AccountService;
      adapterEnv?: AdapterEnv;
      emit: (e: LoginEvent) => void;
      logger: { warn(m: string, d?: unknown): void };
      /** 登录超时（测试用；默认 15 分钟） */
      timeoutMs?: number;
    },
  ) {
    // 上次异常退出（崩溃 / 强杀）留下的暂存目录里可能有明文凭据：启动时清掉
    this.sweepStaleStaging();
  }

  private get stagingRoot() {
    return path.join(this.d.root, 'staging');
  }

  private sweepStaleStaging() {
    let names: string[];
    try {
      names = fs.readdirSync(this.stagingRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (this.sessions.has(name)) continue;
      this.track(this.removeStaging('claude', path.join(this.stagingRoot, name)));
    }
  }

  private track(p: Promise<void>) {
    this.pendingCleanup.add(p);
    void p.finally(() => this.pendingCleanup.delete(p));
  }

  private send(s: Session, e: Omit<LoginEvent, 'id' | 'kind'>) {
    s.last = { id: s.id, kind: s.kind, ...e };
    this.d.emit(s.last);
  }

  start(kind: AccountKind): LoginEvent {
    const bin = resolveHarnessBin(kind);
    if (!bin) throw new Error(t('未找到 {0}，请先安装', kind));
    const id = randomUUID();
    const dir = path.join(this.stagingRoot, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir 的 mode 受 umask 影响，且 staging 可能是旧版本建的：显式收紧
    fs.chmodSync(this.stagingRoot, 0o700);
    fs.chmodSync(dir, 0o700);
    const spec = LOGIN_ARGS[kind];
    const script = bin.endsWith('.mjs') || bin.endsWith('.js');
    const env = buildCliEnv(process.env, {
      [spec.env]: dir,
      // Gemini：只信任这个空的暂存目录（也是这次登录的 GEMINI_CLI_HOME，cwd 必须是它），不是用户工作区
      ...(kind === 'gemini' ? geminiLoginEnv(dir) : {}),
      ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    });
    const launch = resolveHarnessLaunch(
      script ? process.execPath : bin,
      script ? [bin, ...spec.args] : spec.args,
      env,
    );
    const child = spawn(launch.file, launch.args, {
      cwd: dir,
      env: launch.env,
      windowsHide: true,
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    child.stdin.on('error', () => {});
    const s: Session = {
      id,
      kind,
      dir,
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

  /** 从暂存目录读出这次登录的凭据存进保险箱 */
  private async collect(s: Session) {
    // 暂存目录就是这次登录的 CLI 配置目录：用同一个适配器从那里读凭据
    const env = {
      ...(this.d.adapterEnv?.env ?? process.env),
      [LOGIN_ARGS[s.kind].env]: s.dir,
    };
    tightenTree(s.dir);
    const live = await adapterFor(s.kind, { ...this.d.adapterEnv, env }).read();
    // 读凭据期间用户取消了 / 超时了：不能再入库
    if (s.finished) return;
    if (!live) throw new Error(t('登录完成了，但没有读到凭据'));
    // 从这里起就要入库了：先标记结束，之后的取消不再生效（返回 false）
    s.finished = true;
    try {
      const account = await this.d.accounts.addFromLogin(s.kind, live);
      this.send(s, { state: 'done', account });
    } catch (e) {
      this.send(s, { state: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.cleanup(s);
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
    this.cleanup(s);
    return true;
  }

  private fail(s: Session, message: string) {
    if (s.finished) return;
    s.finished = true;
    killProcessTree(s.child);
    this.send(s, { state: 'error', message });
    this.cleanup(s);
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

  /** 结束一次登录：立刻同步删掉暂存目录；进程退出后再删一次（被杀的 CLI 可能还在落盘） */
  private cleanup(s: Session) {
    clearTimeout(s.timer);
    this.sessions.delete(s.id);
    this.track(this.removeStaging(s.kind, s.dir));
    if (s.child.exitCode === null && s.child.signalCode === null)
      s.child.once('close', () => this.track(this.removeStaging(s.kind, s.dir)));
  }

  private async removeStaging(kind: AccountKind, dir: string) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      this.d.logger.warn('login staging cleanup failed', String(e));
    }
    // macOS：Claude 把暂存登录写进了按目录区分的钥匙串条目，一并删除（启动清扫时不知道类型，按 Claude 试删）
    const platform = this.d.adapterEnv?.platform ?? process.platform;
    if (kind === 'claude' && platform === 'darwin') {
      const keychain = this.d.adapterEnv?.keychain ?? macKeychain;
      const env = this.d.adapterEnv?.env ?? process.env;
      await keychain
        .remove(claudeKeychainService({ CLAUDE_CONFIG_DIR: dir }, dir), claudeAccountName(env))
        .catch(() => undefined);
    }
  }

  /** 退出：取消所有进行中的登录（不入库），并等暂存目录与钥匙串条目删完 */
  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
    await Promise.allSettled([...this.pendingCleanup]);
  }

  registerIpc(): void {
    const owner = 'AccountLogin';
    guardedHandle('ai:cli-account:login-start', (k) => this.start(String(k) as AccountKind), {
      owner,
    });
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
