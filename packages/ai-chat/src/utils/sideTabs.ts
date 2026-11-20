/**
 * 对话旁工作区标签状态：纯函数，便于单测。
 * - 每个会话一份：开着的子任务标签、当前标签、是否铺满（全屏）；
 * - 当前标签：'main'（铺满时的主会话标签）| 子任务键 | 工作区页键；文件 tabs 属于打开文件页内部
 *   | 子任务的键 | 工作区页（新标签页 / 变更 / 打开文件 / 侧边聊天 / 浏览器）；
 * - 铺满时主会话是第一个标签，不能关；没有任何子任务 / 文件 / 工作区页时自动回到分栏；
 * - 文件浏览（打开文件）和变更（Diff / git 状态）是两类独立标签，互不耦合开关；
 * - 标签可以拖动排序（order，主会话标签固定在最前）；铺满时可以「向右拆分」：左主会话、右当前标签；
 * - 弹出到独立窗口的标签（detached）由宿主记着，只在这一侧隐藏，窗口关掉后回到标签栏；
 * - 侧边聊天是工作区页，也进入顶层标签栏；内容只在内存里，重开应用后不恢复。
 * 语义见 docs/design/side-tabs-workspace.md。
 */

import { collectPaneIds, createRootPane, type TerminalPaneNode } from './terminalSplit';

export type SubagentTarget =
  | { kind: 'harness'; tabId: string }
  | { kind: 'nested'; callId: string; parentTabId: string | null }
  | { kind: 'nomi-task'; taskId: string }
  | { kind: 'side-chat'; chatId: string };

export const MAIN_SIDE_TAB = 'main';
export const FILES_SIDE_TAB = 'files';
export const CHANGES_SIDE_TAB = 'changes';
export const OPEN_FILE_SIDE_TAB = 'open-file';

export type WorkspacePage =
  | { kind: 'new-tab'; id: string }
  | { kind: 'changes' }
  | { kind: 'open-file' }
  | { kind: 'side-chat'; id: string }
  | { kind: 'browser'; id: string; url: string; title?: string }
  | {
      kind: 'terminal';
      id: string;
      cwd?: string;
      title?: string;
      shell?: string;
      layout?: TerminalPaneNode;
      activePaneId?: string;
    };

export interface SideTabsState {
  /** 开着的子任务（按打开顺序） */
  agents: SubagentTarget[];
  /** 工作区页：新标签页、变更、打开文件、侧边聊天、浏览器 */
  pages: WorkspacePage[];
  /** 右侧（标签区）当前看的：'files' | 子任务键 | 工作区页键；null = 跟着默认规则 */
  active: string | null;
  /** 标签区铺满整个对话区（主会话变成第一个标签） */
  maximized: boolean;
  /** 铺满时切到了主会话标签（回到分栏时右侧仍是 active） */
  mainActive: boolean;
  /** 拖动排过的标签顺序（子任务键 / 文件标签键）；不在里面的按打开顺序排在后面 */
  order: string[];
  /** 铺满时左右拆分：左边主会话，右边当前标签 */
  split: boolean;
  /** 拆分时主会话占的宽度比例（0.2–0.8） */
  splitRatio: number;
}

export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;
const ORDER_KEEP = 80;

export const EMPTY_SIDE_TABS: SideTabsState = {
  agents: [],
  pages: [],
  active: null,
  maximized: false,
  mainActive: false,
  order: [],
  split: false,
  splitRatio: 0.5,
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
    case 'side-chat':
      return `side-chat:${target.chatId}`;
  }
}

export const isSideChatKey = (key: string | null | undefined) => !!key?.startsWith('side-chat:');

export function newWorkspaceId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function pageKey(page: WorkspacePage): string {
  switch (page.kind) {
    case 'new-tab':
      return `new-tab:${page.id}`;
    case 'changes':
      return CHANGES_SIDE_TAB;
    case 'open-file':
      return OPEN_FILE_SIDE_TAB;
    case 'side-chat':
      return `side-chat:${page.id}`;
    case 'browser':
      return `browser:${page.id}`;
    case 'terminal':
      return `terminal:${page.id}`;
  }
}

export const isNewTabKey = (key: string | null | undefined) => !!key?.startsWith('new-tab:');
export const isBrowserKey = (key: string | null | undefined) => !!key?.startsWith('browser:');
export const isTerminalKey = (key: string | null | undefined) => !!key?.startsWith('terminal:');
export const isSideChatPageKey = (key: string | null | undefined) =>
  !!key?.startsWith('side-chat:');

