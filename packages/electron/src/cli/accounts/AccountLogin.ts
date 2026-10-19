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

const LOGIN_ARGS: Record<Exclude<AccountKind, 'gemini'>, { env: string; args: string[] }> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', args: ['auth', 'login', '--claudeai'] },
  codex: {
    env: 'CODEX_HOME',
    args: ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'],
  },
  grok: { env: 'GROK_HOME', args: ['login', '--device-auth'] },
};

interface Session {
  id: string;
  kind: AccountKind;
  dir: string;
  child: ChildProcessWithoutNullStreams;
  out: string;
  last: LoginEvent;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
}

export class AccountLogin {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly d: {
      root: string;
      accounts: AccountService;
      adapterEnv?: AdapterEnv;
      emit: (e: LoginEvent) => void;
      logger: { warn(m: string, d?: unknown): void };
    },
  ) {}

  private send(s: Session, e: Omit<LoginEvent, 'id' | 'kind'>) {
    s.last = { id: s.id, kind: s.kind, ...e };
    this.d.emit(s.last);
  }

  start(kind: AccountKind): LoginEvent {
    if (kind === 'gemini') throw new Error(t('Gemini 的登录随 Gemini 后端一起提供'));
    const bin = resolveHarnessBin(kind);
    if (!bin) throw new Error(t('未找到 {0}，请先安装', kind));
    const id = randomUUID();
    const dir = path.join(this.d.root, 'staging', id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const spec = LOGIN_ARGS[kind];
    const script = bin.endsWith('.mjs') || bin.endsWith('.js');
    const env = buildCliEnv(process.env, {
      [spec.env]: dir,
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
      timer: setTimeout(() => this.fail(s, t('登录超时，请重试')), LOGIN_TIMEOUT_MS),
      finished: false,
    };
    (s.timer as { unref?: () => void }).unref?.();
    this.sessions.set(id, s);
    const onData = (c: Buffer) => {
      s.out = (s.out + c.toString('utf8')).slice(-64 * 1024);
      const p = parseLoginOutput(s.out);
      if (s.last.state === 'verifying') return;
      if (p.url || p.code || p.needsCode)
        this.send(s, { state: 'waiting', ...p, needsCode: p.needsCode });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => this.fail(s, e.message));
    child.on('close', (code) => void this.onExit(s, code));
    this.d.emit(s.last);
    return s.last;
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
    void this.cleanup(s);
    return true;
  }

  private fail(s: Session, message: string) {
    if (s.finished) return;
    s.finished = true;
    killProcessTree(s.child);
    this.send(s, { state: 'error', message });
    void this.cleanup(s);
  }

  private async onExit(s: Session, code: number | null) {
    if (s.finished) return;
    if (code !== 0) {
      const tail = stripTerminal(s.out).trim().split('\n').slice(-3).join('\n');
      return this.fail(s, tail || t('登录没有完成（退出码 {0}）', String(code)));
    }
    try {
      // 暂存目录就是这次登录的 CLI 配置目录：用同一个适配器从那里读凭据
      const env = {
        ...(this.d.adapterEnv?.env ?? process.env),
        [LOGIN_ARGS[s.kind as 'claude'].env]: s.dir,
      };
      const live = await adapterFor(s.kind, { ...this.d.adapterEnv, env }).read();
      if (!live) throw new Error(t('登录完成了，但没有读到凭据'));
      const account = await this.d.accounts.addFromLogin(s.kind, live);
      s.finished = true;
      this.send(s, { state: 'done', account });
    } catch (e) {
      this.fail(s, e instanceof Error ? e.message : String(e));
      return;
    }
    await this.cleanup(s);
  }

  private async cleanup(s: Session) {
    clearTimeout(s.timer);
    this.sessions.delete(s.id);
    // macOS：Claude 把暂存登录写进了按目录区分的钥匙串条目，一并删除
    const platform = this.d.adapterEnv?.platform ?? process.platform;
    if (s.kind === 'claude' && platform === 'darwin') {
      const keychain = this.d.adapterEnv?.keychain ?? macKeychain;
      const env = this.d.adapterEnv?.env ?? process.env;
      await keychain
        .remove(claudeKeychainService({ CLAUDE_CONFIG_DIR: s.dir }, s.dir), claudeAccountName(env))
        .catch(() => undefined);
    }
    fs.rm(s.dir, { recursive: true, force: true }, () => undefined);
  }

  dispose() {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
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
