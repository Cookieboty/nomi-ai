/**
 * 对话旁的工作区：子任务和工作区页使用顶层标签栏，文件 tabs 保留在打开文件页内部
 * （见 docs/design/side-tabs-workspace.md）。
 * 子任务有三种会话，都走同一套面板：
 * - harness：委派出去的 agent 标签（完整输入栏，按标签 id 绑定）；
 * - nested：进程内子代理（Task / spawn_agent），步骤来自父转录；
 * - nomi-task：delegate_to_nomi 的后台 Nomi 任务；
 * - side-chat：侧边聊天（只问 Nomi 的临时聊天，内容在 services/sideChat 的内存里），作为工作区标签打开。
 * 可以同时开好几个子任务标签；每个会话（主列的会话键）各记一份开着的标签、当前标签、是否铺满。
 * 文件标签来自预览区（App 的 useResourcePreview），这里只记「当前看的是文件」。
 */
import { t } from '@nomi-ai/ui';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { confirmDialog } from '../components/ConfirmDialog';
import {
  CONVERSATIONS_CHANGED_EVENT,
  type ConversationsChangedDetail,
} from '../services/conversationStore';
import { detachedWindows, useDetachedIds } from '../services/detachedWindows';
import {
  addSideChatQuote,
  createSideChat,
  discardSideChat,
  importSideChat,
  importSideChatDraft,
  migrateSideChatsScope,
  sideChatState,
} from '../services/sideChat';
import {
  isSideTabsPaneVisible,
  persistSideTabsPanePref,
  panePrefWhenEmpty,
  type SideTabsPanePref,
} from '../services/sideTabsPanePrefs';
import {
  countRunningTerminals,
  sideTerminalHost,
  sideTerminalIdFor,
  syncLiveTerminals,
} from '../services/sideTerminal';
import {
  discardSideTrace,
  discardSideTracesInScope,
  migrateSideTracesScope,
  registerSideTrace,
  type SideTraceSpec,
} from '../services/sideTrace';
import { cliTranscriptKey } from '../services/transcriptView';
import { detachedKeysFor, parseDetachedId } from '../utils/detachedTabs';
import type { SelectionQuote } from '../utils/selectionQuote';
import {
  activateTab,
  agentKey,
  closeSideTab,
  EMPTY_SIDE_TABS,
  findPage,
  hasSideTabs,
  isSideChatKey,
  isTerminalKey,
  isTraceKey,
  moveTab,
  newWorkspaceId,
  OPEN_FILE_SIDE_TAB,
  openAgent,
  openBrowserTab,
  openChanges,
  openFileBrowser,
  openNewTab,
  openSideChatPage,
  openTerminalTab,
  openTraceTab,
  pageKey,
  pruneAgents,
  readSideTabsStore,
  resolveActive,
  setBrowserUrl as setBrowserUrlState,
  setSplitRatio,
  setTerminalLayout as setTerminalLayoutState,
  setTerminalMeta as setTerminalMetaState,
  terminalPaneIds,
  toggleMaximized,
  toggleSplit,
  writeSideTabsStore,
  type SideTabItem,
  type SideTabsState,
  type SubagentTarget,
  type WorkspacePage,
} from '../utils/sideTabs';
import type { TerminalPaneNode } from '../utils/terminalSplit';

import { useHarnessTabs } from './HarnessTabsContext';