export function isPageKey(key: string | null | undefined): boolean {
  return (
    key === CHANGES_SIDE_TAB ||
    key === OPEN_FILE_SIDE_TAB ||
    isNewTabKey(key) ||
    isBrowserKey(key) ||
    isTerminalKey(key) ||
    isSideChatPageKey(key)
  );
}

export function findPage(state: SideTabsState, key: string): WorkspacePage | undefined {
  return state.pages.find((p) => pageKey(p) === key);
}

/** 把 http(s) 地址或形如 example.com 的输入收成可打开的 URL；其它协议不要 */
export function parseBrowserUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!hasScheme) {
      // 没写协议时，要求看起来像主机名，避免把 README.md 这类文件名当成网址
      const hostPort = raw.split('/')[0] ?? '';
      const host = hostPort.split(':')[0] ?? '';
      const fileish =
        /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|go|rs|py|rb|java|kt|c|cc|cpp|h|hpp|vue|svelte|yml|yaml|toml|lock|map|svg|png|jpe?g|gif|webp|pdf|sh|bash|zsh)$/i;
      if (fileish.test(hostPort)) return null;
      if (host !== 'localhost' && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !host.includes('.'))
        return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

const dropPage = (state: SideTabsState, key: string): SideTabsState => {
  if (!state.pages.some((p) => pageKey(p) === key)) return state;
  return {
    ...state,
    pages: state.pages.filter((p) => pageKey(p) !== key),
    order: state.order.includes(key) ? state.order.filter((k) => k !== key) : state.order,
  };
};

/** 打开（或切到已开着的唯一）工作区页；replace = 用这个新标签页换掉（从新标签页点进去） */
export function openPage(
  state: SideTabsState,
  page: WorkspacePage,
  opts?: { replace?: string },
): SideTabsState {
  const key = pageKey(page);
  const unique = page.kind === 'changes' || page.kind === 'open-file';
  const exists = unique
    ? state.pages.some((p) => p.kind === page.kind)
    : state.pages.some((p) => pageKey(p) === key);
  let next: SideTabsState = exists
    ? {
        ...state,
        pages: unique ? state.pages.map((p) => (p.kind === page.kind ? page : p)) : state.pages,
        active: key,
        mainActive: false,
      }
    : { ...state, pages: [...state.pages, page], active: key, mainActive: false };
  const replace = opts?.replace;
  if (replace && isNewTabKey(replace) && replace !== key) {
    const after = dropPage(next, replace);
    if (next.active === replace) after.active = key;
    next = after;
  }
  return next;
}

export function openNewTab(state: SideTabsState, id = newWorkspaceId()): SideTabsState {
  return openPage(state, { kind: 'new-tab', id });
}

export function openChanges(state: SideTabsState, opts?: { replace?: string }): SideTabsState {
  return openPage(state, { kind: 'changes' }, opts);
}

export function openFileBrowser(state: SideTabsState, opts?: { replace?: string }): SideTabsState {
  return openPage(state, { kind: 'open-file' }, opts);
}

export function openSideChatPage(
  state: SideTabsState,
  chatId: string,
  opts?: { replace?: string },
): SideTabsState {
  return openPage(state, { kind: 'side-chat', id: chatId }, opts);
}

export function openBrowserTab(
  state: SideTabsState,
  url: string,
  opts?: { replace?: string; title?: string; id?: string },
): SideTabsState {
  const trimmed = url.trim();
  const href = trimmed === '' ? '' : parseBrowserUrl(trimmed);
  if (href === null) return state;
  if (href) {
    const existing = state.pages.find((p) => p.kind === 'browser' && p.url === href);
    if (existing) return openPage(state, existing, opts);
  }
  return openPage(
    state,
    { kind: 'browser', id: opts?.id ?? newWorkspaceId(), url: href, title: opts?.title },
    opts,
  );
}

export function setBrowserUrl(
  state: SideTabsState,
  key: string,
  url: string,
  title?: string,
): SideTabsState {
  const href = parseBrowserUrl(url);
  if (!href) return state;
  return {
    ...state,
    pages: state.pages.map((p) =>
      pageKey(p) === key && p.kind === 'browser' ? { ...p, url: href, title: title ?? p.title } : p,
    ),
  };
}

