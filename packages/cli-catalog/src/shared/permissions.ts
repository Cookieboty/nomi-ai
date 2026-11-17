/**
 * 权限档位的共用部分（设计与真机查证见 docs/development/coding-agents.md）：
 * Nomi 统一五档；各 CLI 的原生参数 / mode id 在各自插件里，这里只有与 CLI 无关的规则。
 * 纯数据与纯函数，渲染进程也能用。
 */
import type { HarnessPermissionMode } from '../manifest';

export const PERMISSION_MODES: readonly HarnessPermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'bypass',
];

export function isPermissionMode(v: unknown): v is HarnessPermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

/** 不支持时的降级目标：只往更安全的一侧降 */
const FALLBACK: Partial<Record<HarnessPermissionMode, HarnessPermissionMode>> = {
  manual: 'plan',
  auto: 'acceptEdits',
};

/** 在 supported 里实际使用的档位；降级时 degraded = true */
export function degradeMode(
  supported: readonly HarnessPermissionMode[],
  mode: HarnessPermissionMode,
): { mode: HarnessPermissionMode; degraded: boolean } {
  if (supported.includes(mode)) return { mode, degraded: false };
  const next = FALLBACK[mode];
  return { mode: next && supported.includes(next) ? next : 'plan', degraded: true };
}

/**
 * Claude 的 permission-mode 名（Grok 沿用同一套名字）。
 *
 * `auto` = 由 Claude 自己判断哪些动作需要确认，正是 Nomi「自动」档的语义。
 * 它的判定跑在**服务端**：随主请求带 `safeguards` + beta `dangerous-tool-use-*`，结果回到响应的
 * `safeguard_results`。第三方网关只要原样转运就能用——Nomi 自己的网关就是这么做的。
 * 它真正缺不得的是两份状态：`.claude.json` 里的 auto opt-in 标记，以及那条 24 小时有效的
 * 「分类器会计费」确认；缺了 CLI 就判定本 session 跑不了检查（auto_mode_no_check_in_session），
 * 而 `-p` 没人可问，于是每个需要检查的动作硬拒。两份状态由 accounts.EnsureAccountHome 跟着用户配置补齐。
 */
export const CLAUDE_MODE: Record<HarnessPermissionMode, string> = {
  plan: 'plan',
  manual: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  bypass: 'bypassPermissions',
};

/**
 * CLI / ACP 返回的原生安全模式 → Nomi 档位；认不出返回 null（调用方不能猜测并覆盖 CLI 当前状态）。
 * `onRequest`：Codex 的 on-request 是「自动审批」，其它 CLI 的同名值是「逐项确认」。
 */
export function modeFromNative(
  supported: readonly HarnessPermissionMode[],
  raw: unknown,
  o: { onRequest?: HarnessPermissionMode } = {},
): HarnessPermissionMode | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  if (isPermissionMode(value)) return degradeMode(supported, value).mode;
  const lower = value.toLowerCase().replace(/[_\s]+/g, '-');
  let mode: HarnessPermissionMode | null = null;
  if (lower === 'plan' || lower === 'read-only' || lower === 'readonly') mode = 'plan';
  else if (lower === 'default' || lower === 'manual' || lower === 'ask') mode = 'manual';
  else if (lower === 'on-request') mode = o.onRequest ?? 'manual';
  else if (
    lower === 'acceptedits' ||
    lower === 'autoedit' ||
    lower === 'workspace-write' ||
    lower === 'workspacewrite' ||
    lower === 'workspace'
  )
    mode = 'acceptEdits';
  else if (lower === 'auto' || lower === 'dontask' || lower === 'on-request-auto') mode = 'auto';
  else if (
    lower === 'bypass' ||
    lower === 'bypasspermissions' ||
    lower === 'yolo' ||
    lower === 'danger-full-access' ||
    lower === 'dangerfullaccess' ||
    lower === 'danger'
  )
    mode = 'bypass';
  return mode ? degradeMode(supported, mode).mode : null;
}

/** 计划模式提示（CLI 没有原生无头计划模式时附在用户消息前） */
export const PLAN_PROMPT_PREFIX =
  'You are in plan mode: do not modify any files. Investigate as needed, then reply with a complete implementation plan in Markdown and wait for approval.\n\n';
