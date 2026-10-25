/**
 * 权限模式（docs/design/cli-permission-modes.md §4）：编程助手，以及 Nomi 自己的工具
 * （主进程 desktop/consent.ts；Nomi 没有「完全放开」）。
 * 与主进程 cli/permissionMode.ts 的 SUPPORTED / 降级规则保持一致：主进程是最终裁决（返回 degraded），
 * 这里只用来决定下拉里哪些可选、Shift+Tab 怎么循环。
 */
import { t } from '@nomi-ai/ui';

import type { HarnessBackend } from '../services/harnessClient';

export type PermissionMode = 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'bypass',
];

type CliBackend = Exclude<HarnessBackend, 'nomi'>;

const SUPPORTED: Record<CliBackend, readonly PermissionMode[]> = {
  claude: PERMISSION_MODES,
  // Codex 走 app-server：有审批请求，可逐项确认
  codex: ['plan', 'manual', 'acceptEdits', 'auto', 'bypass'],
  dsh: ['plan', 'acceptEdits', 'bypass'],
  // Grok 走 ACP（grok agent stdio）：有审批请求、没有「自动」
  grok: ['plan', 'manual', 'acceptEdits', 'bypass'],
  gemini: ['plan', 'manual', 'acceptEdits', 'bypass'],
  // 外部 CLI（L1，§5.9）只有逐项确认：每次工具调用都经 ACP 权限请求由你批准
  external: ['manual'],
};

export const isPermissionMode = (v: unknown): v is PermissionMode =>
  typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);

/** Nomi 自己的工具：破坏性操作永远要确认，所以没有「完全放开」 */
const NOMI_MODES: readonly PermissionMode[] = ['plan', 'manual', 'acceptEdits', 'auto'];

export function supportedModes(backend: HarnessBackend): readonly PermissionMode[] {
  return backend === 'nomi' ? NOMI_MODES : SUPPORTED[backend];
}

/** 不支持时实际使用的档位：只往更安全的一侧降（manual → plan，auto → acceptEdits） */
export function fallbackMode(backend: HarnessBackend, mode: PermissionMode): PermissionMode {
  const ok = supportedModes(backend);
  if (ok.includes(mode)) return mode;
  const next = mode === 'manual' ? 'plan' : 'acceptEdits';
  // 外部插件（§5.9）只有逐项确认：降不到计划 / 自动改文件时用它支持的第一档
  return ok.includes(next) || !ok.length ? next : ok[0]!;
}

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return t('ui.chat-settings.plan');
    case 'manual':
      return t('ui.chat-settings.ask-each-time');
    case 'acceptEdits':
      return t('ui.chat-settings.auto-edit-files');
    case 'auto':
      return t('ui.foundation.auto');
    case 'bypass':
      return t('ui.chat-settings.full-access');
  }
}

/** 档位说明；Nomi 的档位作用在它自己的工具（文件、剪贴板、浏览器、扩展）上，说法不同 */
export function modeHint(mode: PermissionMode, backend?: HarnessBackend): string {
  if (backend === 'nomi') {
    switch (mode) {
      case 'plan':
        return t('ui.chat-settings.read-only-can-look-at-files-and-data');
      case 'manual':
        return t('ui.chat-settings.asks-you-every-time-before-writing-files-or');
      case 'acceptEdits':
        return t('ui.chat-settings.asks-according-to-each-tool-s-setting-in');
      case 'auto':
        return t('ui.chat-settings.makes-changes-without-asking-deletions-and-other-destructive');
      case 'bypass':
        break;
    }
  }
  switch (mode) {
    case 'plan':
      return t('ui.chat-settings.read-only-proposes-a-plan-without-changing-files');
    case 'manual':
      return t('ui.chat-settings.asks-you-before-changing-files-or-running-commands');
    case 'acceptEdits':
      return t('ui.chat-settings.edits-files-in-the-working-directory-automatically-other');
    case 'auto':
      return t('ui.chat-settings.lets-the-cli-decide-which-actions-need-confirmation');
    case 'bypass':
      return t('ui.chat-settings.no-restrictions-can-change-any-file-and-run');
  }
}

/** Shift+Tab：在支持的档位间循环，跳过「完全放开」（只能从下拉进入并确认） */
export function nextMode(backend: HarnessBackend, current: PermissionMode): PermissionMode | null {
  const ring: PermissionMode[] = supportedModes(backend).filter((m) => m !== 'bypass');
  if (!ring.length) return null;
  const i = ring.indexOf(current);
  return ring[(i + 1) % ring.length]!;
}

/** 输入框里按 Shift+Tab 时发出；模式按钮处理后把 handled 置为 true */
export const CYCLE_PERMISSION_EVENT = 'nomi:cycle-permission-mode';
export type CyclePermissionDetail = { handled: boolean };
