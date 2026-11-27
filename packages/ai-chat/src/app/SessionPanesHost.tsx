/**
 * 主区会话面板的宿主与双向同步（从 App.tsx 拆出）：
 *
 * - `useActiveSessionInfo`：统一计算焦点面板 / 单面板当前的 `sessionKey`、`nomiSessionId`、`activeCliTab`；
 * - `SessionPanesHost` + `SessionPanesSync`：维护面板焦点与「当前会话」之间的双向同步、
 *   `tab:<id>` → `cli:<backend>:<id>` 迁移，以及会话删除/标签关闭后的清理；
 * - `useSharedWorkspaceScope`：单面板按会话分桶；并排期间锁定同一个工作区与预览桶，
 *   让右侧 `SideWorkspace` 保持全局唯一且跨项目切焦点不丢失已打开文件。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { PaneTabInfo } from '../components/SessionPane';
import {
  selectIpcClient,
  selectViewConvoId,
  useAiChatActions,
  useAiChatSelector,
} from '../contexts/aiChatStore';
import { useHarnessTabs, useHarnessTabsCore } from '../contexts/HarnessTabsContext';
import { SessionPanesProvider, useSessionPanes } from '../contexts/SessionPanesContext';
import { useChatMode } from '../hooks/useChatMode';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../services/conversationStore';
import { harnessClient, MAIN_TAB_ID, type HarnessTabMeta } from '../services/harnessClient';
import { cliTranscriptKey } from '../services/transcriptView';
import { cliSessionKey, nomiSessionKey, paneKeysKey, parseSessionKey } from '../utils/sessionPanes';

import { paneTabInfo, resolveTabId, syncCurrentToPane, tabOfSessionKey } from './useSessionPanes';

export interface SyncPaneDeps {
  store: ConversationStore | undefined;
  /** harness 标签列表（还没拿到时为 undefined：不按它摘面板） */
  tabList: readonly HarnessTabMeta[] | undefined;
  tabIdOf: (key: string) => string | undefined;
  currentTabId: string | undefined;
  activateTab: (id: string) => void | Promise<void>;
  hasTabs: boolean;
  viewConvoId: string | undefined;
  loadChatHistory: () => Promise<void>;
  setNomiBackend: () => void;
  notifyChanged: () => void;
}

/**
 * 实时计算当前主列会话的唯一标识：
 * - CLI 标签激活时使用 cliTranscriptKey（新标签为 tab:<id>，拿到会话 id 后升级为 cli:<backend>:<id>）；
 * - Nomi 会话监听 CONVERSATIONS_CHANGED_EVENT 与 viewConvoId，切换或新建会话的第 0ms 立即同步，
 *   且过滤掉 CLI 镜像项 id，绝不把镜像项误认成 Nomi 会话。
 */
export function useActiveSessionInfo(opts?: {
  focusedPaneKey?: string | null;
  focusedTab?: HarnessTabMeta | null;
}) {
  const ipcClient = useAiChatSelector(selectIpcClient);
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const tabs = useHarnessTabsCore();
  const { isDev } = useChatMode();
  const [storeVersion, setStoreVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setStoreVersion((v) => v + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
  }, []);
  const focusedParsed = useMemo(
    () => parseSessionKey(opts?.focusedPaneKey ?? null),
    [opts?.focusedPaneKey],
  );
  const nomiSessionId = useMemo(() => {
    void storeVersion;
    if (focusedParsed?.kind === 'nomi') return focusedParsed.id;
    const store = ipcClient?.conversationStore?.();
    if (store) {
      const cur = store.currentId();
      if (cur && store.isNomi(cur)) return cur;
      if (viewConvoId && store.isNomi(viewConvoId)) return viewConvoId;
      return store.lastNomiId() ?? viewConvoId;
    }
    return viewConvoId ?? ipcClient?.currentConversationId?.();
  }, [ipcClient, viewConvoId, storeVersion, focusedParsed]);
  // 并排会话时以焦点面板的标签为准（焦点在 Nomi 面板时不回退到旧 CLI 标签）
  const focusedTab = opts?.focusedTab;
  const activeCliTab = focusedTab
    ? focusedTab
    : focusedParsed?.kind === 'nomi'
      ? null
      : isDev && tabs.isCliTab
        ? tabs.activeTab
        : null;
  const sessionKey = activeCliTab
    ? cliTranscriptKey(activeCliTab)
    : nomiSessionId
      ? `nomi:${nomiSessionId}`
      : null;
  return { sessionKey, nomiSessionId, activeCliTab };
}

