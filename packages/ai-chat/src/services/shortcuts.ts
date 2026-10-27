/**
 * 对话窗快捷键注册表：默认组合、用户改绑（localStorage）、匹配与冲突检测。
 *
 * 组合键写法：`Mod+Shift+K`。Mod = macOS 上的 ⌘，其他平台的 Ctrl。
 * 字母 / 数字按物理键（e.code）匹配，避免 Shift 改变 e.key（例如 Shift+1 → "!"）。
 */
import { useEffect, useState } from 'react';

import { useWindowEvent } from '../hooks/useWindowEvent';

/** 快捷键触发「搜索对话」时在 window 上广播的事件（侧栏监听） */
export const SEARCH_CHATS_EVENT = 'nomi:search-chats';
/** 快捷键触发「重命名当前会话」时广播的事件（侧栏监听，在列表里进入改名） */
export const RENAME_CHAT_EVENT = 'nomi:rename-chat';

const SHORTCUT_EVENTS = { searchChats: SEARCH_CHATS_EVENT, renameTab: RENAME_CHAT_EVENT } as const;
/** 在别处（如侧栏）响应 App 广播的快捷键动作 */
export function useShortcutEvent(id: keyof typeof SHORTCUT_EVENTS, fn: () => void): void {
  useWindowEvent(SHORTCUT_EVENTS[id], fn);
}

export type ShortcutId =
  | 'palette'
  | 'newChat'
  | 'searchChats'
  | 'focusInput'
  | 'settings'
  | 'sidebar'
  | 'kbAsk'
  | 'handsFree'
  | 'hub'
  | 'ext'
  | 'local'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'renameTab';

export interface ShortcutDef {
  id: ShortcutId;
  /** 中文文案（同时是 i18n key） */
  label: string;
  combo: string;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: 'palette', label: 'ui.mascot-theme.command-palette', combo: 'Mod+K' },
  { id: 'newChat', label: 'ui.chat-settings.new-chat', combo: 'Mod+N' },
  { id: 'searchChats', label: 'ui.cli-monitor.search-conversations', combo: 'Mod+F' },
  { id: 'focusInput', label: 'ui.mascot-theme.focus-message-input', combo: 'Mod+L' },
  { id: 'settings', label: 'ui.chat-settings.open-settings', combo: 'Mod+,' },
  { id: 'sidebar', label: 'ui.chat-settings.collapse-expand-sidebar', combo: 'Mod+B' },
  { id: 'kbAsk', label: 'ui.chat-settings.toggle-knowledge-base-q-a', combo: 'Mod+Shift+K' },
  { id: 'handsFree', label: 'ui.mascot-theme.toggle-hands-free-voice', combo: 'Mod+Shift+H' },
  { id: 'hub', label: 'ui.chat-settings.knowledge-memory-schedule', combo: 'Mod+Shift+M' },
  { id: 'ext', label: 'ui.foundation.extensions-mcp', combo: 'Mod+Shift+E' },
  { id: 'local', label: 'ui.knowledge-local.local-models', combo: 'Mod+Shift+J' },
  { id: 'newTab', label: 'ui.mascot-theme.new-coding-agent-tab', combo: 'Mod+T' },
  { id: 'closeTab', label: 'ui.mascot-theme.close-tab-action', combo: 'Mod+Shift+W' },
  { id: 'nextTab', label: 'ui.mascot-theme.next-tab', combo: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'ui.cli-monitor.previous-tab', combo: 'Ctrl+Shift+Tab' },
  { id: 'renameTab', label: 'ui.cli-monitor.rename-tab', combo: 'Mod+Shift+R' },
];

/** 不可改绑、仅展示的按键 */
export const FIXED_SHORTCUTS: Array<[string, string]> = [
  ['/', 'ui.chat-settings.open-commands-in-the-input-box'],
  ['Enter / Shift+Enter', 'ui.chat-settings.send-new-line'],
  ['ui.chat-settings.when-input-is-empty', 'ui.chat-settings.recall-last-prompt'],
  ['ui.chat-settings.f2-hold', 'ui.chat-settings.talk'],
  ['Mod+Shift+F', 'ui.cli-monitor.fork-the-current-conversation-into-a-new-one'],
  ['Esc', 'ui.mascot-theme.close-dialog-menu'],
  ['ui.cli-monitor.enter-in-menus', 'ui.cli-monitor.move-between-menu-items-confirm'],
  ['Mod+1…9', 'ui.cli-monitor.switch-to-tab-n-9-last-tab'],
];

