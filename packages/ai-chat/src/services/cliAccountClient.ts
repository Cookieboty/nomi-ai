import type { BuiltinCliId } from '@nomi-ai/cli-catalog';

import { api, hasTransport } from './api';
/**
 * 编程助手官方账号（主进程 AccountService / AccountLogin，见 docs/development/coding-agents.md）：
 * 一个账号 = 一个 CLI 配置目录，登录由 CLI 自己完成。这里只有账号身份（邮箱 / 套餐），Nomi 不保存凭据。
 */
/** 有官方账号的编程助手（dsh 没有官方账号） */
/** 有官方账号的编程助手（清单 officialAccount）：dsh 与 Gemini 没有 */
export type AccountKind = Exclude<BuiltinCliId, 'dsh' | 'gemini'>;

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
  /** network-blocked：官方服务以 403 拒绝了这个网络（地区不受支持 / 代理没生效） */
  hint?: 'network-blocked';
  /** 出错时「沿用终端代理」开关的值 */
  useShellProxy?: boolean;
  /** 终端里检测到的代理地址（已去掉账号密码） */
  shellProxy?: string;
}

/** 编程助手是否沿用终端（如 ~/.zshrc）里的代理变量 */
export interface CliNetworkState {
  useShellProxy: boolean;
  shellProxy: string | null;
}

/** 契约的账号错误码 → 原来的 kebab code（调用方按 `e.code === 'unknown-live'` 走控制流） */
const ACCOUNT_CODES: Record<string, string> = {
  ACCOUNT_NOT_FOUND: 'not-found',
  ACCOUNT_IN_USE: 'in-use',
  ACCOUNT_LOCAL: 'local',
  ACCOUNT_UNSUPPORTED: 'unsupported',
  ACCOUNT_UNKNOWN_LIVE: 'unknown-live',
  ACCOUNT_EXTERNAL_BUSY: 'external-busy',
};

async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport()) throw new Error('desktop app connection unavailable');
  try {
    return (await run()) as T;
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const code = ACCOUNT_CODES[String((e as { code?: unknown }).code)];
    throw Object.assign(new Error(e.message), code ? { code } : {});
  }
}

const on = (subscribe: () => () => void): (() => void) =>
  hasTransport() ? subscribe() : () => undefined;

export const cliAccountClient = {
  list: async (kind?: AccountKind) => {
    const r = await call<unknown>(() => api.cliAccount.list({ kind }));
    return Array.isArray(r) ? (r as CliAccount[]) : [];
  },
  /** 用 CLI 自己的状态命令重新读各账号的身份（不读凭据） */
  refresh: async (kind: AccountKind) => {
    const r = await call<unknown>(() => api.cliAccount.refresh({ kind }));
    return Array.isArray(r) ? (r as CliAccount[]) : [];
  },
  /** 设为默认账号：新标签与「跟随默认」的标签用它 */
  setDefault: (kind: AccountKind, id: string) =>
    call<CliAccount>(() => api.cliAccount.setDefault({ kind, id })),
  rename: (id: string, label: string) =>
    call<CliAccount>(() => api.cliAccount.rename({ id, label })),
  /** stopExternal：先结束 Nomi 之外还在用这个账号的 CLI 进程（external-busy 时用户确认过）再删除 */
  remove: (id: string, opts?: { force?: boolean; stopExternal?: boolean }) =>
    call<void>(() =>
      api.cliAccount.remove({
        id,
        force: opts?.force === true,
        ...(opts?.stopExternal ? { stopExternal: true } : {}),
      }),
    ),
  /** accountId 为空：新建账号并登录；否则在这个账号的目录里（重新）登录 */
  loginStart: (kind: AccountKind, accountId?: string) =>
    call<LoginEvent>(() => api.cliAccount.loginStart({ kind, accountId })),
  loginInput: (id: string, text: string) =>
    call<boolean>(() => api.cliAccount.loginInput({ id, text })),
  loginCancel: (id: string) => call<boolean>(() => api.cliAccount.loginCancel({ id })),
  /** 只能打开官方登录页（主进程校验） */
  openUrl: (url: string) => call<boolean>(() => api.cliAccount.openUrl({ url })),
  network: () => call<CliNetworkState>(() => api.cliAccount.networkGet()),
  setNetwork: (useShellProxy: boolean) =>
    call<CliNetworkState>(() => api.cliAccount.networkSet({ useShellProxy })),
  onChanged: (fn: () => void) => on(() => api.on('cliAccount.changed', () => fn())),
  onLogin: (fn: (e: LoginEvent) => void) =>
    on(() => api.on('cliAccount.login', (p) => fn(p as unknown as LoginEvent))),
};
