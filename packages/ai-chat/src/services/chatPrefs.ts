/**
 * 对话 UI 偏好：普通/开发模式、侧栏「全部|按端」。
 * 持久化在 localStorage（与 ConversationStore 同层）；桌面端无需主进程同步。
 */
export type ChatMode = 'normal' | 'dev';
export type ConversationListView = 'all' | 'by-endpoint';

const MODE_KEY = 'ai-chat:chatMode';
const LIST_VIEW_KEY = 'ai-chat:conversationListView';
const ENDPOINT_FILTER_KEY = 'ai-chat:endpointFilter';

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

// ───── 供应商页当前端点（设置 → 供应商 顶部的端点切换） ─────
const PROVIDER_ENDPOINT_KEY = 'ai-chat:providerEndpoint';
const providerEpSubs = new Set<Listener>();

/** 编程助手页的当前标签：四个端点之一，或「监视与会话」 */
export type CodingTab = ConversationBackend | 'monitor';
export const isCodingTab = (v: unknown): v is CodingTab =>
  v === 'monitor' || isConversationBackend(v);

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