/** 系统 / 编辑常用组合：改绑到这些上会给出冲突提示 */
export const RESERVED: Record<string, string> = {
  'Mod+C': 'ui.knowledge-local.copy',
  'Mod+V': 'ui.mascot-theme.paste',
  'Mod+X': 'ui.mascot-theme.cut',
  'Mod+A': 'ui.providers-schedule.select-all',
  'Mod+Z': 'ui.mascot-theme.undo',
  'Mod+Shift+Z': 'ui.mascot-theme.redo',
  'Mod+Y': 'ui.mascot-theme.redo',
  'Mod+Q': 'ui.mascot-theme.quit-app',
  'Mod+W': 'ui.mascot-theme.close-window',
  'Mod+R': 'ui.knowledge-local.refresh',
  'Mod+Shift+I': 'ui.mascot-theme.developer-tools',
};

const STORE_KEY = 'nomi.shortcuts.v1';
const EVT = 'nomi:shortcuts-changed';

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function loadOverrides(): Partial<Record<ShortcutId, string>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, unknown>;
    const out: Partial<Record<ShortcutId, string>> = {};
    for (const d of SHORTCUT_DEFS) {
      const v = raw[d.id];
      if (typeof v === 'string' && v) out[d.id] = normalizeCombo(v);
    }
    return out;
  } catch {
    return {};
  }
}

export function getBindings(): Record<ShortcutId, string> {
  const o = loadOverrides();
  return Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.id, o[d.id] ?? d.combo])) as Record<
    ShortcutId,
    string
  >;
}

export function setBinding(id: ShortcutId, combo: string | null): void {
  const o = loadOverrides();
  const def = SHORTCUT_DEFS.find((d) => d.id === id)!;
  if (!combo || normalizeCombo(combo) === def.combo) delete o[id];
  else o[id] = normalizeCombo(combo);
  localStorage.setItem(STORE_KEY, JSON.stringify(o));
  window.dispatchEvent(new Event(EVT));
}

export function resetBindings(): void {
  localStorage.removeItem(STORE_KEY);
  window.dispatchEvent(new Event(EVT));
}

/** 订阅当前绑定（设置页改绑后立即生效；其他窗口通过 storage 事件同步） */
export function useShortcutBindings(): Record<ShortcutId, string> {
  const [b, setB] = useState(getBindings);
  useEffect(() => {
    const on = () => setB(getBindings());
    window.addEventListener(EVT, on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener(EVT, on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return b;
}

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').filter(Boolean);
  // 「Mod+Shift++」这类以 + 为键的写法
  if (combo.endsWith('++')) parts.push('+');
  const mods = MOD_ORDER.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  const key = parts
    .filter((p) => !MOD_ORDER.some((m) => m.toLowerCase() === p.toLowerCase()))
    .pop();
  const k = key && key.length === 1 ? key.toUpperCase() : (key ?? '');
  return [...mods, k].join('+');
}

function eventKey(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (e.key === ' ') return 'Space';
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn']);

/** 键盘事件 → 组合键字符串；只按了修饰键时返回 null */
export function comboFromEvent(e: KeyboardEvent, mac = isMac()): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mods: string[] = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) mods.push('Mod');
  if (mac && e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return normalizeCombo([...mods, eventKey(e)].join('+'));
}

export function matchShortcut(e: KeyboardEvent, combo: string, mac = isMac()): boolean {
  return !!combo && comboFromEvent(e, mac) === normalizeCombo(combo);
}

/** 按平台显示：macOS ⌘⇧K，其他 Ctrl+Shift+K */
export function formatCombo(combo: string, mac = isMac()): string {
  const parts = normalizeCombo(combo).split('+');
  if (mac) {
    const sym: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
    return parts.map((p) => sym[p] ?? p).join('');
  }
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+');
}

/** 组合键是否可以作为快捷键：需要 Mod / Ctrl / Alt，或是 F1–F12 */
export function isValidCombo(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1] ?? '';
  if (/^F([1-9]|1[0-2])$/.test(key)) return true;
  return parts.some((p) => p === 'Mod' || p === 'Ctrl' || p === 'Alt') && !!key;
}

export interface Conflict {
  /** 与之冲突的其他快捷键 id */
  with: ShortcutId[];
  /** 与系统 / 编辑快捷键冲突时的名称 */
  reserved?: string;
}

export function findConflicts(
  b: Record<ShortcutId, string>,
): Partial<Record<ShortcutId, Conflict>> {
  const out: Partial<Record<ShortcutId, Conflict>> = {};
  const ids = Object.keys(b) as ShortcutId[];
  for (const id of ids) {
    const c = normalizeCombo(b[id]);
    const others = ids.filter((o) => o !== id && normalizeCombo(b[o]) === c);
    const reserved = RESERVED[c];
    if (others.length || reserved) out[id] = { with: others, reserved };
  }
  return out;
}
