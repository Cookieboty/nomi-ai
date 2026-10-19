/** 编程助手官方账号（docs/design/cli-official-accounts.md） */

export type AccountKind = 'claude' | 'codex' | 'grok' | 'gemini';

export const ACCOUNT_KINDS: readonly AccountKind[] = ['claude', 'codex', 'grok', 'gemini'];

/** 账号身份（只放可展示的非敏感信息） */
export interface AccountIdentity {
  /** 稳定键：同一账号多次登录得到同一个值（accountUuid / sub / email…） */
  key: string;
  email?: string;
  /** 套餐（pro / max / plus…） */
  plan?: string;
  /** 组织 / 工作区 */
  org?: string;
}

/**
 * 某一时刻的凭据：逻辑名 → 文件内容（Claude：credentials / oauthAccount；Codex、Grok：auth.json；
 * Gemini：oauth_creds.json / google_accounts.json）。只在主进程内存里出现，落盘一律加密。
 */
export type CredFiles = Record<string, string>;

export interface LiveCreds {
  files: CredFiles;
  identity: AccountIdentity | null;
  /** 越大越新（过期时间 / 最近刷新时间 / 文件修改时间）；判断不了为 null */
  freshness: number | null;
}

export interface AccountView {
  id: string;
  kind: AccountKind;
  label: string;
  identity: AccountIdentity | null;
  active: boolean;
  createdAt: number;
  lastUsedAt?: number;
}
