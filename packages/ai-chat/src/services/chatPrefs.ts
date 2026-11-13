/**
 * 对话 UI 偏好：界面形态（normal = 没装编程助手，dev = 装了；由 services/cliPresence 写入，用户不手动切换）、
 * 侧栏「全部|按端」、新对话是否用模型起标题。
 * 持久化在 localStorage（与 ConversationStore 同层）；桌面端无需主进程同步。
 */
export type ChatMode = 'normal' | 'dev';
export type ConversationListView = 'all' | 'by-endpoint';

const MODE_KEY = 'ai-chat:chatMode';
const LIST_VIEW_KEY = 'ai-chat:conversationListView';
const ENDPOINT_FILTER_KEY = 'ai-chat:endpointFilter';
const SMART_TITLE_KEY = 'ai-chat:smartTitle';

type Listener = () => void;
const modeSubs = new Set<Listener>();
const listSubs = new Set<Listener>();

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
 * 没有显式设置的端点，本机装了或有对话（含标签 / 磁盘历史）就显示。
 */
export function visibleEndpoints(
  all: readonly ConversationBackend[],
  vis: EndpointVisibilityMap,
  activity: Partial<Record<ConversationBackend, number>>,
  installed: (b: ConversationBackend) => boolean = () => false,
): ConversationBackend[] {
  return all.filter((b) => {
    if (b === 'nomi') return true;
    const v = vis[b];
    if (v === 'show') return true;
    if (v === 'hide') return false;
    return installed(b) || (activity[b] ?? 0) > 0;
  });
}

// ───── 侧栏按工作区分组 ─────
const WORKSPACE_GROUP_KEY = 'ai-chat:groupByWorkspace';
const WORKSPACE_COLLAPSED_KEY = 'ai-chat:collapsedWorkspaces';

/** 侧栏会话是否按工作区分组（默认开） */
export function getGroupByWorkspace(): boolean {
  return read(WORKSPACE_GROUP_KEY, ['on', 'off'] as const, 'on') === 'on';
}

export function setGroupByWorkspace(on: boolean): void {
  write(WORKSPACE_GROUP_KEY, on ? 'on' : 'off');
  listSubs.forEach((fn) => fn());
}

let collapsedCache: { raw: string | null; value: readonly string[] } = { raw: null, value: [] };

/** 折叠起来的工作区（分组键） */
export function getCollapsedWorkspaces(): readonly string[] {
  let raw: string | null = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      raw = window.localStorage.getItem(WORKSPACE_COLLAPSED_KEY);
  } catch {
    raw = null;
  }
  if (raw === collapsedCache.raw) return collapsedCache.value;
  let value: string[] = [];
  try {
    const a = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(a)) value = a.filter((k): k is string => typeof k === 'string');
  } catch {
    value = []; // 损坏的值按「全部展开」处理
  }
  collapsedCache = { raw, value };
  return value;
}

export function setWorkspaceCollapsed(key: string, collapsed: boolean): void {
  const cur = getCollapsedWorkspaces().filter((k) => k !== key);
  // 只留最近的 200 个，免得删掉的目录一直堆在里面
  const next = collapsed ? [...cur, key].slice(-200) : cur;
  write(WORKSPACE_COLLAPSED_KEY, JSON.stringify(next));
  listSubs.forEach((fn) => fn());
}

// ───── 侧栏端点的排列顺序 ─────
const ENDPOINT_ORDER_KEY = 'ai-chat:sidebarEndpointOrder';

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

// ───── 供应商页当前端点（设置 → 供应商 顶部的端点切换） ─────
const PROVIDER_ENDPOINT_KEY = 'ai-chat:providerEndpoint';
const providerEpSubs = new Set<Listener>();

/** 编程助手页的当前标签：内置编程助手端点之一，或「监视与会话」 */
/** general = 运行环境与权限（编程助手页左栏）；旧版本存的 external（外部 CLI）不再认，回到默认 */
export type CodingTab = ConversationBackend | 'monitor' | 'delegate' | 'general';
export const isCodingTab = (v: unknown): v is CodingTab =>
  v === 'monitor' || v === 'delegate' || v === 'general' || isConversationBackend(v);

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

const smartTitleSubs = new Set<Listener>();

/**
 * 新对话用当前聊天模型起标题（默认开）：会把第一条消息再发给模型一次、消耗少量 token。
 * 关掉后用第一句话作标题，不额外请求。
 */
export function getSmartTitle(): boolean {
  return read(SMART_TITLE_KEY, ['on', 'off'] as const, 'on') === 'on';
}

export function setSmartTitle(on: boolean): void {
  write(SMART_TITLE_KEY, on ? 'on' : 'off');
  smartTitleSubs.forEach((fn) => fn());
}

export function subscribeSmartTitle(fn: Listener): () => void {
  smartTitleSubs.add(fn);
  return () => void smartTitleSubs.delete(fn);
}