/** 打开一个新的内置终端标签（支持多开，且支持替换来源的新标签页） */
export function openTerminalTab(
  state: SideTabsState,
  opts?: { replace?: string; cwd?: string; title?: string; id?: string },
): SideTabsState {
  return openPage(
    state,
    { kind: 'terminal', id: opts?.id ?? newWorkspaceId(), cwd: opts?.cwd, title: opts?.title },
    opts,
  );
}

/** 更新终端标签记录的目录、标题或 shell */
export function setTerminalMeta(
  state: SideTabsState,
  key: string,
  patch: { cwd?: string; title?: string; shell?: string },
): SideTabsState {
  let changed = false;
  const pages = state.pages.map((p) => {
    if (pageKey(p) !== key || p.kind !== 'terminal') return p;
    const nextCwd = patch.cwd !== undefined ? patch.cwd : p.cwd;
    const nextTitle = patch.title !== undefined ? patch.title : p.title;
    const nextShell = patch.shell !== undefined ? patch.shell : p.shell;
    if (nextCwd === p.cwd && nextTitle === p.title && nextShell === p.shell) return p;
    changed = true;
    return { ...p, cwd: nextCwd, title: nextTitle, shell: nextShell };
  });
  return changed ? { ...state, pages } : state;
}

/** 取终端标签页当前有效的分屏二叉树（单窗格时自动构造以 page.id 为根的叶子节点） */
export function terminalLayoutOf(
  page: Extract<WorkspacePage, { kind: 'terminal' }>,
): TerminalPaneNode {
  return page.layout ?? createRootPane(page.id, page.cwd);
}

/** 取工作区页下所有分屏窗格 id；非终端页返回空数组 */
export function terminalPaneIds(page: WorkspacePage): string[] {
  if (page.kind !== 'terminal') return [];
  return collectPaneIds(terminalLayoutOf(page));
}

/** 更新终端标签的分屏树与当前聚焦窗格 id */
export function setTerminalLayout(
  state: SideTabsState,
  key: string,
  layout: TerminalPaneNode,
  activePaneId?: string,
): SideTabsState {
  let changed = false;
  const pages = state.pages.map((p) => {
    if (pageKey(p) !== key || p.kind !== 'terminal') return p;
    const nextActive = activePaneId !== undefined ? activePaneId : p.activePaneId;
    if (p.layout === layout && p.activePaneId === nextActive) return p;
    changed = true;
    return { ...p, layout, activePaneId: nextActive };
  });
  return changed ? { ...state, pages } : state;
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
  // 全屏时点主会话只显示主会话；退出拆分，避免右侧标签仍占据视图。
  if (key === MAIN_SIDE_TAB)
    return state.maximized ? { ...state, mainActive: true, split: false } : state;
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
  const order = state.order.includes(key) ? state.order.filter((k) => k !== key) : state.order;
  if (state.active !== key) return { ...state, agents, order };
  const next = agents[index] ?? agents[index - 1];
  return { ...state, agents, order, active: next ? agentKey(next) : null };
}

/**
 * 关掉一个工作区页。关的是当前标签时，切到旁边还开着的子任务 / 工作区页（有文件就交给 resolveActive）。
 */
export function closePage(state: SideTabsState, key: string): SideTabsState {
  const index = state.pages.findIndex((p) => pageKey(p) === key);
  if (index < 0) return state;
  const pages = state.pages.filter((_, i) => i !== index);
  const order = state.order.includes(key) ? state.order.filter((k) => k !== key) : state.order;
  if (state.active !== key) return { ...state, pages, order };
  const next = pages[index] ?? pages[index - 1];
  const fallback = next
    ? pageKey(next)
    : state.agents[state.agents.length - 1]
      ? agentKey(state.agents[state.agents.length - 1]!)
      : null;
  return { ...state, pages, order, active: fallback };
}

