/**
 * 同意级别（纯逻辑）：
 * - read：作用域授权即同意，默认自动
 * - write：默认每次运行首次确认（可“本次运行记住”），可设为每次 / 总是允许
 * - destructive：永远确认，且必须打开详情对话框确认，不能记住、不能设为总是允许
 * - 同一轮对话中已读取过文件内容（“受污染的轮次”）→ 任何写 / 破坏性操作都强制确认，无视“记住”与“总是允许”
 *
 * 权限模式（Nomi 对话的档位，与编程助手同名；没有「完全放开」）叠加在每个工具的策略之上：
 * - plan：只读，写 / 破坏性直接拒绝，不弹确认
 * - manual：写每次都确认，不能记住
 * - acceptEdits（默认）：按每个工具的策略
 * - auto：写默认不确认；用户给某个工具单独设过策略（或工具自带默认策略）时仍按它
 * 上面两条硬规则（破坏性永远确认、受污染轮次的写要确认）在所有档位下都保留。
 */
export type Danger = 'read' | 'write' | 'destructive';
export type Policy = 'always' | 'session' | 'ask';
export type NomiPermissionMode = 'plan' | 'manual' | 'acceptEdits' | 'auto';

export const DEFAULT_POLICY: Record<Danger, Policy> = {
  read: 'always',
  write: 'session',
  destructive: 'ask',
};

/** 个别工具的默认策略（覆盖按危险级别的默认）：剪贴板常有密码等敏感内容 → 每次运行首次读取要确认 */
export const TOOL_DEFAULT_POLICY: Record<string, Policy> = {
  clipboard_read: 'session',
  // 沙箱浏览器：默认每个动作都询问
  browser_open: 'ask',
  browser_read: 'ask',
  browser_click: 'ask',
  browser_type: 'ask',
};

export function sanitizePolicy(danger: Danger, p: unknown): Policy {
  if (p !== 'always' && p !== 'session' && p !== 'ask') return DEFAULT_POLICY[danger];
  if (danger === 'destructive') return 'ask';
  return p;
}

export interface ConsentInput {
  danger: Danger;
  policy?: Policy;
  /** 本次运行已“记住允许” */
  sessionAllowed: boolean;
  /** 本轮已读取过文件内容 */
  tainted: boolean;
  /** Nomi 对话的权限模式；不传 = acceptEdits */
  mode?: NomiPermissionMode;
  /** policy 是用户单独设的 / 工具自带的，而不是按危险级别的默认（auto 档只放开默认的写） */
  explicitPolicy?: boolean;
}

export interface ConsentDecision {
  /** 当前权限模式不允许（plan 下的写 / 破坏性）：直接拒绝，不弹确认 */
  blocked?: true;
  confirm: boolean;
  /** 必须在详情对话框里确认（气泡里没有“允许”） */
  dialog: boolean;
  /** 可勾选“本次运行记住” */
  rememberable: boolean;
  reason: 'auto' | 'policy' | 'first-use' | 'tainted' | 'destructive' | 'mode';
}

export function decide(i: ConsentInput): ConsentDecision {
  const mode = i.mode ?? 'acceptEdits';
  if (mode === 'plan' && i.danger !== 'read')
    return { blocked: true, confirm: false, dialog: false, rememberable: false, reason: 'mode' };
  let policy = sanitizePolicy(i.danger, i.policy ?? DEFAULT_POLICY[i.danger]);
  if (i.danger === 'write' && mode === 'manual') policy = 'ask';
  if (i.danger === 'write' && mode === 'auto' && !i.explicitPolicy) policy = 'always';
  if (i.danger === 'destructive') {
    return { confirm: true, dialog: true, rememberable: false, reason: 'destructive' };
  }
  if (i.danger === 'write' && i.tainted) {
    return { confirm: true, dialog: false, rememberable: false, reason: 'tainted' };
  }
  if (policy === 'always')
    return { confirm: false, dialog: false, rememberable: false, reason: 'auto' };
  if (policy === 'session' && i.sessionAllowed) {
    return { confirm: false, dialog: false, rememberable: false, reason: 'auto' };
  }
  return {
    confirm: true,
    dialog: false,
    rememberable: policy === 'session',
    reason: policy === 'session' ? 'first-use' : 'policy',
  };
}

/** 本地 provider：localhost / 127.x / ::1 / *.local（如 Ollama）。没有 baseURL 时按云端处理。 */
export function isLocalBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const h = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      h === 'localhost' ||
      h === '::1' ||
      /^127\./.test(h) ||
      h.endsWith('.local') ||
      h === '0.0.0.0'
    );
  } catch {
    return false;
  }
}
