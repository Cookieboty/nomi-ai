/**
 * 对话旁的标签区（子任务 + 文件预览共用一块）：纯函数，便于单测。
 * - 每个会话一份：开着的子任务标签、当前标签、是否铺满（全屏）；
 * - 当前标签：'main'（铺满时的主会话标签）| 'files'（文件预览，具体哪个文件由预览区自己记）| 子任务的键；
 * - 铺满时主会话是第一个标签，不能关；没有任何子任务 / 文件标签时自动回到分栏。
 * 语义见 docs/design/side-tabs-workspace.md。
 */

export type SubagentTarget =
  | { kind: 'harness'; tabId: string }
  | { kind: 'nested'; callId: string; parentTabId: string | null }
  | { kind: 'nomi-task'; taskId: string };

export const MAIN_SIDE_TAB = 'main';
export const FILES_SIDE_TAB = 'files';

export interface SideTabsState {
  /** 开着的子任务（按打开顺序） */
  agents: SubagentTarget[];
  /** 右侧（标签区）当前看的：'files' | 子任务键；null = 跟着默认规则 */
  active: string | null;
  /** 标签区铺满整个对话区（主会话变成第一个标签） */
  maximized: boolean;
  /** 铺满时切到了主会话标签（回到分栏时右侧仍是 active） */
  mainActive: boolean;
}

export const EMPTY_SIDE_TABS: SideTabsState = {
  agents: [],
  active: null,
  maximized: false,
  mainActive: false,
};

/** 子任务在标签区里的键（同一个子任务只开一个标签） */
export function agentKey(target: SubagentTarget): string {
  switch (target.kind) {
    case 'harness':
      return `harness:${target.tabId}`;
    case 'nested':
      return `nested:${target.callId}`;
    case 'nomi-task':
      return `nomi-task:${target.taskId}`;
  }
}

/** 打开（或切到已开着的）子任务标签 */
export function openAgent(state: SideTabsState, target: SubagentTarget): SideTabsState {
  const key = agentKey(target);
  const exists = state.agents.some((a) => agentKey(a) === key);
  return {
    ...state,
    agents: exists
      ? state.agents.map((a) => (agentKey(a) === key ? target : a))
      : [...state.agents, target],
    active: key,
    mainActive: false,
  };
}

/** 切换标签：'main' 只在铺满时有意义 */
export function activateTab(state: SideTabsState, key: string): SideTabsState {
  if (key === MAIN_SIDE_TAB) return state.maximized ? { ...state, mainActive: true } : state;
  return { ...state, active: key, mainActive: false };
}

/**
 * 关掉一个子任务标签（不停子任务）。关的是当前标签时，切到右边的邻居，没有就左边的；
 * 都没有时交给 resolveActive（有文件就看文件）。
 */
export function closeAgent(state: SideTabsState, key: string): SideTabsState {
  const index = state.agents.findIndex((a) => agentKey(a) === key);
  if (index < 0) return state;
  const agents = state.agents.filter((_, i) => i !== index);
  if (state.active !== key) return { ...state, agents };
  const next = agents[index] ?? agents[index - 1];
  return { ...state, agents, active: next ? agentKey(next) : null };
}

/** 只留下还在的子任务（委派标签被关掉、来源标签没了） */
export function pruneAgents(
  state: SideTabsState,
  keep: (target: SubagentTarget) => boolean,
): SideTabsState {
  const agents = state.agents.filter(keep);
  if (agents.length === state.agents.length) return state;
  let next: SideTabsState = { ...state, agents };
  for (const gone of state.agents.filter((a) => !keep(a))) {
    if (state.active === agentKey(gone)) next = { ...next, active: null };
  }
  return next;
}

/** 标签区里有没有东西（子任务或文件） */
export function hasSideTabs(state: SideTabsState, hasFiles: boolean): boolean {
  return state.agents.length > 0 || hasFiles;
}

