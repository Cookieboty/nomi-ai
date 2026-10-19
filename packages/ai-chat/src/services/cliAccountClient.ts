/**
 * 编程助手官方账号（主进程 AccountService / AccountLogin，见 docs/design/cli-official-accounts.md）。
 * 这里只有账号身份（邮箱 / 套餐），永远拿不到凭据。
 */
export type AccountKind = 'claude' | 'codex' | 'grok' | 'gemini';

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
  active: boolean;
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
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const cliAccountClient = {
  list: async (kind?: AccountKind) => {
    const r = await call<unknown>('list', kind);
    return Array.isArray(r) ? (r as CliAccount[]) : [];
  },
  /** 终端当前登录的身份（全局凭据） */
  live: async (kind: AccountKind) => {
    const r = await call<unknown>('live', kind);
    return r && typeof r === 'object' && typeof (r as AccountIdentity).key === 'string'
      ? (r as AccountIdentity)
      : null;
  },
  importCurrent: (kind: AccountKind) => call<CliAccount>('import-current', kind),
  activate: (id: string) => call<CliAccount>('activate', id),
  rename: (id: string, label: string) => call<CliAccount>('rename', id, label),
  remove: (id: string) => call<void>('remove', id),
  loginStart: (kind: AccountKind) => call<LoginEvent>('login-start', kind),
  loginInput: (id: string, text: string) => call<boolean>('login-input', id, text),
  loginCancel: (id: string) => call<boolean>('login-cancel', id),
  /** 只能打开官方登录页（主进程校验） */
  openUrl: (url: string) => call<boolean>('open-url', url),
  onChanged: (fn: () => void) =>
    bridge()?.on?.('ai:cli-account:changed', () => fn()) ?? (() => undefined),
  onLogin: (fn: (e: LoginEvent) => void) =>
    bridge()?.on?.('ai:cli-account:login', (p) => fn(p as LoginEvent)) ?? (() => undefined),
};
