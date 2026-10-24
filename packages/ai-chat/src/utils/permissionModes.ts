/**
 * 编程助手的权限模式（docs/design/cli-permission-modes.md §4）。
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

export function supportedModes(backend: HarnessBackend): readonly PermissionMode[] {
  return backend === 'nomi' ? [] : SUPPORTED[backend];
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
      return t('计划');
    case 'manual':
      return t('逐项确认');
    case 'acceptEdits':
      return t('自动改文件');
    case 'auto':
      return t('自动');
    case 'bypass':
      return t('完全放开');
  }
}

export function modeHint(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return t('只读：先给出方案，不改文件、不执行命令');
    case 'manual':
      return t('改文件、运行命令前都先问你');
    case 'acceptEdits':
      return t('自动修改工作目录里的文件，其它操作按 CLI 规则询问');
    case 'auto':
      return t('由 CLI 自行判断哪些操作需要确认');
    case 'bypass':
      return t('不做任何限制，可以改任何文件、运行任何命令');
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