export type { SideTraceSpec, SubagentTarget };

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
  /** agent 新标签拿到会话 id 后，将临时标签键上的工作区标签平滑迁移到稳定会话键 */
  migrateScope: (fromScope: string, toScope: string) => void;
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
  openSideChat: (opts?: { fresh?: boolean; quote?: SelectionQuote; replace?: string }) => string;
  /** 打开某个已有的侧边聊天标签（会话详情的列表、弹出窗口用） */
  openSideChatTab: (chatId: string) => void;
  /** 当前会话所属的项目（侧边聊天带上它，App 同步进来） */
  setProjectId: (projectId: string | null) => void;
  /** 工作区页（新标签页 / 变更 / 打开文件 / 浏览器） */
  pages: readonly WorkspacePage[];
  /** 标签区整栏是否显示（隐藏时保留标签状态） */
  paneVisible: boolean;
  panePref: SideTabsPanePref;
  showPane: () => void;
  hidePane: () => void;
  togglePane: () => void;
  /** 打开一个新标签页（标签栏「+」） */
  openNewTab: () => string;
  /** 打开（或切到已开着的）变更标签 */
  openChanges: (opts?: { replace?: string }) => void;
  /** 打开（或切到已开着的）打开文件标签 */
  openFileBrowser: (opts?: { replace?: string }) => void;
  /** 打开浏览器标签（同一 URL 已开着则切过去） */
  openBrowser: (url: string, opts?: { replace?: string; title?: string }) => void;
  setBrowserUrl: (key: string, url: string, title?: string) => void;
  /** 新建内置终端标签（支持多开与替换来源的新标签页） */
  openTerminal: (opts?: { replace?: string; cwd?: string; title?: string }) => string;
  /** 展开右侧工作区并切到已存在的内置终端标签 */
  focusTerminal: (pageId: string) => void;
  /** 关闭终端标签（若仍有运行中的分屏进程，先弹应用内确认框） */
  requestCloseTerminal: (key: string) => Promise<boolean>;
  setTerminalMeta: (key: string, patch: { cwd?: string; title?: string; shell?: string }) => void;
  setTerminalLayout: (key: string, layout: TerminalPaneNode, activePaneId?: string) => void;
  /** 当前窗口是否存在活跃且未被整页遮挡的工作区 Tabs 宿主 */
  hasHost: boolean;
  /** SideWorkspace 挂载期注册为宿主（返回注销函数） */
  registerHost: () => () => void;
  /** App 在设置页或整页看板盖住会话时暂时挂起宿主标记 */
  setHostSuspended: (suspended: boolean) => void;
  /** 在工作区 Tabs 中打开（或复用同 dedupeKey 的）运行轨迹标签 */
  openTrace: (
    spec: SideTraceSpec,
    opts?: { dedupeKey?: string; replace?: string; title?: string },
  ) => string;
}

const Ctx = createContext<SubagentPaneValue | null>(null);
const EMPTY_DETACHED: ReadonlySet<string> = new Set();

