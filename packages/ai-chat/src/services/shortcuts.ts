/**
 * 对话窗快捷键注册表：默认组合、用户改绑（localStorage）、匹配与冲突检测。
 *
 * 组合键写法：`Mod+Shift+K`。Mod = macOS 上的 ⌘，其他平台的 Ctrl。
 * 字母 / 数字按物理键（e.code）匹配，避免 Shift 改变 e.key（例如 Shift+1 → "!"）。
 */
import { useEffect, useState } from 'react';

/** 快捷键触发「搜索对话」时在 window 上广播的事件（侧栏监听） */
export const SEARCH_CHATS_EVENT = 'nomi:search-chats';

export type ShortcutId =
  | 'palette'
  | 'newChat'
  | 'searchChats'
  | 'focusInput'
  | 'settings'
  | 'sidebar'
  | 'kbAsk'
  | 'snip'
  | 'handsFree'
  | 'hub'
  | 'ext'
  | 'local'
  | 'screen'
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
  { id: 'palette', label: '命令面板', combo: 'Mod+K' },
  { id: 'newChat', label: '新对话', combo: 'Mod+N' },
  { id: 'searchChats', label: '搜索对话', combo: 'Mod+F' },
  { id: 'focusInput', label: '聚焦输入框', combo: 'Mod+L' },
  { id: 'settings', label: '打开设置', combo: 'Mod+,' },
  { id: 'sidebar', label: '收起 / 展开侧栏', combo: 'Mod+B' },
  { id: 'kbAsk', label: '知识库问答开关', combo: 'Mod+Shift+K' },
  { id: 'snip', label: '截图提问', combo: 'Mod+Shift+S' },
  { id: 'handsFree', label: '免按键对话开关', combo: 'Mod+Shift+H' },
  { id: 'hub', label: '知识 · 记忆 · 日程', combo: 'Mod+Shift+M' },
  { id: 'ext', label: '扩展 / MCP', combo: 'Mod+Shift+E' },
  { id: 'local', label: '本机管理', combo: 'Mod+Shift+J' },
  { id: 'screen', label: '屏幕记忆', combo: 'Mod+Shift+O' },
  { id: 'newTab', label: '新建编程助手标签', combo: 'Mod+T' },
  { id: 'closeTab', label: '关闭标签', combo: 'Mod+Shift+W' },
  { id: 'nextTab', label: '下一个标签', combo: 'Ctrl+Tab' },
  { id: 'prevTab', label: '上一个标签', combo: 'Ctrl+Shift+Tab' },
  { id: 'renameTab', label: '重命名标签', combo: 'Mod+Shift+R' },
];

/** 不可改绑、仅展示的按键 */
export const FIXED_SHORTCUTS: Array<[string, string]> = [
  ['/', '在输入框里打开命令'],
  ['Enter / Shift+Enter', '发送 / 换行'],
  ['↑（输入框为空时）', '找回上一条提问'],
  ['F2（按住）', '说话'],
  ['Mod+Shift+F', '把当前对话分叉为新对话'],
  ['Esc', '关闭弹窗 / 菜单'],
  ['↑ / ↓ / Enter（菜单里）', '在菜单项间移动 / 确认'],
  ['Mod+1…9', '切换到第 n 个标签（9 = 最后一个）'],
];

/** 系统 / 编辑常用组合：改绑到这些上会给出冲突提示 */
export const RESERVED: Record<string, string> = {
  'Mod+C': '复制',
  'Mod+V': '粘贴',
  'Mod+X': '剪切',
  'Mod+A': '全选',
  'Mod+Z': '撤销',
  'Mod+Shift+Z': '重做',
  'Mod+Y': '重做',
  'Mod+Q': '退出应用',
  'Mod+W': '关闭窗口',
  'Mod+R': '刷新',
  'Mod+Shift+I': '开发者工具',
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
