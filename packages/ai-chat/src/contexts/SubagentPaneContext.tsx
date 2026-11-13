/**
 * 对话旁的标签区：子任务和文件预览共用一块，像浏览器的标签栏（见 docs/design/side-tabs-workspace.md）。
 * 子任务有三种会话，都走同一套面板：
 * - harness：委派出去的编程助手标签（完整输入栏，按标签 id 绑定）；
 * - nested：进程内子代理（Task / spawn_agent），步骤来自父转录；
 * - nomi-task：delegate_to_nomi 的后台 Nomi 任务；
 * - side-chat：侧边聊天（只问 Nomi 的临时聊天，内容在 services/sideChat 的内存里）。
 * 可以同时开好几个子任务标签；每个会话（主列的会话键）各记一份开着的标签、当前标签、是否铺满。
 * 文件标签来自预览区（App 的 useResourcePreview），这里只记「当前看的是文件」。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { detachedWindows, useDetachedIds } from '../services/detachedWindows';
import {
  addSideChatQuote,
  createSideChat,
  discardSideChat,
  importSideChat,
  sideChatState,
} from '../services/sideChat';
import { detachedKeysFor, parseDetachedId } from '../utils/detachedTabs';
import type { SelectionQuote } from '../utils/selectionQuote';
import {
  activateTab,
  agentKey,
  closeAgent,
  EMPTY_SIDE_TABS,
  isSideChatKey,
  moveTab,
  openAgent,
  pruneAgents,
  readSideTabsStore,
  resolveActive,
  setSplitRatio,
  toggleMaximized,
  toggleSplit,
  writeSideTabsStore,
  type SideTabItem,
  type SideTabsState,
  type SubagentTarget,
} from '../utils/sideTabs';

import { useHarnessTabs } from './HarnessTabsContext';

export type { SubagentTarget };

/** 标签上显示的名字和状态（由各子任务面板报上来） */
export interface SideTabMeta {
  name: string;
  state: 'running' | 'waiting' | 'idle';
}

interface SubagentPaneValue {
  /** 当前看的子任务；当前标签是文件 / 主会话或没开时为 null */
  target: SubagentTarget | null;
  /** 开着的子任务标签（按打开顺序） */
  targets: readonly SubagentTarget[];
  /** 当前会话的标签区状态（原始值） */
  tabs: SideTabsState;
  /** 实际的当前标签：'main' | 'files' | 子任务键 | null（见 resolveActive） */
  active: string | null;
  /** 预览区有没有开着的文件（App 同步进来） */
  filesOpen: boolean;
  setFilesOpen: (open: boolean) => void;
  /** harness 会话的标签 id（当前子任务是委派标签时）。会话详情的探针和旧调用用这个。 */
  tabId: string | null;
  openSubagent: (tabId: string) => void;
  openNested: (callId: string, parentTabId: string | null) => void;
  openNomiTask: (taskId: string) => void;
  /** 关掉当前子任务标签（不停子任务） */
  closeSubagent: () => void;
  /** 关掉某个子任务标签（不停子任务） */
  closeTab: (key: string) => void;
  /** 切换标签：子任务键 / 'files' / 'main'（铺满时） */
  activate: (key: string) => void;
  /** 双击标签：铺满 ↔ 分栏（key = 双击的那个标签） */
  toggleMaximized: (key?: string) => void;
  /** 退出铺满 */
  restore: () => void;
  /** 主列当前会话的键（App 同步进来）：标签区按会话各记一份 */
  setScope: (scope: string | null) => void;
  meta: Readonly<Record<string, SideTabMeta>>;
  reportMeta: (key: string, meta: SideTabMeta | null) => void;
  /** 当前会话键（'' = 没有会话 / 弹出窗口里，不落盘） */
  scope: string;
  /** 这个会话里弹到独立窗口的标签键（这一侧不显示，窗口关掉后回来） */
  detached: ReadonlySet<string>;
  /** 拖动 / 键盘排序（items = 现在标签栏里的标签） */
  moveTab: (items: readonly SideTabItem[], key: string, toIndex: number) => void;
  /** 铺满时向右拆分 / 取消拆分（key = 放到右边的标签） */
  toggleSplit: (key?: string) => void;
  setSplitRatio: (ratio: number) => void;
  /**
   * 侧边聊天：fresh = 新开一个（「+ 新侧边聊天」）；否则当前标签是侧边聊天时加到它上面，不是时新开。
   * quote：带到输入栏上的选区。返回聊天 id。
   */
  openSideChat: (opts?: { fresh?: boolean; quote?: SelectionQuote }) => string;
  /** 打开某个已有的侧边聊天标签（会话详情的列表、弹出窗口用） */
  openSideChatTab: (chatId: string) => void;
  /** 当前会话所属的项目（侧边聊天带上它，App 同步进来） */
  setProjectId: (projectId: string | null) => void;
}

