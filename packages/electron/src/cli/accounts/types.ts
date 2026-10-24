/** 编程助手官方账号（docs/design/cli-plugin-architecture.md §5.10：一个账号 = 一个 CLI 配置目录） */

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

export interface AccountView {
  id: string;
  kind: AccountKind;
  label: string;
  identity: AccountIdentity | null;
  /** 是默认账号（新标签与「跟随默认」的标签用它） */
  active: boolean;
  /** 「本机登录」：用户自己的 CLI 目录 */
  local: boolean;
  loggedIn: boolean;
  /** 从旧版本迁移来、需要重新登录 */
  needsLogin?: boolean;
  /** 正在使用这个账号的标签数 */
  inUse: number;
  /** 同一身份也登录在另一个账号里（两处各自刷新会让其中一处失效） */
  duplicateOf?: string;
  /** 在终端里用这个账号运行 CLI 的命令（本机登录没有） */
  terminalCommand?: string;
  createdAt: number;
  lastUsedAt?: number;
}