/** 关掉子任务或工作区页 */
export function closeSideTab(state: SideTabsState, key: string): SideTabsState {
  if (isPageKey(key) && state.pages.some((p) => pageKey(p) === key)) return closePage(state, key);
  return closeAgent(state, key);
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

/** 标签区里有没有东西（子任务、文件预览或工作区页） */
export function hasSideTabs(state: SideTabsState, hasFiles: boolean): boolean {
  return state.agents.length > 0 || hasFiles || state.pages.length > 0;
}

/** 实际显示的当前标签：铺满且切到主会话时是 'main'；记下的那个不在了就退回最后一个子任务 → 文件 → null */
export function resolveActive(state: SideTabsState, hasFiles: boolean): string | null {
  const { active } = state;
  if (state.mainActive && !state.split && isMaximized(state, hasFiles)) return MAIN_SIDE_TAB;
  if (active === FILES_SIDE_TAB && hasFiles) return FILES_SIDE_TAB;
  if (active && state.agents.some((a) => agentKey(a) === active)) return active;
  if (active && state.pages.some((p) => pageKey(p) === active)) return active;
  const last = state.agents[state.agents.length - 1];
  if (last) return agentKey(last);
  const lastPage = state.pages[state.pages.length - 1];
  if (lastPage) return pageKey(lastPage);
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
  // 拆分时双击右边的标签只是换右边看的内容；双击主会话 / 按还原才回到分栏
  if (state.maximized && state.split && key && key !== MAIN_SIDE_TAB)
    return { ...state, active: key, mainActive: false };
  if (state.maximized) return { ...state, maximized: false, mainActive: false, split: false };
  return {
    ...state,
    maximized: true,
    mainActive: false,
    active: key && key !== MAIN_SIDE_TAB ? key : state.active,
  };
}

/** 拆分只在铺满时成立 */
export function isSplit(state: SideTabsState, hasFiles: boolean): boolean {
  return state.split && isMaximized(state, hasFiles);
}

/**
 * 向右拆分 / 取消拆分。没铺满时先铺满再拆分（右边是 key 或当前标签）；
 * 取消拆分后仍是铺满，停在右边那个标签。
 */
export function toggleSplit(state: SideTabsState, key?: string): SideTabsState {
  const active = key && key !== MAIN_SIDE_TAB ? key : state.active;
  if (state.maximized && state.split) return { ...state, split: false, mainActive: false };
  return { ...state, maximized: true, split: true, mainActive: false, active };
}

export function setSplitRatio(state: SideTabsState, ratio: number): SideTabsState {
  if (!Number.isFinite(ratio)) return state;
  const next = Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
  return next === state.splitRatio ? state : { ...state, splitRatio: next };
}

export type SideTabKind =
  | 'main'
  | 'agent'
  | 'file'
  | 'new-tab'
  | 'changes'
  | 'open-file'
  | 'side-chat'
  | 'browser'
  | 'terminal';

export interface SideTabItem {
  key: string;
  kind: SideTabKind;
  closable: boolean;
  /** 文件标签：预览区里的条目键 */
  entryKey?: string;
  target?: SubagentTarget;
  page?: WorkspacePage;
}

/**
 * 标签栏的顺序：铺满时主会话第一个（不能关，不参与排序），其余按拖过的顺序；没排过的按打开顺序
 * （子任务在前，文件在后）。hidden：弹到独立窗口的标签（不在这一侧显示）。
 */
export function sideTabItems(
  state: SideTabsState,
  _fileKeys: readonly string[] = [],
  hidden?: ReadonlySet<string>,
): SideTabItem[] {
  const rest: SideTabItem[] = [];
  for (const target of state.agents)
    if (target.kind !== 'side-chat')
      rest.push({ key: agentKey(target), kind: 'agent', closable: true, target });
  for (const page of state.pages)
    rest.push({ key: pageKey(page), kind: page.kind, closable: true, page });
  const shown = hidden?.size ? rest.filter((i) => !hidden.has(i.key)) : rest;
  const rank = new Map(state.order.map((k, i) => [k, i]));
  const sorted = shown
    .map((item, i) => ({ item, r: rank.get(item.key) ?? state.order.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.item);
  return isMaximized(
    state,
    state.pages.some((p) => p.kind === 'open-file'),
  )
    ? [{ key: MAIN_SIDE_TAB, kind: 'main', closable: false }, ...sorted]
    : sorted;
}

/**
 * 拖动排序：把 key 挪到 toIndex（按现在标签栏里的下标算，主会话标签不能挪，也不能挪到它前面）。
 * 键盘：toIndex = 当前下标 ± 1。
 */
export function moveTab(
  state: SideTabsState,
  items: readonly SideTabItem[],
  key: string,
  toIndex: number,
): SideTabsState {
  if (key === MAIN_SIDE_TAB) return state;
  const pinned = items[0]?.kind === 'main' ? 1 : 0;
  const keys = items.slice(pinned).map((i) => i.key);
  const from = keys.indexOf(key);
  if (from < 0) return state;
  const to = Math.min(keys.length - 1, Math.max(0, toIndex - pinned));
  if (to === from) return state;
  keys.splice(from, 1);
  keys.splice(to, 0, key);
  // 不在这一侧显示的（弹出去的）保留原来的相对位置
  const shown = new Set(keys);
  const order = [...keys, ...state.order.filter((k) => !shown.has(k))].slice(0, ORDER_KEEP);
  return { ...state, order };
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

const isPage = (v: unknown): v is WorkspacePage => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'changes' || o.kind === 'open-file') return true;
  if (o.kind === 'side-chat') return typeof o.id === 'string' && !!o.id;
  if (o.kind === 'new-tab') return typeof o.id === 'string' && !!o.id;
  if (o.kind === 'browser') return typeof o.id === 'string' && !!o.id && typeof o.url === 'string';
  if (o.kind === 'terminal') return typeof o.id === 'string' && !!o.id;
  return false;
};

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
  // 侧边聊天和内置终端不跨应用重启恢复（避免重开应用拉起无效终端进程）。
  const pages = Array.isArray(o.pages)
    ? o.pages.filter(isPage).filter((p) => p.kind !== 'side-chat' && p.kind !== 'terminal')
    : [];
  const active = typeof o.active === 'string' ? o.active : null;
  const order = Array.isArray(o.order)
    ? o.order.filter((k): k is string => typeof k === 'string').slice(0, ORDER_KEEP)
    : [];
  const ratio = typeof o.splitRatio === 'number' ? o.splitRatio : 0.5;
  return {
    agents,
    pages,
    active,
    maximized: o.maximized === true,
    mainActive: o.mainActive === true,
    order,
    split: o.split === true,
    splitRatio: Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)),
  };
}

