/**
 * 主区的并排会话（在现有「单一当前会话」之上补的最小一层）。
 *
 * - `planPaneLayout`：按面板状态算出主区里的列。单面板时就是原来那一列（焦点在右边也渲染成那一列，
 *   DOM 与拆分前一致）；并排时左右各一列，每一列注明是否焦点、是否带整列级窗口组件；
 * - `syncCurrentToPane`：焦点面板 = 「当前会话」。焦点变了就把 ConversationStore.currentId /
 *   harness 当前标签切过去并加载历史，于是发送、斜杠命令、工作区标签都沿用原来按当前会话的路径；
 * - `useSessionPaneLayout`：布局 + 中间分割线的拖动（复用 startSplitDrag，与现有分栏手感一致）。
 */
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import type { PaneTabInfo } from '../components/SessionPane';
import { useSessionPanes } from '../contexts/SessionPanesContext';
import type { ConversationStore } from '../services/conversationStore';
import { MAIN_TAB_ID, type HarnessTabMeta } from '../services/harnessClient';
import {
  clampPaneRatio,
  PANE_RATIO_DEFAULT,
  parseSessionKey,
  type SessionPane,
} from '../utils/sessionPanes';
import { startSplitDrag } from '../utils/splitDrag';

export interface PaneColumnPlan {
  paneId: string;
  /** 面板绑定的会话键（空面板 / 还没拿到会话 id 的兜底列为 null） */
  key: string | null;
  /** 焦点面板（= 当前会话那一列） */
  focus: boolean;
  /** 带整列级窗口组件（授权卡、会话详情、ManagedRuntime 观察）：整个窗口只挂一份 */
  owned: boolean;
  /** 这一列显示它自己绑定的会话（false = 用「当前会话」那一份兜底） */
  bound: boolean;
}

export interface PaneLayoutPlan {
  split: boolean;
  /** 与 SideWorkspace 分栏：并排时总是；单面板沿用原来的判定 */
  withSidePane: boolean;
  /** 左→右的列（App 按这个顺序渲染 DOM，不按焦点排） */
  columns: PaneColumnPlan[];
  /** 焦点面板那一列（单面板时就是唯一一列） */
  focus: PaneColumnPlan | undefined;
  /** 焦点面板在 columns 里的下标（0 = 左） */
  focusIndex: number;
  /** 另一列（焦点之外；单面板时 undefined） */
  other: PaneColumnPlan | undefined;
  /** 会话键 → 这一列显示它的 CLI 标签（面板标题用；Nomi 会话为 undefined） */
  tabOf: (sessionKey: string | null) => PaneTabInfo | undefined;
}

/**
 * 主区里的列：
 * - 单面板：只渲染焦点面板那一列（id 不变，等于拆分前那唯一的一列）；
 * - 两个面板：左右各一列，焦点那一列 owned。
 */
export function planPaneLayout(
  panes: readonly SessionPane[],
  focusedPaneId: string,
  singlePaneWithSide: boolean,
  tabOf: (sessionKey: string | null) => PaneTabInfo | undefined = () => undefined,
): PaneLayoutPlan {
  const focusIdx = Math.max(
    0,
    panes.findIndex((p) => p.id === focusedPaneId),
  );
  const finish = (split: boolean, columns: PaneColumnPlan[], withSidePane: boolean) => {
    const fi = Math.max(
      0,
      columns.findIndex((c) => c.focus),
    );
    return {
      split,
      withSidePane,
      columns,
      focus: columns[fi],
      focusIndex: columns.length > 0 ? fi : 0,
      other: columns.find((c) => !c.focus),
      tabOf,
    };
  };
  if (panes.length < 2) {
    const only = panes[focusIdx] ?? panes[0];
    return finish(
      false,
      only
        ? [{ paneId: only.id, key: only.sessionKey, focus: true, owned: true, bound: true }]
        : [],
      singlePaneWithSide,
    );
  }
  return finish(
    true,
    panes.slice(0, 2).map((pane, i) => ({
      paneId: pane.id,
      key: pane.sessionKey,
      focus: i === focusIdx,
      owned: i === focusIdx,
      // 绑定了会话，或这一列就是「当前会话」那一份（没有会话 id 的空会话只会在焦点面板上出现）
      bound: !!pane.sessionKey || i === focusIdx,
    })),
    true,
  );
}

/**
 * 会话键里直接带的 harness 标签 id：
 * 只有 `tab:<id>` 带真实标签 id；`cli:<backend>:<sessionId>` 带的是 CLI 会话 id（不是 tab.id），
 * 必须用 `tabOfSessionKey` 在标签列表里按 `(backend, cliSessionId)` 反查。
 */
export function tabIdOfSessionKey(key: string | null): string | undefined {
  const parsed = parseSessionKey(key);
  if (!parsed || parsed.kind !== 'tab') return undefined;
  return parsed.id;
}

/** 会话键 → harness 标签（Nomi 会话为 undefined）：tab 用标签 id，cli 用会话 id 反查 */
export function tabOfSessionKey(
  tabs: readonly HarnessTabMeta[] | undefined,
  key: string | null,
): HarnessTabMeta | undefined {
  const parsed = parseSessionKey(key);
  if (!parsed || parsed.kind === 'nomi' || !tabs) return undefined;
  if (parsed.kind === 'tab') return tabs.find((t) => t.id === parsed.id);
  return tabs.find((t) => t.backend === parsed.backend && t.cliSessionId === parsed.sessionId);
}

/** 结合标签列表把会话键解析成真实 harness tab.id */
export function resolveTabId(
  tabs: readonly HarnessTabMeta[] | undefined,
  key: string | null,
): string | undefined {
  return tabOfSessionKey(tabs, key)?.id ?? tabIdOfSessionKey(key);
}

