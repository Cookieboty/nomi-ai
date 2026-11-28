import { BUILTIN_MANIFESTS, byCli } from '@nomi-ai/cli-catalog';
/**
 * 权限模式（docs/development/coding-agents.md）：agents，以及 Nomi 自己的工具
 * （主进程 desktop/consent.ts；Nomi 没有「完全放开」，「自动」就是 Nomi 的最高档）。
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

/** 各端支持的档位：内置 CLI 取清单的 permissionModes */
const SUPPORTED: Record<CliBackend, readonly PermissionMode[]> = {
  ...byCli((id) => (BUILTIN_MANIFESTS[id].capabilities.permissionModes ?? []).map((m) => m.mode)),
};

export const isPermissionMode = (v: unknown): v is PermissionMode =>
  typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);

/** Nomi 自己的工具：没有「完全放开」，「自动」覆盖允许工具的逐项确认 */
const NOMI_MODES: readonly PermissionMode[] = ['plan', 'manual', 'acceptEdits', 'auto'];

export function supportedModes(backend: HarnessBackend): readonly PermissionMode[] {
  return backend === 'nomi' ? NOMI_MODES : SUPPORTED[backend];
}

/** 不支持时实际使用的档位：只往更安全的一侧降（manual → plan，auto → acceptEdits） */
export function fallbackMode(backend: HarnessBackend, mode: PermissionMode): PermissionMode {
  const ok = supportedModes(backend);
  if (ok.includes(mode)) return mode;
  const next = mode === 'manual' ? 'plan' : 'acceptEdits';
  // 降不到计划 / 自动改文件时用它支持的第一档
  return ok.includes(next) || !ok.length ? next : ok[0]!;
}

const BACKEND_MODE_LABEL: Partial<Record<HarnessBackend, Partial<Record<PermissionMode, string>>>> =
  {
    antigravity: {
      plan: 'ui.chat-settings.perm-cli-plan',
      manual: 'ui.chat-settings.perm-cli-default',
      acceptEdits: 'ui.chat-settings.perm-agy-accept-edits',
      auto: 'ui.chat-settings.perm-agy-auto',
    },
    gemini: {
      plan: 'ui.chat-settings.perm-cli-plan',
      manual: 'ui.chat-settings.perm-cli-default',
      acceptEdits: 'ui.chat-settings.perm-gemini-auto-edit',
      bypass: 'ui.chat-settings.perm-cli-yolo',
    },
    kimi: {
      plan: 'ui.chat-settings.perm-cli-plan',
      manual: 'ui.chat-settings.perm-cli-default',
      auto: 'ui.chat-settings.perm-cli-yolo',
      bypass: 'ui.chat-settings.perm-agy-auto',
    },
    minimax: {
      plan: 'ui.chat-settings.perm-cli-plan',
      manual: 'ui.chat-settings.perm-cli-default',
    },
    grok: {
      plan: 'ui.chat-settings.perm-cli-plan',
      manual: 'ui.chat-settings.perm-cli-default',
      acceptEdits: 'ui.chat-settings.perm-grok-accept-edits',
      auto: 'ui.chat-settings.perm-grok-accept-edits',
      bypass: 'ui.chat-settings.perm-grok-bypass',
    },
  };

const BACKEND_MODE_HINT: Partial<Record<HarnessBackend, Partial<Record<PermissionMode, string>>>> =
  {
    antigravity: {
      plan: 'ui.chat-settings.perm-hint-agy-plan',
      manual: 'ui.chat-settings.perm-hint-agy-manual',
      acceptEdits: 'ui.chat-settings.perm-hint-agy-accept',
      auto: 'ui.chat-settings.perm-hint-agy-auto',
    },
    gemini: {
      plan: 'ui.chat-settings.perm-hint-gemini-plan',
      manual: 'ui.chat-settings.perm-hint-gemini-manual',
      acceptEdits: 'ui.chat-settings.perm-hint-gemini-accept',
      bypass: 'ui.chat-settings.perm-hint-gemini-bypass',
    },
    kimi: {
      plan: 'ui.chat-settings.perm-hint-kimi-plan',
      manual: 'ui.chat-settings.perm-hint-kimi-manual',
      auto: 'ui.chat-settings.perm-hint-kimi-auto',
      bypass: 'ui.chat-settings.perm-hint-kimi-bypass',
    },
    minimax: {
      plan: 'ui.chat-settings.perm-hint-minimax-plan',
      manual: 'ui.chat-settings.perm-hint-minimax-manual',
    },
    claude: {
      plan: 'ui.chat-settings.perm-hint-claude-plan',
      manual: 'ui.chat-settings.perm-hint-claude-manual',
      acceptEdits: 'ui.chat-settings.perm-hint-claude-accept',
      auto: 'ui.chat-settings.perm-hint-claude-auto',
      bypass: 'ui.chat-settings.perm-hint-claude-bypass',
    },
    codex: {
      plan: 'ui.chat-settings.perm-hint-codex-plan',
      manual: 'ui.chat-settings.perm-hint-codex-manual',
      acceptEdits: 'ui.chat-settings.perm-hint-codex-accept',
      auto: 'ui.chat-settings.perm-hint-codex-auto',
      bypass: 'ui.chat-settings.perm-hint-codex-bypass',
    },
    grok: {
      plan: 'ui.chat-settings.perm-hint-grok-plan',
      manual: 'ui.chat-settings.perm-hint-grok-manual',
      acceptEdits: 'ui.chat-settings.perm-hint-grok-accept',
      auto: 'ui.chat-settings.perm-hint-grok-auto',
      bypass: 'ui.chat-settings.perm-hint-grok-bypass',
    },
    dsh: {
      plan: 'ui.chat-settings.perm-hint-dsh-plan',
      acceptEdits: 'ui.chat-settings.perm-hint-dsh-accept',
      bypass: 'ui.chat-settings.perm-hint-dsh-bypass',
    },
  };

export function modeLabel(mode: PermissionMode, backend?: HarnessBackend): string {
  const custom = backend ? BACKEND_MODE_LABEL[backend]?.[mode] : undefined;
  if (custom) return t(custom as never);
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

/** 档位说明；Nomi 与各内置 CLI 均精确匹配其原生策略行为 */
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
  const custom = backend ? BACKEND_MODE_HINT[backend]?.[mode] : undefined;
  if (custom) return t(custom as never);
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