/** 去掉侧边聊天（落盘用） */
export function withoutSideChats(state: SideTabsState): SideTabsState {
  if (
    !state.agents.some((a) => a.kind === 'side-chat') &&
    !state.pages.some((p) => p.kind === 'side-chat')
  )
    return state;
  return {
    ...state,
    agents: state.agents.filter((a) => a.kind !== 'side-chat'),
    pages: state.pages.filter((p) => p.kind !== 'side-chat'),
    order: state.order.filter((k) => !isSideChatKey(k)),
    active: isSideChatKey(state.active) ? null : state.active,
  };
}

/** 去掉空的新标签页（落盘用；打开后再建即可） */
export function withoutNewTabs(state: SideTabsState): SideTabsState {
  if (!state.pages.some((p) => p.kind === 'new-tab')) return state;
  return {
    ...state,
    pages: state.pages.filter((p) => p.kind !== 'new-tab'),
    order: state.order.filter((k) => !isNewTabKey(k)),
    active: isNewTabKey(state.active) ? null : state.active,
  };
}

/** 去掉内置终端标签（落盘用；终端进程不跨应用重启存活） */
export function withoutTerminals(state: SideTabsState): SideTabsState {
  if (!state.pages.some((p) => p.kind === 'terminal')) return state;
  return {
    ...state,
    pages: state.pages.filter((p) => p.kind !== 'terminal'),
    order: state.order.filter((k) => !isTerminalKey(k)),
    active: isTerminalKey(state.active) ? null : state.active,
  };
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

/**
 * 写回本地存储：空的不记；超过上限时丢掉最早的（对象键按插入顺序，最近改的放最后）。
 * 侧边聊天不记（内容只在内存里，重开应用后没有可恢复的）。
 */
export function writeSideTabsStore(all: Record<string, SideTabsState>): void {
  try {
    const entries = Object.entries(all)
      .map(([scope, s]): [string, SideTabsState] => [
        scope,
        withoutTerminals(withoutNewTabs(withoutSideChats(s))),
      ])
      .filter(
        ([scope, s]) => !!scope && (s.agents.length > 0 || s.pages.length > 0 || s.maximized),
      );
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(-SIDE_TABS_KEEP))),
    );
  } catch {
    /* 无痕窗口等：只在本次有效 */
  }
}

/**
 * 拖到 over 标签上（after = 落在它的右半边）时，被拖的标签最后的下标（交给 moveTab）。
 * 落回原处时返回原下标（moveTab 不改）。
 */
export function dropIndex(
  items: readonly SideTabItem[],
  fromKey: string,
  overKey: string,
  after: boolean,
): number {
  const keys = items.map((i) => i.key);
  const from = keys.indexOf(fromKey);
  const over = keys.indexOf(overKey);
  if (from < 0 || over < 0) return Math.max(0, from);
  let to = over + (after ? 1 : 0);
  if (from < to) to -= 1;
  return to;
}
