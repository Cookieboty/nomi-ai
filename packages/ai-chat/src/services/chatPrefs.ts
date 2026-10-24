/**
 * 对话 UI 偏好：普通/开发模式、界面模式（精简 / 全量）、侧栏「全部|按端」。
 * 持久化在 localStorage（与 ConversationStore 同层）；桌面端无需主进程同步。
 */
export type ChatMode = 'normal' | 'dev';
export type ConversationListView = 'all' | 'by-endpoint';
/**
 * 工作台的界面模式：full = 全量（默认，顶部对话标签 + 侧栏底部的编程助手信息卡）；
 * compact = 精简（隐藏这两块，只留会话列表与对话）。助手（普通）模式本来就没有这两块，不受影响。
 */
export type LayoutDensity = 'full' | 'compact';

const MODE_KEY = 'ai-chat:chatMode';
const LIST_VIEW_KEY = 'ai-chat:conversationListView';
const ENDPOINT_FILTER_KEY = 'ai-chat:endpointFilter';
const DENSITY_KEY = 'ai-chat:layoutDensity';

type Listener = () => void;
const modeSubs = new Set<Listener>();
const listSubs = new Set<Listener>();
const densitySubs = new Set<Listener>();

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const v = window.localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function getChatMode(): ChatMode {
  return read(MODE_KEY, ['normal', 'dev'] as const, 'normal');
}

export function setChatMode(mode: ChatMode): void {
  write(MODE_KEY, mode);
  modeSubs.forEach((fn) => fn());
}

export function subscribeChatMode(fn: Listener): () => void {
  modeSubs.add(fn);
  return () => void modeSubs.delete(fn);
}

export function getLayoutDensity(): LayoutDensity {
  return read(DENSITY_KEY, ['full', 'compact'] as const, 'full');
}

export function setLayoutDensity(density: LayoutDensity): void {
  write(DENSITY_KEY, density);
  densitySubs.forEach((fn) => fn());
}

export function subscribeLayoutDensity(fn: Listener): () => void {
  densitySubs.add(fn);
  // 其它窗口（对话窗口 / 设置窗口等）改了界面模式：同源 localStorage 的 storage 事件只在「别的」窗口触发，
  // 在这里转成本窗口的订阅通知；key 为 null 表示被 clear()，也要刷新
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === DENSITY_KEY) fn();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    densitySubs.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function getConversationListView(): ConversationListView {
  return read(LIST_VIEW_KEY, ['all', 'by-endpoint'] as const, 'all');
}

export function setConversationListView(view: ConversationListView): void {
  write(LIST_VIEW_KEY, view);
  listSubs.forEach((fn) => fn());
}

export function subscribeConversationListView(fn: Listener): () => void {
  listSubs.add(fn);
  return () => void listSubs.delete(fn);
}

import type { ConversationBackend } from '../types/chat';
import { isConversationBackend } from '../types/chat';

export function getEndpointFilter(): ConversationBackend {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'nomi';
    const v = window.localStorage.getItem(ENDPOINT_FILTER_KEY);
    return isConversationBackend(v) ? v : 'nomi';
  } catch {
    return 'nomi';
  }
}

export function setEndpointFilter(backend: ConversationBackend): void {
  write(ENDPOINT_FILTER_KEY, backend);
  listSubs.forEach((fn) => fn());
}

// ───── 侧栏「按端」里显示哪些端点 ─────
const ENDPOINT_VIS_KEY = 'ai-chat:sidebarEndpoints';

/**
 * 某个编程助手端点在侧栏「按端」里的显示方式：
 * auto（默认，没有显式设置）= 有对话 / 标签 / 历史时才显示；show = 总是显示；hide = 不显示。
 * Nomi 总是显示，不参与设置。
 */
export type EndpointVisibility = 'auto' | 'show' | 'hide';
export type EndpointVisibilityMap = Partial<Record<ConversationBackend, 'show' | 'hide'>>;

let visCache: { raw: string | null; value: EndpointVisibilityMap } = { raw: null, value: {} };

/** 只存显式设置；返回同一个对象直到存储变化（供 useSyncExternalStore 使用） */
export function getEndpointVisibility(): EndpointVisibilityMap {
  let raw: string | null = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      raw = window.localStorage.getItem(ENDPOINT_VIS_KEY);
  } catch {
    raw = null;
  }
  if (raw === visCache.raw) return visCache.value;
  const value: EndpointVisibilityMap = {};
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(o ?? {}))
      if (isConversationBackend(k) && k !== 'nomi' && (v === 'show' || v === 'hide')) value[k] = v;
  } catch {
    /* 损坏的值按「全部自动」处理 */
  }
  visCache = { raw, value };
  return value;
}

export function setEndpointVisibility(backend: ConversationBackend, v: EndpointVisibility): void {
  if (backend === 'nomi') return;
  const next: EndpointVisibilityMap = { ...getEndpointVisibility() };
  if (v === 'auto') delete next[backend];
  else next[backend] = v;
  write(ENDPOINT_VIS_KEY, JSON.stringify(next));
  listSubs.forEach((fn) => fn());
}

/**
 * 侧栏「按端」实际显示的端点：Nomi 总是显示；显式「显示 / 隐藏」按设置；
 * 没有显式设置的端点，只有在有对话（含标签 / 磁盘历史）时才显示。
 */
