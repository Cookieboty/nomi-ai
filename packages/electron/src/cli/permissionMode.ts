/**
 * 编程助手权限模式：Nomi 统一五档 → 各 CLI 原生参数 / 环境变量。
 * 设计与真机查证见 docs/design/cli-permission-modes.md。
 */
import type { HarnessBackend, HarnessPermissionMode } from './types';

type CliBackend = Exclude<HarnessBackend, 'nomi'>;

export const PERMISSION_MODES: readonly HarnessPermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'bypass',
];

/** 新标签默认档；「完全放开」不能作为默认 */
export const DEFAULT_PERMISSION_MODE: HarnessPermissionMode = 'acceptEdits';

export function isPermissionMode(v: unknown): v is HarnessPermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

/**
 * 各后端可用的档位。
 * - Codex / dsh 无头模式没有可回写的审批事件 → 无「逐项确认」
 * - dsh 没有自动审批 → 无「自动」
 * - Grok 无头模式的权限事件未在真机验证 → 暂不开放「逐项确认」
 */
const SUPPORTED: Record<CliBackend, readonly HarnessPermissionMode[]> = {
  claude: PERMISSION_MODES,
  codex: ['plan', 'acceptEdits', 'auto', 'bypass'],
  dsh: ['plan', 'acceptEdits', 'bypass'],
  grok: ['plan', 'acceptEdits', 'auto', 'bypass'],
  // Gemini ACP：plan / default（可审批）/ autoEdit / yolo；没有「自动」（降为自动改文件）
  gemini: ['plan', 'manual', 'acceptEdits', 'bypass'],
};

/** 不支持时的降级目标：只往更安全的一侧降 */
const FALLBACK: Partial<Record<HarnessPermissionMode, HarnessPermissionMode>> = {
  manual: 'plan',
  auto: 'acceptEdits',
};

export function supportedModes(backend: HarnessBackend): readonly HarnessPermissionMode[] {
  return backend === 'nomi' ? PERMISSION_MODES : SUPPORTED[backend];
}

/** 后端实际使用的档位；降级时 degraded = true */
export function effectiveMode(
  backend: HarnessBackend,
  mode: HarnessPermissionMode,
): { mode: HarnessPermissionMode; degraded: boolean } {
  const ok = supportedModes(backend);
  if (ok.includes(mode)) return { mode, degraded: false };
  const next = FALLBACK[mode];
  return { mode: next && ok.includes(next) ? next : 'plan', degraded: true };
}

export interface PermissionLaunch {
  args: string[];
  env: Record<string, string>;
}

const CLAUDE_MODE: Record<HarnessPermissionMode, string> = {
  plan: 'plan',
  manual: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  bypass: 'bypassPermissions',
};

/** Claude 运行中切换（control_request set_permission_mode）用的模式名 */
export function claudeModeName(mode: HarnessPermissionMode): string {
  return CLAUDE_MODE[mode];
}

/**
 * 启动参数。Codex 全部走 `-c`：`exec resume` 不接受 --sandbox / --approve-for-me。
 * 调用方应先用 effectiveMode 降级。
 */
export function permissionLaunch(
  backend: CliBackend,
  mode: HarnessPermissionMode,
  opts: { codexNetwork?: boolean } = {},
): PermissionLaunch {
  switch (backend) {
    case 'claude':
      return { args: ['--permission-mode', CLAUDE_MODE[mode]], env: {} };
    case 'codex': {
      const sandbox =
        mode === 'plan'
          ? 'read-only'
          : mode === 'bypass'
            ? 'danger-full-access'
            : 'workspace-write';
      const args = ['-c', `sandbox_mode="${sandbox}"`];
      if (sandbox === 'workspace-write' && opts.codexNetwork !== false) {
        args.push('-c', 'sandbox_workspace_write.network_access=true');
      }
      if (mode === 'auto') {
        args.push('-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"');
      }
      return { args, env: {} };
    }
    case 'dsh': {
      const sandbox =
        mode === 'plan'
          ? 'read-only'
          : mode === 'bypass'
            ? 'danger-full-access'
            : 'workspace-write';
      return { args: [], env: { DSH_PERMISSION_MODE: sandbox } };
    }
    case 'gemini':
      // 模式经 ACP session/set_mode 设置（geminiModeId），启动参数不带
      return { args: [], env: {} };
    case 'grok':
      return mode === 'bypass'
        ? { args: ['--yolo'], env: {} }
        : { args: ['--permission-mode', CLAUDE_MODE[mode]], env: {} };
  }
}

/** Gemini ACP 的会话模式 id（0.62.0 session/new 返回的 availableModes） */
export function geminiModeId(mode: HarnessPermissionMode): string {
  return mode === 'plan'
    ? 'plan'
    : mode === 'acceptEdits' || mode === 'auto'
      ? 'autoEdit'
      : mode === 'bypass'
        ? 'yolo'
        : 'default';
}

/** 计划模式下附在用户消息前的提示（CLI 无原生无头计划模式时使用） */
export function planPromptPrefix(backend: CliBackend): string | null {
  return backend === 'codex' || backend === 'dsh'
    ? 'You are in plan mode: do not modify any files. Investigate as needed, then reply with a complete implementation plan in Markdown and wait for approval.\n\n'
    : null;
}
