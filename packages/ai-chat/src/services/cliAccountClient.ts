import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
/**
 * 编程助手官方账号（主进程 AccountService / AccountLogin，见 docs/design/cli-plugin-architecture.md §5.10）：
 * 一个账号 = 一个 CLI 配置目录，登录由 CLI 自己完成。这里只有账号身份（邮箱 / 套餐），Nomi 不保存凭据。
 */
/** 有官方账号的编程助手（dsh 没有官方账号） */
export type AccountKind = Exclude<BuiltinCliId, 'dsh'>;

export interface AccountIdentity {
  key: string;
  email?: string;
  plan?: string;
  org?: string;
}

export interface CliAccount {
  id: string;
  kind: AccountKind;
  label: string;
  identity: AccountIdentity | null;
  /** 默认账号 */
  active: boolean;
  /** 「本机登录」：这台电脑上 CLI 自己的目录 */
  local: boolean;
  loggedIn: boolean;
  /** 从旧版本迁移来、需要重新登录 */
  needsLogin?: boolean;
  /** 正在使用的标签数 */
  inUse: number;
  /** 同一身份也登录在另一个账号里 */
  duplicateOf?: string;
  /** 在终端里用这个账号运行 CLI 的命令 */
  terminalCommand?: string;
  /** 共享软链失败（非阻断；Windows 无特权时常见） */
  problems?: Array<{ entry: string; reason: string }>;
  createdAt: number;
  lastUsedAt?: number;
}

export type LoginState = 'starting' | 'waiting' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface LoginEvent {
  id: string;
  kind: AccountKind;
  state: LoginState;
  url?: string;
  code?: string;
  needsCode?: boolean;
  message?: string;
  account?: CliAccount;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on?: (channel: string, fn: (p: unknown) => void) => () => void;
}

const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error('aiIPC unavailable');
  const r = (await b.invoke(`ai:cli-account:${method}`, ...args)) as T & {
    __error?: { message: string; code?: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error)
    throw Object.assign(
      new Error(r.__error.message),
      r.__error.code ? { code: r.__error.code } : {},
    );
  return r;
}

export const cliAccountClient = {
  list: async (kind?: AccountKind) => {
    const r = await call<unknown>('list', kind);
    return Array.isArray(r) ? (r as CliAccount[]) : [];
  },
  /** 用 CLI 自己的状态命令重新读各账号的身份（不读凭据） */
  refresh: async (kind: AccountKind) => {
    const r = await call<unknown>('refresh', kind);
    return Array.isArray(r) ? (r as CliAccount[]) : [];
  },
  /** 设为默认账号：新标签与「跟随默认」的标签用它 */
  setDefault: (kind: AccountKind, id: string) => call<CliAccount>('set-default', kind, id),
  rename: (id: string, label: string) => call<CliAccount>('rename', id, label),
  remove: (id: string, opts?: { force?: boolean }) =>
    call<void>('remove', id, opts?.force === true),
  /** accountId 为空：新建账号并登录；否则在这个账号的目录里（重新）登录 */
  loginStart: (kind: AccountKind, accountId?: string) =>
    call<LoginEvent>('login-start', kind, accountId),
  loginInput: (id: string, text: string) => call<boolean>('login-input', id, text),
  loginCancel: (id: string) => call<boolean>('login-cancel', id),
  /** 只能打开官方登录页（主进程校验） */
  openUrl: (url: string) => call<boolean>('open-url', url),
  onChanged: (fn: () => void) =>
    bridge()?.on?.('ai:cli-account:changed', () => fn()) ?? (() => undefined),
  onLogin: (fn: (e: LoginEvent) => void) =>
    bridge()?.on?.('ai:cli-account:login', (p) => fn(p as LoginEvent)) ?? (() => undefined),
};