export const SubagentPaneProvider: React.FC<{
  scope?: string | null;
  detached?: boolean;
  /** 局部隔离模式（如任务详情抽屉）：不读写全局 localStorage、不接管独立窗口或宿主终端 */
  isolated?: boolean;
  children: React.ReactNode;
}> = ({ scope: propScope, detached: isDetached = false, isolated = false, children }) => {
  const skipDetachedHost = isDetached || isolated;
  const harnessTabs = useHarnessTabs();
  const [scopeState, setScopeState] = useState('');
  const scope = propScope !== undefined ? (propScope ?? '') : scopeState;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const settledDocksRef = useRef(new Set<string>());
  /** 已经按快照收下过的侧边聊天放回（id → 传输 id）：别的窗口迟到的确认带的是同一份，不能把更新的草稿盖回去 */
  const adoptedDocksRef = useRef(new Map<string, string>());
  const [projectId, setProjectId] = useState<string | null>(null);
  // 每个会话一份；只有真实会话（scope 非空）写本地存储，重开应用后恢复（隔离模式只存组件内内存）
  const [byScope, setByScope] = useState<Record<string, SideTabsState>>(() =>
    isolated ? {} : readSideTabsStore(),
  );
  const byScopeRef = useRef(byScope);
  useEffect(() => {
    byScopeRef.current = byScope;
  });
  const [meta, setMeta] = useState<Record<string, SideTabMeta>>({});
  const [filesOpenByScope, setFilesOpenByScope] = useState<Record<string, boolean>>({});
  const filesOpen = filesOpenByScope[scope] ?? false;
  const setFilesOpen = useCallback(
    (open: boolean) => {
      setFilesOpenByScope((cur) => {
        const prev = cur[scope] ?? false;
        if (prev === open) return cur;
        if (!open) {
          if (!(scope in cur)) return cur;
          const rest = { ...cur };
          delete rest[scope];
          return rest;
        }
        return { ...cur, [scope]: true };
      });
    },
    [scope],
  );
  // 面板显隐偏好按会话隔离：切换会话时跟随新会话自己的标签状态（默认 'auto'），不把上一个会话的展开/收起强加给新会话
  const [panePrefByScope, setPanePrefByScope] = useState<Record<string, SideTabsPanePref>>({});
  const panePref: SideTabsPanePref = panePrefByScope[scope] ?? 'auto';
  const setPanePref = useCallback(
    (pref: SideTabsPanePref) => {
      setPanePrefByScope((cur) => {
        const prev = cur[scope] ?? 'auto';
        if (prev === pref) return cur;
        if (pref === 'auto') {
          if (!(scope in cur)) return cur;
          const rest = { ...cur };
          delete rest[scope];
          return rest;
        }
        return { ...cur, [scope]: pref };
      });
      if (!isolated) persistSideTabsPanePref(pref);
    },
    [scope, isolated],
  );
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
  const detachedIds = useDetachedIds(!skipDetachedHost);
  const detached = useMemo(
    () => (skipDetachedHost ? EMPTY_DETACHED : detachedKeysFor(detachedIds, scope)),
    [skipDetachedHost, detachedIds, scope],
  );
  // 显示用：去掉没了的和弹出去的（弹出去的仍记在本地存储里，窗口关掉后回到标签栏）
  const tabs = useMemo(() => {
    const prunedAgents =
      alive || detached.size
        ? pruneAgents(raw, (a) => (!alive || alive(a)) && !detached.has(agentKey(a)))
        : raw;
    if (!detached.size) return prunedAgents;
    const pages = prunedAgents.pages.filter(
      (p) => !(p.kind === 'side-chat' && detached.has(pageKey(p))),
    );
    if (pages.length === prunedAgents.pages.length) return prunedAgents;
    const nextActive =
      prunedAgents.active && detached.has(prunedAgents.active) ? null : prunedAgents.active;
    return { ...prunedAgents, pages, active: nextActive };
  }, [raw, alive, detached]);
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
        if (scope && !isolated) writeSideTabsStore(out);
        return out;
      }),
    [scope, alive, isolated],
  );

  const shownTarget = useMemo(() => {
    const agent = tabs.agents.find((a) => agentKey(a) === active);
    if (agent) return agent;
    const page = tabs.pages.find((p) => p.kind === 'side-chat' && pageKey(p) === active);
    return page?.kind === 'side-chat' ? ({ kind: 'side-chat', chatId: page.id } as const) : null;
  }, [tabs.agents, tabs.pages, active]);
  const tabId = shownTarget?.kind === 'harness' ? shownTarget.tabId : null;
  // 已经弹到独立窗口的：把那个窗口提到最前，不在这一侧再开一份
  const revealPane = useCallback(() => {
    setPanePrefByScope((cur) => {
      if (cur[scope] === 'closed') {
        if (!isolated) persistSideTabsPanePref('open');
        return { ...cur, [scope]: 'open' };
      }
      return cur;
    });
  }, [scope, isolated]);
  const open = useCallback(
    (target: SubagentTarget) => {
      const key = agentKey(target);
      if (detached.has(key)) detachedWindows.focus(scope, key);
      else {
        revealPane();
        update((s) => openAgent(s, target));
      }
    },
    [update, detached, scope, revealPane],
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
  // 关掉侧边聊天标签：聊天内容一并丢掉（它本来就是临时的）；关掉终端标签：通知宿主结束该标签下全部分屏 PTY；关掉轨迹标签：释放内存载荷
  const closeTab = useCallback(
    (key: string) => {
      if (isSideChatKey(key)) discardSideChat(key.slice('side-chat:'.length));
      if (isTraceKey(key)) discardSideTrace(key.slice('trace:'.length));
      if (isTerminalKey(key)) {
        const curState = byScopeRef.current[scope] ?? EMPTY_SIDE_TABS;
        const page = findPage(curState, key);
        const paneIds = page ? terminalPaneIds(page) : [key.slice('terminal:'.length)];
        for (const pid of paneIds) {
          sideTerminalHost.close(sideTerminalIdFor(pid));
        }
      }
      // 关闭打开文件页时其内部预览文件一并清空，不应受同一渲染帧尚未刷新的 filesOpen=true 阻塞收起
      const nextFilesOpen = key === OPEN_FILE_SIDE_TAB ? false : filesOpen;
      if (key === OPEN_FILE_SIDE_TAB && filesOpen) setFilesOpen(false);
      update((s) => {
        let next = closeSideTab(s, key);
        if (!hasSideTabs(next, nextFilesOpen)) {
          next = { ...next, maximized: false, mainActive: false, split: false };
          if (panePrefWhenEmpty(panePref, 'close-last-tab') === 'auto') {
            setPanePref('auto');
          }
        }
        return next;
      });
    },
    [update, panePref, filesOpen, setFilesOpen, setPanePref, scope],
  );
  const closeSubagent = useCallback(() => {
    if (active) closeTab(active);
  }, [closeTab, active]);
  const closingTerminalsRef = useRef<Set<string>>(new Set());
  const requestCloseTerminal = useCallback(
    async (key: string): Promise<boolean> => {
      const tabKey = isTerminalKey(key) ? key : `terminal:${key}`;
      if (closingTerminalsRef.current.has(tabKey)) return false;
      const curState = byScopeRef.current[scope] ?? EMPTY_SIDE_TABS;
      const page = findPage(curState, tabKey);
      if (!page || page.kind !== 'terminal') return false;
      const paneIds = terminalPaneIds(page);
      const runningCount = countRunningTerminals(paneIds.map(sideTerminalIdFor));
      if (runningCount <= 0) {
        closeTab(tabKey);
        return true;
      }
      closingTerminalsRef.current.add(tabKey);
      try {
        const ok = await confirmDialog({
          title: t('ui.session-workspace.terminal-close-confirm-title'),
          message:
            runningCount === 1
              ? t('ui.session-workspace.terminal-close-confirm-message')
              : t('ui.session-workspace.terminal-close-confirm-message-many', runningCount),
          confirmLabel: t('ui.session-workspace.terminal-close-confirm-action'),
          danger: true,
        });
        if (!ok) return false;
        closeTab(tabKey);
        return true;
      } finally {
        closingTerminalsRef.current.delete(tabKey);
      }
    },
    [closeTab, scope],
  );
  const openSideChatTab = useCallback(
    (chatId: string) => {
      if (!chatId) return;
      const key = `side-chat:${chatId}`;
      if (!skipDetachedHost && detached.has(key)) {
        detachedWindows.focus(scope, key);
        return;
      }
      revealPane();
      update((s) => openSideChatPage(s, chatId));
    },
    [detached, skipDetachedHost, revealPane, scope, update],
  );
  const openSideChat = useCallback(
    (opts: { fresh?: boolean; quote?: SelectionQuote; replace?: string } = {}) => {
      const current = isSideChatKey(active) ? active!.slice('side-chat:'.length) : null;
      if (!opts.fresh && current && sideChatState(current)) {
        if (opts.quote) addSideChatQuote(current, opts.quote);
        update((s) => activateTab(s, active!));
        return current;
      }
      const id = createSideChat(scope, { projectId, quote: opts.quote });
      revealPane();
      update((s) => openSideChatPage(s, id, { replace: opts.replace }));
      return id;
    },
    [active, update, revealPane, scope, projectId],
  );
  // 主窗口独占登记为弹出窗口放回接收者，并在两阶段 dockRequest 时完成接收再发送 dockAck
  useEffect(() => {
    if (skipDetachedHost) return;
    void detachedWindows.registerHost();
    return detachedWindows.onDockRequest(({ id, transferId }) => {
      const p = parseDetachedId(id);
      if (!p) {
        void detachedWindows.dockAck(id, transferId, false);
        return;
      }
      if (isSideChatKey(p.key)) {
        const chatId = p.key.slice('side-chat:'.length);
        void detachedWindows
          .take(id, { direction: 'dock', transferId })
          .then((data) => {
            // 草稿就是此刻窗口里的那份（放回等确认期间那边还可能改，迟到的那份只收草稿）
            const ok =
              importSideChat(data, {
                withDraft: true,
                draftOnly: adoptedDocksRef.current.has(id),
              }) === chatId || !!sideChatState(chatId);
            if (ok) adoptedDocksRef.current.set(id, transferId);
            if (!ok) {
              void detachedWindows.dockAck(id, transferId, false);
              return;
            }
            settledDocksRef.current.add(id);
            setByScope((all) => {
              const cur = all[p.scope] ?? EMPTY_SIDE_TABS;
              const next = openSideChatPage(cur, chatId);
              if (next === all[p.scope]) return all;
              const rest = { ...all };
              delete rest[p.scope];
              const out = { ...rest, [p.scope]: next };
              if (p.scope) writeSideTabsStore(out);
              return out;
            });
            if (p.scope === scopeRef.current) revealPane();
            void detachedWindows.dockAck(id, transferId, true);
          })
          .catch(() => {
            void detachedWindows.dockAck(id, transferId, false);
          });
        return;
      }
      settledDocksRef.current.add(id);
      if (!p.key.startsWith('file:')) {
        setByScope((all) => {
          const cur = all[p.scope];
          if (!cur) return all;
          const next = activateTab(cur, p.key);
          if (next === cur) return all;
          const rest = { ...all };
          delete rest[p.scope];
          const out = { ...rest, [p.scope]: next };
          if (p.scope) writeSideTabsStore(out);
          return out;
        });
      }
      if (p.scope === scopeRef.current) revealPane();
      void detachedWindows.dockAck(id, transferId, true);
    });
  }, [skipDetachedHost, revealPane]);
  // 弹出去的侧边聊天直接关窗口（非两阶段放回）：收下交接内容并恢复页面；没有内容（窗口里关掉了）就关标签。
  // 按宿主的整份 id 列表比较（切换会话不算「回来」）
  const prevIds = useRef(detachedIds);
  useEffect(() => {
    if (skipDetachedHost) return;
    const before = prevIds.current;
    prevIds.current = detachedIds;
    if (before === detachedIds) return;
    const now = new Set(detachedIds);
    for (const id of before) {
      if (now.has(id)) continue;
      if (settledDocksRef.current.delete(id)) continue;
      const p = parseDetachedId(id);
      if (!p || !isSideChatKey(p.key)) continue;
      const chatId = p.key.slice('side-chat:'.length);
      void detachedWindows.take(id, { direction: 'dock' }).then((data) => {
        if (importSideChat(data) === chatId || sideChatState(chatId)) {
          setByScope((all) => {
            const cur = all[p.scope] ?? EMPTY_SIDE_TABS;
            if (cur.pages.some((pg) => pg.kind === 'side-chat' && pg.id === chatId)) return all;
            const next = openSideChatPage(cur, chatId);
            const rest = { ...all };
            delete rest[p.scope];
            const out = { ...rest, [p.scope]: next };
            if (p.scope) writeSideTabsStore(out);
            return out;
          });
          return;
        }
        setByScope((all) => {
          const cur = all[p.scope];
          if (!cur) return all;
          const next = closeSideTab(cur, p.key);
          if (next === cur) return all;
          const rest = { ...all };
          delete rest[p.scope];
          const out = { ...rest, [p.scope]: next };
          if (p.scope) writeSideTabsStore(out);
          return out;
        });
      });
    }
  }, [skipDetachedHost, detachedIds]);
  const activate = useCallback((key: string) => update((s) => activateTab(s, key)), [update]);
  const toggle = useCallback((key?: string) => update((s) => toggleMaximized(s, key)), [update]);
  const restore = useCallback(
    () => update((s) => (s.maximized ? toggleMaximized(s) : s)),
    [update],
  );
  const setScope = useCallback((next: string | null) => setScopeState(next ?? ''), []);
  const migrateScope = useCallback(
    (fromScope: string, toScope: string) => {
      if (!fromScope || !toScope || fromScope === toScope) return;
      migrateSideChatsScope(fromScope, toScope);
      migrateSideTracesScope(fromScope, toScope);
      setByScope((all) => {
        const fromState = all[fromScope];
        if (!fromState) return all;
        const existing = all[toScope];
        const merged: SideTabsState =
          existing && (existing.agents.length > 0 || existing.pages.length > 0)
            ? existing
            : fromState;
        const rest = { ...all };
        delete rest[fromScope];
        const out = { ...rest, [toScope]: merged };
        if (!isolated) writeSideTabsStore(out);
        return out;
      });
      setFilesOpenByScope((cur) => {
        if (!(fromScope in cur)) return cur;
        const next = { ...cur };
        if (!(toScope in next)) next[toScope] = cur[fromScope]!;
        delete next[fromScope];
        return next;
      });
      setPanePrefByScope((cur) => {
        if (!(fromScope in cur)) return cur;
        const next = { ...cur };
        if (!(toScope in next)) next[toScope] = cur[fromScope]!;
        delete next[fromScope];
        return next;
      });
    },
    [isolated],
  );
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

  const hasContent = hasSideTabs(tabs, filesOpen);
  const paneVisible = isSideTabsPaneVisible(panePref, hasContent);

  const showPane = useCallback(() => {
    update((s) => (hasSideTabs(s, filesOpen) ? s : openNewTab(s)));
    setPanePref('open');
  }, [update, filesOpen, setPanePref]);
  const hidePane = useCallback(() => setPanePref('closed'), [setPanePref]);
  const togglePane = useCallback(() => {
    if (paneVisible) hidePane();
    else showPane();
  }, [paneVisible, hidePane, showPane]);
  const addNewTab = useCallback(() => {
    const idRef = { current: '' };
    revealPane();
    update((s) => {
      const next = openNewTab(s);
      const page = next.pages[next.pages.length - 1];
      idRef.current = page && page.kind === 'new-tab' ? page.id : '';
      return next;
    });
    return idRef.current;
  }, [update, revealPane]);
  const addChanges = useCallback(
    (opts?: { replace?: string }) => {
      revealPane();
      update((s) => openChanges(s, opts));
    },
    [update, revealPane],
  );
  const addFileBrowser = useCallback(
    (opts?: { replace?: string }) => {
      revealPane();
      update((s) => openFileBrowser(s, opts));
    },
    [update, revealPane],
  );
  const addBrowser = useCallback(
    (url: string, opts?: { replace?: string; title?: string }) => {
      revealPane();
      update((s) => openBrowserTab(s, url, opts));
    },
    [update, revealPane],
  );
  const patchBrowserUrl = useCallback(
    (key: string, url: string, title?: string) =>
      update((s) => setBrowserUrlState(s, key, url, title)),
    [update],
  );
  const addTerminal = useCallback(
    (opts?: { replace?: string; cwd?: string; title?: string }) => {
      const id = newWorkspaceId();
      revealPane();
      update((s) => openTerminalTab(s, { ...opts, id }));
      return id;
    },
    [update, revealPane],
  );
  const focusTerminal = useCallback(
    (pageId: string) => {
      if (!pageId) return;
      const key = `terminal:${pageId}`;
      const curState = byScopeRef.current[scope];
      if (!curState || !findPage(curState, key)) return;
      revealPane();
      update((s) => activateTab(s, key));
    },
    [scope, revealPane, update],
  );
  const patchTerminalMeta = useCallback(
    (key: string, patch: { cwd?: string; title?: string; shell?: string }) =>
      update((s) => setTerminalMetaState(s, key, patch)),
    [update],
  );
  const patchTerminalLayout = useCallback(
    (key: string, layout: TerminalPaneNode, activePaneId?: string) =>
      update((s) => setTerminalLayoutState(s, key, layout, activePaneId)),
    [update],
  );

  const [hostCount, setHostCount] = useState(0);
  const [hostSuspended, setHostSuspended] = useState(false);
  const registerHost = useCallback(() => {
    setHostCount((c) => c + 1);
    return () => setHostCount((c) => Math.max(0, c - 1));
  }, []);
  const hasHost = hostCount > 0 && !hostSuspended;

  const openTrace = useCallback(
    (spec: SideTraceSpec, opts?: { dedupeKey?: string; replace?: string; title?: string }) => {
      const curState = byScopeRef.current[scope] ?? EMPTY_SIDE_TABS;
      const existing = opts?.dedupeKey
        ? curState.pages.find(
            (p): p is Extract<WorkspacePage, { kind: 'trace' }> =>
              p.kind === 'trace' && p.dedupeKey === opts.dedupeKey,
          )
        : undefined;
      const id = existing ? existing.id : newWorkspaceId();
      registerSideTrace(scope, spec, id);
      revealPane();
      const title = opts?.title ?? spec.title;
      update((s) =>
        openTraceTab(s, {
          id,
          title,
          dedupeKey: opts?.dedupeKey,
          replace: opts?.replace,
        }),
      );
      return id;
    },
    [scope, revealPane, update],
  );

  // 删除会话或关闭 CLI 会话标签时，回收该会话下的所有内置终端 PTY、内存轨迹与标签状态
  const dropScopes = useCallback(
    (scopes: readonly string[]) => {
      const targets = [...new Set(scopes.filter(Boolean))];
      if (!targets.length) return;
      const snapshot = byScopeRef.current;
      const toClosePanes = new Set<string>();
      for (const s of targets) {
        discardSideTracesInScope(s);
        const cur = snapshot[s];
        if (!cur) continue;
        for (const p of cur.pages) {
          if (p.kind !== 'terminal') continue;
          for (const pid of terminalPaneIds(p)) {
            toClosePanes.add(pid);
          }
        }
      }
      for (const pid of toClosePanes) {
        sideTerminalHost.close(sideTerminalIdFor(pid));
      }
      setByScope((all) => {
        let changed = false;
        const next = { ...all };
        for (const s of targets) {
          if (!(s in next)) continue;
          delete next[s];
          changed = true;
        }
        if (!changed) return all;
        if (!isolated) writeSideTabsStore(next);
        return next;
      });
      setFilesOpenByScope((cur) => {
        let changed = false;
        const next = { ...cur };
        for (const s of targets) {
          if (s in next) {
            delete next[s];
            changed = true;
          }
        }
        return changed ? next : cur;
      });
      setPanePrefByScope((cur) => {
        let changed = false;
        const next = { ...cur };
        for (const s of targets) {
          if (s in next) {
            delete next[s];
            changed = true;
          }
        }
        return changed ? next : cur;
      });
    },
    [isolated],
  );

  useEffect(() => {
    if (isolated) return;
    const onConversationsChanged = (ev: Event) => {
      const removed = (ev as CustomEvent<ConversationsChangedDetail>).detail?.removed;
      if (!removed?.length) return;
      const goneScopes: string[] = [];
      for (const g of removed) {
        if (g.id) goneScopes.push(`nomi:${g.id}`);
        if (g.tabId) goneScopes.push(`tab:${g.tabId}`);
      }
      if (goneScopes.length > 0) dropScopes(goneScopes);
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onConversationsChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onConversationsChanged);
  }, [dropScopes, isolated]);

  const prevLiveTabsRef = useRef<typeof liveTabs>(undefined);
  useEffect(() => {
    if (isolated) return;
    const prev = prevLiveTabsRef.current;
    prevLiveTabsRef.current = liveTabs;
    if (!prev || !liveTabs) return;
    const activeIds = new Set(liveTabs.map((tab) => tab.id));
    const activeKeys = new Set(liveTabs.map((tab) => cliTranscriptKey(tab)));
    const goneScopes: string[] = [];
    for (const old of prev) {
      if (activeIds.has(old.id)) continue;
      goneScopes.push(`tab:${old.id}`);
      const tk = cliTranscriptKey(old);
      if (!activeKeys.has(tk)) goneScopes.push(tk);
    }
    if (goneScopes.length > 0) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) dropScopes(goneScopes);
      });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [liveTabs, dropScopes, isolated]);

  // 汇总全部会话里仍开着的终端 id，去抖同步给宿主防孤儿进程；页面卸载时清理全部终端（隔离模式不接管终端）
  const liveTerminalIds = useMemo(() => {
    if (isolated) return [];
    const ids: string[] = [];
    for (const s of Object.values(byScope)) {
      for (const p of s.pages) {
        if (p.kind !== 'terminal') continue;
        for (const pid of terminalPaneIds(p)) {
          ids.push(sideTerminalIdFor(pid));
        }
      }
    }
    return ids;
  }, [byScope, isolated]);
  const prevLiveKeyRef = useRef<string | null>(null);
  const hadTerminalsRef = useRef(false);
  useEffect(() => {
    if (isolated) return;
    if (liveTerminalIds.length > 0) hadTerminalsRef.current = true;
    if (!hadTerminalsRef.current) return;
    const key = liveTerminalIds.join('\0');
    if (prevLiveKeyRef.current === key) return;
    prevLiveKeyRef.current = key;
    syncLiveTerminals(liveTerminalIds);
  }, [liveTerminalIds, isolated]);
  useEffect(() => {
    if (isolated) return;
    const closeIfNeeded = () => {
      if (hadTerminalsRef.current) sideTerminalHost.closeAll();
    };
    window.addEventListener('pagehide', closeIfNeeded);
    window.addEventListener('beforeunload', closeIfNeeded);
    return () => {
      window.removeEventListener('pagehide', closeIfNeeded);
      window.removeEventListener('beforeunload', closeIfNeeded);
      closeIfNeeded();
    };
  }, [isolated]);
  useEffect(() => {
    if (!isolated || !scope) return;
    return () => {
      discardSideTracesInScope(scope);
    };
  }, [isolated, scope]);

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
      migrateScope,
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
      pages: tabs.pages,
      paneVisible,
      panePref,
      showPane,
      hidePane,
      togglePane,
      openNewTab: addNewTab,
      openChanges: addChanges,
      openFileBrowser: addFileBrowser,
      openBrowser: addBrowser,
      setBrowserUrl: patchBrowserUrl,
      openTerminal: addTerminal,
      focusTerminal,
      requestCloseTerminal,
      setTerminalMeta: patchTerminalMeta,
      setTerminalLayout: patchTerminalLayout,
      hasHost,
      registerHost,
      setHostSuspended,
      openTrace,
    }),
    [
      openSideChat,
      openSideChatTab,
      addNewTab,
      addChanges,
      addFileBrowser,
      addBrowser,
      patchBrowserUrl,
      addTerminal,
      focusTerminal,
      requestCloseTerminal,
      patchTerminalMeta,
      patchTerminalLayout,
      hasHost,
      registerHost,
      setHostSuspended,
      openTrace,
      paneVisible,
      panePref,
      showPane,
      hidePane,
      togglePane,
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
      migrateScope,
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