const Ctx = createContext<SubagentPaneValue | null>(null);

export const SubagentPaneProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const harnessTabs = useHarnessTabs();
  const [scope, setScopeState] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  // 每个会话一份；只有真实会话（scope 非空）写本地存储，重开应用后恢复
  const [byScope, setByScope] = useState<Record<string, SideTabsState>>(readSideTabsStore);
  const [meta, setMeta] = useState<Record<string, SideTabMeta>>({});
  const [filesOpen, setFilesOpen] = useState(false);
  // 委派标签被关掉、来源标签没了：对应的子任务标签不再显示（读的时候滤掉，下次改动时一并落盘）。
  // 不切换主列的当前标签。
  const liveTabs = harnessTabs.state?.tabs;
  const alive = useMemo(() => {
    if (!liveTabs) return null;
    const ids = new Set(liveTabs.map((tab) => tab.id));
    return (a: SubagentTarget) =>
      a.kind === 'harness'
        ? ids.has(a.tabId)
        : a.kind === 'nested'
          ? a.parentTabId === null || ids.has(a.parentTabId)
          : true;
  }, [liveTabs]);
  const raw = byScope[scope] ?? EMPTY_SIDE_TABS;
  const detachedIds = useDetachedIds();
  const detached = useMemo(() => detachedKeysFor(detachedIds, scope), [detachedIds, scope]);
  // 显示用：去掉没了的和弹出去的（弹出去的仍记在本地存储里，窗口关掉后回到标签栏）
  const tabs = useMemo(
    () =>
      alive || detached.size
        ? pruneAgents(raw, (a) => (!alive || alive(a)) && !detached.has(agentKey(a)))
        : raw,
    [raw, alive, detached],
  );
  const active = resolveActive(tabs, filesOpen);

  const update = useCallback(
    (fn: (s: SideTabsState) => SideTabsState) =>
      setByScope((all) => {
        const stored = all[scope] ?? EMPTY_SIDE_TABS;
        const cur = alive ? pruneAgents(stored, alive) : stored;
        const next = fn(cur);
        if (next === stored) return all;
        // 最近改的放最后（超过上限时先丢最早的）
        const rest = { ...all };
        delete rest[scope];
        const out = { ...rest, [scope]: next };
        if (scope) writeSideTabsStore(out);
        return out;
      }),
    [scope, alive],
  );

  const shownTarget = useMemo(
    () => tabs.agents.find((a) => agentKey(a) === active) ?? null,
    [tabs.agents, active],
  );
  const tabId = shownTarget?.kind === 'harness' ? shownTarget.tabId : null;
  // 已经弹到独立窗口的：把那个窗口提到最前，不在这一侧再开一份
  const open = useCallback(
    (target: SubagentTarget) => {
      const key = agentKey(target);
      if (detached.has(key)) detachedWindows.focus(scope, key);
      else update((s) => openAgent(s, target));
    },
    [update, detached, scope],
  );
  const openSubagent = useCallback(
    (id: string) => {
      if (id) open({ kind: 'harness', tabId: id });
    },
    [open],
  );
  const openNested = useCallback(
    (callId: string, parentTabId: string | null) => {
      if (callId) open({ kind: 'nested', callId, parentTabId });
    },
    [open],
  );
  const openNomiTask = useCallback(
    (taskId: string) => {
      if (taskId) open({ kind: 'nomi-task', taskId });
    },
    [open],
  );
  const move = useCallback(
    (items: readonly SideTabItem[], key: string, toIndex: number) =>
      update((s) => moveTab(s, items, key, toIndex)),
    [update],
  );
  const split = useCallback((key?: string) => update((s) => toggleSplit(s, key)), [update]);
  const ratio = useCallback((r: number) => update((s) => setSplitRatio(s, r)), [update]);
  // 关掉侧边聊天标签：聊天内容一并丢掉（它本来就是临时的）
  const closeTab = useCallback(
    (key: string) => {
      if (isSideChatKey(key)) discardSideChat(key.slice('side-chat:'.length));
      update((s) => closeAgent(s, key));
    },
    [update],
  );
  const closeSubagent = useCallback(() => {
    if (active) closeTab(active);
  }, [closeTab, active]);
  const openSideChatTab = useCallback(
    (chatId: string) => open({ kind: 'side-chat', chatId }),
    [open],
  );
  const openSideChat = useCallback(
    (opts: { fresh?: boolean; quote?: SelectionQuote } = {}) => {
      const current = isSideChatKey(active) ? active!.slice('side-chat:'.length) : null;
      if (!opts.fresh && current && sideChatState(current)) {
        if (opts.quote) addSideChatQuote(current, opts.quote);
        update((s) => activateTab(s, active!));
        return current;
      }
      const id = createSideChat(scope, { projectId, quote: opts.quote });
      open({ kind: 'side-chat', chatId: id });
      return id;
    },
    [active, update, open, scope, projectId],
  );
  // 弹出去的侧边聊天回来了（窗口关掉 / 放回）：收下那个窗口交接的内容；没有内容（窗口里关掉了）就关标签。
  // 按宿主的整份 id 列表比较（切换会话不算「回来」）
  const prevIds = useRef(detachedIds);
  useEffect(() => {
    const before = prevIds.current;
    prevIds.current = detachedIds;
    if (before === detachedIds) return;
    const now = new Set(detachedIds);
    for (const id of before) {
      const p = now.has(id) ? null : parseDetachedId(id);
      if (!p || !isSideChatKey(p.key)) continue;
      const chatId = p.key.slice('side-chat:'.length);
      void detachedWindows.take(id).then((data) => {
        if (importSideChat(data) || sideChatState(chatId)) return;
        setByScope((all) => {
          const cur = all[p.scope];
          if (!cur) return all;
          const next = closeAgent(cur, p.key);
          return next === cur ? all : { ...all, [p.scope]: next };
        });
      });
    }
  }, [detachedIds]);
  const activate = useCallback((key: string) => update((s) => activateTab(s, key)), [update]);
  const toggle = useCallback((key?: string) => update((s) => toggleMaximized(s, key)), [update]);
  const restore = useCallback(
    () => update((s) => (s.maximized ? toggleMaximized(s) : s)),
    [update],
  );
  const setScope = useCallback((next: string | null) => setScopeState(next ?? ''), []);
  const reportMeta = useCallback((key: string, value: SideTabMeta | null) => {
    setMeta((cur) => {
      const old = cur[key];
      if (!value) {
        if (!old) return cur;
        const rest = { ...cur };
        delete rest[key];
        return rest;
      }
      if (old && old.name === value.name && old.state === value.state) return cur;
      return { ...cur, [key]: value };
    });
  }, []);

  const value = useMemo(
    () => ({
      target: shownTarget,
      targets: tabs.agents,
      tabs,
      active,
      filesOpen,
      setFilesOpen,
      tabId,
      openSubagent,
      openNested,
      openNomiTask,
      closeSubagent,
      closeTab,
      activate,
      toggleMaximized: toggle,
      restore,
      setScope,
      meta,
      reportMeta,
      scope,
      detached,
      moveTab: move,
      toggleSplit: split,
      setSplitRatio: ratio,
      openSideChat,
      openSideChatTab,
      setProjectId,
    }),
    [
      openSideChat,
      openSideChatTab,
      scope,
      detached,
      move,
      split,
      ratio,
      shownTarget,
      tabs,
      active,
      filesOpen,
      setFilesOpen,
      tabId,
      openSubagent,
      openNested,
      openNomiTask,
      closeSubagent,
      closeTab,
      activate,
      toggle,
      restore,
      setScope,
      meta,
      reportMeta,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/** 没有 Provider（单测 / 别的窗口）时返回 null：调用方退回原来的抽屉 */
export function useSubagentPane(): SubagentPaneValue | null {
  return useContext(Ctx);
}