/** 会话键 → CLI 标签（面板标题用）：tab:<id> 直接查，cli:<backend>:<会话 id> 按会话 id 反查 */
export function usePaneTabLookup(): (sessionKey: string | null) => PaneTabInfo | undefined {
  const tabs = useHarnessTabs();
  const list = tabs.state?.tabs;
  return useCallback(
    (key: string | null) => {
      if (!key || !list) return undefined;
      return paneTabInfo(tabOfSessionKey(list, key));
    },
    [list],
  );
}

/**
 * 「当前会话」的快照（冷启动 seed 与外部切换用）。
 * 读 store 指针与 harness 标签上下文；随 storeVersion 变化更新，避免读到过期指针。
 */
export function useCurrentSessionSnapshot(): () => string | null {
  const ipcClient = useAiChatSelector(selectIpcClient);
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const tabs = useHarnessTabs();
  const [storeVersion, setStoreVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setStoreVersion((v) => v + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
  }, []);
  return useCallback(() => {
    void storeVersion;
    const meta = tabs.state?.tabs.find((x) => x.id === tabs.activeTabId);
    if (meta && meta.id !== MAIN_TAB_ID) return cliSessionKey(meta);
    const store = ipcClient?.conversationStore?.();
    if (store) {
      const cur = store.currentId();
      if (cur && store.isNomi(cur)) return nomiSessionKey(cur);
      return nomiSessionKey(store.lastNomiId() ?? viewConvoId);
    }
    return nomiSessionKey(viewConvoId ?? ipcClient?.currentConversationId?.());
  }, [ipcClient, viewConvoId, tabs, storeVersion]);
}

/**
 * 主区的会话面板（并排会话）：挂在侧栏与主区外面，两者共用同一份面板状态。
 */
export const SessionPanesHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { activeTabId: currentTabId, activate: activateTab } = useHarnessTabsCore();
  const syncFocus = useCallback(
    (
      sessionKey: string | null,
      deps: Omit<SyncPaneDeps, 'currentTabId' | 'activateTab' | 'hasTabs'>,
    ) => {
      syncCurrentToPane(sessionKey, {
        ...deps,
        currentTabId,
        activateTab,
        hasTabs: !!deps.tabList,
      });
    },
    [currentTabId, activateTab],
  );
  return (
    <SessionPanesProvider>
      <SessionPanesSync syncFocus={syncFocus}>{children}</SessionPanesSync>
    </SessionPanesProvider>
  );
};

/**
 * 面板与「当前会话」的双向同步（在 SessionPanesProvider 里面）：
 * - 焦点面板变了 → 当前会话跟过去（store 指针、harness 标签、消息历史）；
 * - 当前会话在别处变了（新建对话、关掉 CLI 标签、灵动岛跳转）→ 仅当 currentKey 本身真实变化时才更新焦点面板，
 *   且拆分态下只替换焦点面板（或聚焦已有面板），绝不把恢复好的拆分清空；
 * - tab:<id> 拿到 cliSessionId 后自动迁移到 cli:<backend>:<id>；
 * - 会话被删 / 归档 / CLI 标签关闭后从面板里摘掉。
 */