/** 实际显示的当前标签：铺满且切到主会话时是 'main'；记下的那个不在了就退回最后一个子任务 → 文件 → null */
export function resolveActive(state: SideTabsState, hasFiles: boolean): string | null {
  const { active } = state;
  if (state.mainActive && isMaximized(state, hasFiles)) return MAIN_SIDE_TAB;
  if (active === FILES_SIDE_TAB && hasFiles) return FILES_SIDE_TAB;
  if (active && state.agents.some((a) => agentKey(a) === active)) return active;
  const last = state.agents[state.agents.length - 1];
  if (last) return agentKey(last);
  return hasFiles ? FILES_SIDE_TAB : null;
}

/** 铺满只在标签区有东西时成立：最后一个标签关掉后自动回到分栏 */
export function isMaximized(state: SideTabsState, hasFiles: boolean): boolean {
  return state.maximized && hasSideTabs(state, hasFiles);
}

/**
 * 双击标签：铺满 ↔ 分栏。铺满时停在双击的那个标签；铺满时双击任何标签（包括主会话）回到分栏，
 * 右侧仍是之前看的那个子任务 / 文件（主会话标签只在铺满时存在）。
 */
export function toggleMaximized(state: SideTabsState, key?: string): SideTabsState {
  if (state.maximized) return { ...state, maximized: false, mainActive: false };
  return {
    ...state,
    maximized: true,
    mainActive: false,
    active: key && key !== MAIN_SIDE_TAB ? key : state.active,
  };
}

export interface SideTabItem {
  key: string;
  kind: 'main' | 'agent' | 'file';
  closable: boolean;
  /** 文件标签：预览区里的条目键 */
  entryKey?: string;
  target?: SubagentTarget;
}

/** 标签栏的顺序：铺满时主会话第一个（不能关），然后是子任务，最后是文件 */
export function sideTabItems(state: SideTabsState, fileKeys: readonly string[]): SideTabItem[] {
  const items: SideTabItem[] = [];
  if (isMaximized(state, fileKeys.length > 0))
    items.push({ key: MAIN_SIDE_TAB, kind: 'main', closable: false });
  for (const target of state.agents)
    items.push({ key: agentKey(target), kind: 'agent', closable: true, target });
  for (const entryKey of fileKeys)
    items.push({ key: fileTabKey(entryKey), kind: 'file', closable: true, entryKey });
  return items;
}

export const fileTabKey = (entryKey: string) => `file:${entryKey}`;

/** Ctrl+Tab：在标签栏里循环（文件标签各算一个） */
export function cycleTabKey(
  items: readonly SideTabItem[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (!items.length) return null;
  const index = current ? items.findIndex((i) => i.key === current) : -1;
  const next = (index + dir + items.length) % items.length;
  return items[next < 0 ? 0 : next]!.key;
}

const isTarget = (v: unknown): v is SubagentTarget => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'harness') return typeof o.tabId === 'string' && !!o.tabId;
  if (o.kind === 'nomi-task') return typeof o.taskId === 'string' && !!o.taskId;
  if (o.kind === 'nested')
    return (
      typeof o.callId === 'string' &&
      !!o.callId &&
      (o.parentTabId === null || typeof o.parentTabId === 'string')
    );
  return false;
};

/** 从本地存储读回来的一份：坏数据丢掉 */
export function parseSideTabs(v: unknown): SideTabsState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const agents = Array.isArray(o.agents) ? o.agents.filter(isTarget) : [];
  const active = typeof o.active === 'string' ? o.active : null;
  return { agents, active, maximized: o.maximized === true, mainActive: o.mainActive === true };
}

const STORE_KEY = 'nomi.sideTabs.v1';
/** 只记最近这么多个会话 */
export const SIDE_TABS_KEEP = 40;

export function readSideTabsStore(): Record<string, SideTabsState> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, unknown>;
    const out: Record<string, SideTabsState> = {};
    for (const [scope, value] of Object.entries(raw ?? {})) {
      const parsed = parseSideTabs(value);
      if (parsed) out[scope] = parsed;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写回本地存储：空的不记；超过上限时丢掉最早的（对象键按插入顺序，最近改的放最后） */
export function writeSideTabsStore(all: Record<string, SideTabsState>): void {
  try {
    const entries = Object.entries(all).filter(
      ([scope, s]) => !!scope && (s.agents.length > 0 || s.maximized),
    );
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(-SIDE_TABS_KEEP))),
    );
  } catch {
    /* 无痕窗口等：只在本次有效 */
  }
}