export function visibleEndpoints(
  all: readonly ConversationBackend[],
  vis: EndpointVisibilityMap,
  activity: Partial<Record<ConversationBackend, number>>,
): ConversationBackend[] {
  return all.filter((b) => {
    if (b === 'nomi') return true;
    const v = vis[b];
    if (v === 'show') return true;
    if (v === 'hide') return false;
    return (activity[b] ?? 0) > 0;
  });
}

// ───── 侧栏端点的排列顺序 ─────
const ENDPOINT_ORDER_KEY = 'ai-chat:sidebarEndpointOrder';
/** 筛选行一次最多显示的端点图标数（含 Nomi），其余收进「更多」 */
export const MAX_SHOWN_ENDPOINTS = 5;

let orderCache: { raw: string | null; value: ConversationBackend[] | null } = {
  raw: null,
  value: null,
};

/** 用户拖拽后的编程助手端点顺序；null = 自动（按对话数从多到少）。Nomi 固定在最前，不在其中 */
export function getEndpointOrder(): ConversationBackend[] | null {
  let raw: string | null = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      raw = window.localStorage.getItem(ENDPOINT_ORDER_KEY);
  } catch {
    raw = null;
  }
  if (raw === orderCache.raw) return orderCache.value;
  let value: ConversationBackend[] | null = null;
  try {
    const a = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(a)) {
      value = [];
      for (const k of a)
        if (isConversationBackend(k) && k !== 'nomi' && !value.includes(k)) value.push(k);
    }
  } catch {
    value = null; // 损坏的值按「自动」处理
  }
  orderCache = { raw, value };
  return value;
}

/** null 恢复为按对话数自动排序 */
export function setEndpointOrder(order: readonly ConversationBackend[] | null): void {
  try {
    if (order === null) window.localStorage?.removeItem(ENDPOINT_ORDER_KEY);
    else write(ENDPOINT_ORDER_KEY, JSON.stringify(order.filter((b) => b !== 'nomi')));
  } catch {
    /* ignore */
  }
  listSubs.forEach((fn) => fn());
}

/**
 * 端点的排列：Nomi 固定最前；其余按自定义顺序（新出现、不在自定义里的排在后面，按对话数），
 * 没有自定义时按对话数从多到少，相同时保持默认顺序。
 */
export function orderEndpoints(
  list: readonly ConversationBackend[],
  activity: Partial<Record<ConversationBackend, number>>,
  custom: readonly ConversationBackend[] | null,
): ConversationBackend[] {
  const cli: ConversationBackend[] = list.filter((b) => b !== 'nomi');
  const byCount = (a: ConversationBackend, b: ConversationBackend) =>
    (activity[b] ?? 0) - (activity[a] ?? 0) || cli.indexOf(a) - cli.indexOf(b);
  const known = custom ? custom.filter((b) => cli.includes(b)) : [];
  const rest = cli.filter((b) => !known.includes(b)).sort(byCount);
  return [...(list.includes('nomi') ? (['nomi'] as const) : []), ...known, ...rest];
}

/**
 * 筛选行里直接显示的端点（最多 max 个），其余进「更多」。
 * 选中的端点在「更多」里时，换到最后一个位置上，保证选中项始终可见。
 */
export function splitShownEndpoints(
  ordered: readonly ConversationBackend[],
  selected: ConversationBackend | null,
  max = MAX_SHOWN_ENDPOINTS,
): { shown: ConversationBackend[]; more: ConversationBackend[] } {
  if (ordered.length <= max) return { shown: [...ordered], more: [] };
  const shown = ordered.slice(0, max);
  if (selected && !shown.includes(selected) && ordered.includes(selected))
    shown[max - 1] = selected;
  return { shown, more: ordered.filter((b) => !shown.includes(b)) };
}

// ───── 供应商页当前端点（设置 → 供应商 顶部的端点切换） ─────
const PROVIDER_ENDPOINT_KEY = 'ai-chat:providerEndpoint';
const providerEpSubs = new Set<Listener>();

/** 编程助手页的当前标签：四个端点之一，或「监视与会话」 */
export type CodingTab = ConversationBackend | 'monitor' | 'delegate';
export const isCodingTab = (v: unknown): v is CodingTab =>
  v === 'monitor' || v === 'delegate' || isConversationBackend(v);

export function getProviderEndpoint(): CodingTab {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'nomi';
    const v = window.localStorage.getItem(PROVIDER_ENDPOINT_KEY);
    return isCodingTab(v) ? v : 'nomi';
  } catch {
    return 'nomi';
  }
}

export function setProviderEndpoint(backend: CodingTab): void {
  write(PROVIDER_ENDPOINT_KEY, backend);
  providerEpSubs.forEach((fn) => fn());
}

export function subscribeProviderEndpoint(fn: Listener): () => void {
  providerEpSubs.add(fn);
  return () => void providerEpSubs.delete(fn);
}

/** 已下线功能留在本机的设置：启动时删掉，不留无主数据 */
const RETIRED_KEYS = [
  // 左上角常驻入口（及设置 → 通用 → 常驻入口）已删除
  'cd.chat.pins',
];

export function dropRetiredPrefs(): void {
  try {
    for (const k of RETIRED_KEYS) window.localStorage?.removeItem(k);
  } catch {
    /* 存储不可用：无需清理 */
  }
}