const SessionPanesSync: React.FC<{
  syncFocus: (
    key: string | null,
    deps: Omit<SyncPaneDeps, 'currentTabId' | 'activateTab' | 'hasTabs'>,
  ) => void;
  children: React.ReactNode;
}> = ({ syncFocus, children }) => {
  const panes = useSessionPanes();
  const ipcClient = useAiChatSelector(selectIpcClient);
  const viewConvoId = useAiChatSelector(selectViewConvoId);
  const { actions } = useAiChatActions();
  const store = ipcClient?.conversationStore?.() as ConversationStore | undefined;
  const tabList = useHarnessTabs().state?.tabs;
  const [storeVersion, setStoreVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setStoreVersion((v) => v + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
  }, []);
  const tabIdOf = useCallback((key: string) => resolveTabId(tabList, key), [tabList]);
  const setNomiBackend = useCallback(() => {
    const main = tabList?.find((x) => x.id === MAIN_TAB_ID);
    if (harnessClient.available() && main?.backend !== 'nomi') {
      void harnessClient.setBackend('nomi').catch(() => undefined);
    }
  }, [tabList]);
  const deps = useMemo(
    () => ({
      store,
      tabList,
      tabIdOf,
      viewConvoId,
      loadChatHistory: actions.loadChatHistory,
      setNomiBackend,
      notifyChanged: notifyConversationsChanged,
    }),
    [store, tabList, tabIdOf, viewConvoId, actions.loadChatHistory, setNomiBackend],
  );

  // 1. 焦点面板 → 当前会话
  const prevFocusKeyRef = useRef<string | null | undefined>(undefined);
  const prevFocusSyncRef = useRef<string>('');
  const initialSyncedRef = useRef(false);
  const onFocus = panes?.focusedKey ?? null;
  useLayoutEffect(() => {
    const readyKey = `${onFocus ?? ''}|${deps.tabList ? 1 : 0}|${deps.store ? 1 : 0}`;
    if (prevFocusSyncRef.current === readyKey) return;
    const prevKey = prevFocusKeyRef.current;
    const becameReady =
      prevKey === onFocus && (deps.tabList !== undefined || deps.store !== undefined);
    if (prevKey !== onFocus || (becameReady && !initialSyncedRef.current)) {
      prevFocusSyncRef.current = readyKey;
      prevFocusKeyRef.current = onFocus;
      if (onFocus) {
        const parsed = parseSessionKey(onFocus);
        const targetReady =
          parsed?.kind === 'nomi' ? !!deps.store?.get(parsed.id) : !!deps.tabIdOf(onFocus);
        if (targetReady) initialSyncedRef.current = true;
        syncFocus(onFocus, deps);
      }
    }
  }, [onFocus, syncFocus, deps]);

  // 2. 当前会话在别处变了 → 焦点面板跟过去（不摧毁已恢复的拆分）
  const currentSnapshot = useCurrentSessionSnapshot();
  const seed = panes?.seed;
  const syncExternal = panes?.syncExternal;
  const isSplit = !!panes?.isSplit;
  const currentKey = currentSnapshot();
  const prevCurrentKeyRef = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const prev = prevCurrentKeyRef.current;
    if (prev === currentKey) return;
    prevCurrentKeyRef.current = currentKey;
    if (!currentKey) return;
    // 冷启动首次拿到 currentKey：单面板且为空时 seed；已恢复拆分态则保留原拆分
    if (prev === undefined || prev === null) {
      if (!isSplit && onFocus === null) seed?.(currentKey);
      return;
    }
    if (currentKey !== onFocus) syncExternal?.(currentKey);
  }, [currentKey, isSplit, onFocus, seed, syncExternal]);

  // 3. tab:<id> 拿到 cliSessionId 后升级为 cli:<backend>:<id>，保证持久化与跨视图一致
  const setPaneSession = panes?.setPaneSession;
  const currentPanes = panes?.panes;
  useEffect(() => {
    if (!tabList || !setPaneSession || !currentPanes) return;
    for (const p of currentPanes) {
      const parsed = parseSessionKey(p.sessionKey);
      if (parsed?.kind !== 'tab') continue;
      const tab = tabList.find((t) => t.id === parsed.id);
      if (!tab?.cliSessionId) continue;
      const nextKey = cliSessionKey(tab);
      if (nextKey !== p.sessionKey) setPaneSession(p.id, nextKey);
    }
  }, [tabList, currentPanes, setPaneSession]);

  // 4. 会话没了（被删 / 归档 / CLI 标签关掉）：从面板里摘掉
  const dropSession = panes?.dropSession;
  const paneKeys = paneKeysKey(currentPanes ?? []);
  useEffect(() => {
    void storeVersion;
    if (!dropSession) return;
    for (const key of paneKeys.split('\u0000')) {
      const parsed = parseSessionKey(key);
      if (!parsed) continue;
      if (parsed.kind === 'nomi') {
        if (store && !store.get(parsed.id)) dropSession(key);
      } else if (tabList && !tabOfSessionKey(tabList, key)) {
        dropSession(key);
      }
    }
  }, [paneKeys, store, tabList, dropSession, storeVersion]);

  return <>{children}</>;
};

