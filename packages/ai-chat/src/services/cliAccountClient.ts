import type { BuiltinCliId } from '@nomi-ai/cli-catalog';
import { t } from '@nomi-ai/ui';
import { useEffect, useSyncExternalStore } from 'react';

import { api, hasTransport } from './api';
/**
 * Agents 官方账号（主进程 AccountService / AccountLogin，见 docs/development/coding-agents.md）：
 * 一个账号 = 一个 CLI 配置目录，登录由 CLI 自己完成。这里只有账号身份（用户名 / 邮箱 / 套餐），Nomi 不保存凭据。
 */
/** 有官方账号的 agent（dsh 没有官方账号） */
/** 有官方账号的 agent（清单 officialAccount）：dsh 与 Gemini 没有 */
export type AccountKind = Exclude<BuiltinCliId, 'dsh' | 'gemini'>;

export interface AccountIdentity {
  key: string;
  name?: string;
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

/** agent 是否沿用终端（如 ~/.zshrc）里的代理变量 */
export interface CliNetworkState {
  useShellProxy: boolean;
  shellProxy: string | null;
}

/** 契约的账号错误码 → 原来的 kebab code（调用方按 `e.code === 'unknown-live'` 走控制流） */
const ACCOUNT_CODES: Record<string, string> = {
  ACCOUNT_NOT_FOUND: 'not-found',
  ACCOUNT_IN_USE: 'in-use',
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

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map();
let labelCache: ReadonlyMap<string, string> = EMPTY_LABELS;
const labelListeners = new Set<() => void>();
const cacheResetListeners = new Set<() => void>();
let labelPreheated = false;

export type AccountDisplayFields = Pick<CliAccount, 'label'> & {
  identity?: AccountIdentity | null;
};

/** 账号标题仍是系统默认的「官方账号」占位词（中英文）或为空时返回 true */
export function isDefaultAccountLabel(label: string | null | undefined): boolean {
  const trimmed = label?.trim() ?? '';
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    trimmed === t('ui.chat-settings.official-accounts') ||
    trimmed === '\u5b98\u65b9\u8d26\u53f7' ||
    lower === 'official account' ||
    lower === 'official accounts'
  );
}

/** 优先展示用户自定义名称；若仍为默认「官方账号」且拿到了用户名/邮箱，则回退展示用户名或邮箱 */
export function accountDisplayLabel(acc: AccountDisplayFields | null | undefined): string {
  if (!acc) return '';
  const trimmed = acc.label.trim();
  if (!isDefaultAccountLabel(trimmed)) return trimmed;
  return acc.identity?.name?.trim() || acc.identity?.email?.trim() || trimmed;
}

/** 组合账号卡片副标题，并对已作主标题展示的字段去重 */
export function accountSubtitle(
  acc: AccountDisplayFields | null | undefined,
  opts?: { includePlan?: boolean },
): string {
  if (!acc) return '';
  const primary = accountDisplayLabel(acc).toLowerCase();
  const seen = new Set<string>();
  const parts: string[] = [];
  const rawParts = [
    opts?.includePlan !== false ? acc.identity?.plan : undefined,
    acc.identity?.name,
    acc.identity?.email,
    acc.identity?.org,
  ];
  for (const raw of rawParts) {
    const val = raw?.trim();
    if (!val) continue;
    const key = val.toLowerCase();
    if (key === primary || seen.has(key)) continue;
    seen.add(key);
    parts.push(val);
  }
  return parts.join(' · ');
}

function notifyLabelListeners() {
  labelListeners.forEach((fn) => fn());
}

function recordAccountLabels(
  accounts: readonly (Pick<CliAccount, 'id' | 'label'> & { identity?: AccountIdentity | null })[],
) {
  if (!accounts.length) return;
  let next: Map<string, string> | null = null;
  for (const acc of accounts) {
    const display = accountDisplayLabel(acc);
    if (!acc?.id || !display) continue;
    if (labelCache.get(acc.id) === display) continue;
    next ??= new Map(labelCache);
    next.set(acc.id, display);
  }
  if (next) {
    labelCache = next;
    notifyLabelListeners();
  }
}

function dropAccountLabel(id: string) {
  if (!labelCache.has(id)) return;
  const next = new Map(labelCache);
  next.delete(id);
  labelCache = next;
  notifyLabelListeners();
}

export function cachedAccountLabel(id: string | null | undefined): string | undefined {
  return id ? labelCache.get(id) : undefined;
}

export function onAccountCacheReset(fn: () => void): () => void {
  cacheResetListeners.add(fn);
  return () => {
    cacheResetListeners.delete(fn);
  };
}

export function resetAccountLabelCache(): void {
  labelCache = EMPTY_LABELS;
  labelPreheated = false;
  cacheResetListeners.forEach((fn) => fn());
}

export function useAccountLabels(): ReadonlyMap<string, string> {
  const labels = useSyncExternalStore(
    (fn) => {
      labelListeners.add(fn);
      return () => {
        labelListeners.delete(fn);
      };
    },
    () => labelCache,
  );
  useEffect(() => {
    if (!hasTransport()) return;
    if (!labelPreheated) {
      labelPreheated = true;
      void cliAccountClient.list().catch(() => {
        labelPreheated = false;
      });
    }
    return cliAccountClient.onChanged(() => {
      void cliAccountClient.list().catch(() => undefined);
    });
  }, []);
  return labels;
}

export const cliAccountClient = {
  list: async (kind?: AccountKind) => {
    const r = await call<unknown>(() => api.cliAccount.list({ kind }));
    const list = Array.isArray(r) ? (r as CliAccount[]) : [];
    recordAccountLabels(list);
    return list;
  },
  /** 用 CLI 自己的状态命令重新读各账号的身份（不读凭据） */
  refresh: async (kind: AccountKind) => {
    const r = await call<unknown>(() => api.cliAccount.refresh({ kind }));
    const list = Array.isArray(r) ? (r as CliAccount[]) : [];
    recordAccountLabels(list);
    return list;
  },
  /** 设为默认账号：新标签与默认未指定账号的会话用它 */
  setDefault: async (kind: AccountKind, id: string) => {
    const acc = await call<CliAccount>(() => api.cliAccount.setDefault({ kind, id }));
    if (acc) recordAccountLabels([acc]);
    return acc;
  },
  rename: async (id: string, label: string) => {
    const acc = await call<CliAccount>(() => api.cliAccount.rename({ id, label }));
    if (acc) recordAccountLabels([acc]);
    return acc;
  },
  /** stopExternal：先结束 Nomi 之外还在用这个账号的 CLI 进程（external-busy 时用户确认过）再删除 */
  remove: async (id: string, opts?: { force?: boolean; stopExternal?: boolean }) => {
    await call<void>(() =>
      api.cliAccount.remove({
        id,
        force: opts?.force === true,
        ...(opts?.stopExternal ? { stopExternal: true } : {}),
      }),
    );
    dropAccountLabel(id);
  },
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