/**
 * 把焦点面板的会话同步成「当前会话」：
 * - Nomi 会话：先切 ConversationStore.switchTo（在激活 main 标签前完成，防止 useRestoreNomiOnMain 拉回旧会话），
 *   必要时激活 MAIN_TAB_ID 并设 backend 为 nomi，并触发 loadChatHistory 刷新视图消息；
 * - CLI 标签：harness 切到该标签，同时把 store 指针切到它的镜像项（与侧栏点击一致）。
 */
export function syncCurrentToPane(
  key: string | null,
  deps: {
    store: ConversationStore | undefined;
    tabIdOf: (key: string) => string | undefined;
    currentTabId: string | undefined;
    activateTab: (id: string) => void | Promise<void>;
    /** 窗口里有没有 harness 标签（没有时只切 Nomi 会话） */
    hasTabs: boolean;
    viewConvoId?: string;
    loadChatHistory?: () => Promise<void> | void;
    setNomiBackend?: () => void;
    notifyChanged?: () => void;
  },
): void {
  const parsed = parseSessionKey(key);
  if (!parsed) return;
  if (parsed.kind === 'nomi') {
    const exists = !!deps.store?.get(parsed.id);
    let switched = false;
    if (exists && deps.store!.currentId() !== parsed.id) {
      try {
        deps.store!.switchTo(parsed.id);
        switched = true;
        deps.notifyChanged?.();
      } catch {
        /* 会话在这期间被删了：不动 */
      }
    }
    if (deps.hasTabs && deps.currentTabId && deps.currentTabId !== MAIN_TAB_ID) {
      void deps.activateTab(MAIN_TAB_ID);
      deps.setNomiBackend?.();
    }
    if (exists && (switched || deps.viewConvoId !== parsed.id)) {
      void deps.loadChatHistory?.();
    }
    return;
  }
  const tabId = deps.tabIdOf(key!);
  if (deps.hasTabs && tabId && tabId !== deps.currentTabId) {
    void deps.activateTab(tabId);
  }
  if (tabId && deps.store) {
    const mirror = deps.store.findByTabId(tabId);
    if (mirror && deps.store.currentId() !== mirror.id) {
      try {
        deps.store.switchTo(mirror.id);
        deps.notifyChanged?.();
      } catch {
        /* 镜像项已被移除：不动 */
      }
    }
  }
}

/** 面板绑定的 CLI 标签（标题用） */
export function paneTabInfo(tab: HarnessTabMeta | undefined): PaneTabInfo | undefined {
  return tab
    ? { title: tab.title, backend: tab.backend, projectId: tab.projectId, cwd: tab.cwd }
    : undefined;
}

/** 没有标签列表时的面板标题查找 */
const EMPTY_TAB_LOOKUP = (): PaneTabInfo | undefined => undefined;

/** 布局 + 中间分割线拖动（比例记在 SessionPanesContext 里，并随 Preferences 落盘） */
export function useSessionPaneLayout(opts: {
  /** 单面板时是否与 SideWorkspace 分栏（沿用原来的判定） */
  singlePaneWithSide: boolean;
  /** 会话键 → CLI 标签（面板标题用；App 按 harness 标签列表查好） */
  tabOf?: (sessionKey: string | null) => PaneTabInfo | undefined;
}): PaneLayoutPlan & {
  ratio: number;
  style: CSSProperties | undefined;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  const panes = useSessionPanes();
  const ratio = panes?.ratio ?? PANE_RATIO_DEFAULT;
  // 没有会话面板时（独立渲染）没有标签可查：tabOf 缺省成空表
  const plan = useMemo(
    () =>
      planPaneLayout(
        panes?.panes ?? [],
        panes?.focusedPaneId ?? '',
        opts.singlePaneWithSide,
        opts.tabOf ?? EMPTY_TAB_LOOKUP,
      ),
    [panes?.panes, panes?.focusedPaneId, opts.singlePaneWithSide, opts.tabOf],
  );
  const setRatio = panes?.setRatio;
  const ratioRef = useRef(ratio);
  useLayoutEffect(() => {
    ratioRef.current = ratio;
  });
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const host = e.currentTarget.parentElement;
      if (!setRatio || !host) return;
      const hostW = host.getBoundingClientRect().width;
      if (hostW <= 0) return;
      e.preventDefault();
      const avail = Math.max(1, hostW - 5);
      const startRatio = ratioRef.current;
      const startX = e.clientX;
      let current = startRatio;
      startSplitDrag({
        el: e.currentTarget,
        pointerId: e.pointerId,
        onMove: (ev) => {
          current = clampPaneRatio(startRatio + (ev.clientX - startX) / avail);
          setRatio(current);
        },
        onEnd: () => setRatio(current),
      });
    },
    [setRatio],
  );
  const onDoubleClick = useCallback(() => {
    setRatio?.(PANE_RATIO_DEFAULT);
  }, [setRatio]);
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!setRatio) return;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = clampPaneRatio(ratioRef.current - 0.05);
      else if (e.key === 'ArrowRight') next = clampPaneRatio(ratioRef.current + 0.05);
      else if (e.key === 'Home' || e.key === 'Enter') next = PANE_RATIO_DEFAULT;
      if (next === null) return;
      e.preventDefault();
      setRatio(next);
    },
    [setRatio],
  );
  return {
    ...plan,
    ratio,
    // 左列按比例、右列吃剩下的；窄窗口里两列都有最小宽度，拖到极限也有内容
    style: plan.split
      ? ({
          '--session-pane-left': `${ratio * 100}%`,
        } as CSSProperties)
      : undefined,
    onPointerDown,
    onDoubleClick,
    onKeyDown,
  };
}