export interface SharedWorkspaceScopeValue {
  /** 并排期间锁定的工作区共享桶键；单面板时等于当前 sessionKey */
  workspaceScope: string | null;
  /** 并排期间两边面板正在查看的会话键集合（用于预览区跨会话兼容判定） */
  allowedScopeIds: readonly string[] | undefined;
}

const SharedWorkspaceScopeContext = createContext<SharedWorkspaceScopeValue | null>(null);

export const SharedWorkspaceScopeProvider: React.FC<{
  sessionKey: string | null;
  children: React.ReactNode;
}> = ({ sessionKey, children }) => {
  const panes = useSessionPanes();
  const isSplit = !!panes?.isSplit;
  // 记录进入并排前的单面板会话键：并排期间切焦点不切换 SideWorkspace 桶，打开的文件共享并覆盖同一文件区
  const [scopeState, setScopeState] = useState<{
    split: boolean;
    bucket: string | null;
    prevSingle: string | null;
  }>(() => ({
    split: isSplit,
    bucket: isSplit ? (panes?.panes[0]?.sessionKey ?? sessionKey ?? '__split__') : null,
    prevSingle: isSplit ? null : sessionKey,
  }));
  if (scopeState.split !== isSplit || (!isSplit && scopeState.prevSingle !== sessionKey)) {
    if (!isSplit) {
      setScopeState({ split: false, bucket: null, prevSingle: sessionKey });
    } else {
      setScopeState({
        split: true,
        bucket: scopeState.prevSingle ?? panes?.panes[0]?.sessionKey ?? sessionKey ?? '__split__',
        prevSingle: scopeState.prevSingle,
      });
    }
  }
  const paneKeys = paneKeysKey(panes?.panes ?? []);
  const splitBucket = scopeState.bucket;
  const value = useMemo<SharedWorkspaceScopeValue>(() => {
    if (!isSplit) {
      return { workspaceScope: sessionKey, allowedScopeIds: undefined };
    }
    const keys = paneKeys.split('\u0000').filter(Boolean);
    const bucket = splitBucket ?? sessionKey ?? '__split__';
    const allowed = Array.from(new Set([bucket, ...keys]));
    return { workspaceScope: bucket, allowedScopeIds: allowed };
  }, [isSplit, sessionKey, splitBucket, paneKeys]);
  return (
    <SharedWorkspaceScopeContext.Provider value={value}>
      {children}
    </SharedWorkspaceScopeContext.Provider>
  );
};

export function useSharedWorkspaceScope(): SharedWorkspaceScopeValue | undefined {
  return useContext(SharedWorkspaceScopeContext) ?? undefined;
}
