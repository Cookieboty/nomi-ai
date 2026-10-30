/**
 * 权限档位的共用部分（设计与真机查证见 docs/design/cli-permission-modes.md）：
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

/** Claude 的 permission-mode 名（Grok 沿用同一套名字） */
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
