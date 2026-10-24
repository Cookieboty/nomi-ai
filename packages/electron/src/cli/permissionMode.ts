/**
 * 编程助手权限模式：Nomi 统一五档 → 各 CLI 原生参数 / 环境变量。
 * 设计与真机查证见 docs/design/cli-permission-modes.md。
 * 各 CLI 的档位表在插件里（@nomi-ai/cli-plugins 的 permissions 能力，§5.1）；这里按后端分发，对外接口不变。
 * - Codex 走 app-server（0.163.0 实测）：审批请求可逐项确认；退回 `exec` 时没有审批通道，按只读沙箱跑
 * - dsh 无头模式没有可回写的审批事件 → 无「逐项确认」；没有自动审批 → 无「自动」
 * - Grok 走 ACP（`grok agent stdio`，1.0.62 实测）：ACP 会话模式没有「自动」
 * - Gemini ACP：plan / default（可审批）/ autoEdit / yolo；没有「自动」（降为自动改文件）
 */
import {
  claude,
  codex,
  degradeMode,
  dsh,
  gemini,
  grok,
  isPermissionMode as isMode,
  PERMISSION_MODES as MODES,
} from '@nomi-ai/cli-plugins/main';
import type { PermissionCapability } from '@nomi-ai/cli-sdk';

import type { HarnessBackend, HarnessPermissionMode } from './types';

type CliBackend = Exclude<HarnessBackend, 'nomi'>;

const PERMS: Record<CliBackend, PermissionCapability> = {
  claude: claude.permissions,
  codex: codex.permissions,
  dsh: dsh.permissions,
  grok: grok.permissions,
  gemini: gemini.permissions,
};

export const PERMISSION_MODES: readonly HarnessPermissionMode[] = MODES;

/** 新标签默认档；「完全放开」不能作为默认 */
export const DEFAULT_PERMISSION_MODE: HarnessPermissionMode = 'acceptEdits';

export function isPermissionMode(v: unknown): v is HarnessPermissionMode {
  return isMode(v);
}

/** 各后端可用的档位 */
export function supportedModes(backend: HarnessBackend): readonly HarnessPermissionMode[] {
  return backend === 'nomi' ? PERMISSION_MODES : PERMS[backend].supported;
}

/** 后端实际使用的档位；降级时 degraded = true（只往更安全的一侧降） */
export function effectiveMode(
  backend: HarnessBackend,
  mode: HarnessPermissionMode,
): { mode: HarnessPermissionMode; degraded: boolean } {
  return degradeMode(supportedModes(backend), mode);
}

export interface PermissionLaunch {
  args: string[];
  env: Record<string, string>;
}

/** Claude 运行中切换（control_request set_permission_mode）用的模式名 */
export function claudeModeName(mode: HarnessPermissionMode): string {
  return PERMS.claude.modeId!(mode);
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
  return PERMS[backend].launch(
    mode,
    opts.codexNetwork === undefined ? {} : { network: opts.codexNetwork },
  );
}

/** Gemini ACP 的会话模式 id（0.62.0 session/new 返回的 availableModes） */
export function geminiModeId(mode: HarnessPermissionMode): string {
  return PERMS.gemini.modeId!(mode);
}

/** Grok ACP 的会话模式 id（1.0.62 实测；不认识的 id 也回 {}，所以只发插件里列出的） */
export function grokModeId(mode: HarnessPermissionMode): string {
  return PERMS.grok.modeId!(mode);
}

/** 长驻 ACP 会话（Gemini / Grok）的会话模式 id */
export function acpModeId(backend: 'gemini' | 'grok', mode: HarnessPermissionMode): string {
  return PERMS[backend].modeId!(mode);
}

/**
 * 将 CLI / ACP 返回的原生安全模式映射成 Nomi 档位。
 * 返回 null 表示 CLI 返回了未知值；调用方此时不能猜测并覆盖 CLI 当前状态。
 * 这里集中处理历史解析和 ACP 握手，避免两条路径对同一原生值产生不同结论。
 */
export function fromCliPermissionMode(
  backend: CliBackend,
  raw: unknown,
): HarnessPermissionMode | null {
  return typeof raw === 'string' ? (PERMS[backend].fromModeId?.(raw) ?? null) : null;
}

/** 计划模式下附在用户消息前的提示（CLI 无原生无头计划模式时使用） */
export function planPromptPrefix(backend: CliBackend): string | null {
  return PERMS[backend].planPrefix ?? null;
}
