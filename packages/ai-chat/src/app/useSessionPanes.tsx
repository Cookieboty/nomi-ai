/**
 * 主区的并排会话（在现有「单一当前会话」之上补的最小一层）。
 *
 * - `planPaneLayout`：按面板状态算出主区里的列。单面板时就是原来那一列（焦点在右边也渲染成那一列，
 *   DOM 与拆分前一致）；并排时左右各一列，每一列注明是否焦点、是否带整列级窗口组件；
 * - `syncCurrentToPane`：焦点面板 = 「当前会话」。焦点变了就把 ConversationStore.currentId /
 *   harness 当前标签切过去，于是发送、斜杠命令、工作区标签、文件区（SideWorkspace 按会话分桶）
 *   都沿用原来按当前会话的路径；
 * - `useSessionPaneLayout`：布局 + 中间分割线的拖动（复用 startSplitDrag，与现有分栏手感一致）；
 * - 另一个面板**不跟着 current 走**：App 按它自己绑定的会话键读（见 App 的 paneViews），
 *   焦点切换不会把它卸掉或换成 current。
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import type { PaneTabInfo } from '../components/SessionPane';
import { useSessionPanes } from '../contexts/SessionPanesContext';
import type { ConversationStore } from '../services/conversationStore';
import type { HarnessTabMeta } from '../services/harnessClient';
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

/** 会话键 → harness 标签 id（Nomi 会话为 undefined） */
export function tabIdOfSessionKey(key: string | null): string | undefined {
  const parsed = parseSessionKey(key);
  if (!parsed || parsed.kind === 'nomi') return undefined;
  return parsed.kind === 'tab' ? parsed.id : parsed.sessionId;
}

/**
 * 把焦点面板的会话同步成「当前会话」（只改指针，不重载消息：各列按自己的会话键读）：
 * - Nomi 会话：ConversationStore.switchTo（currentId 与「最近 Nomi 会话」一起变）；
 * - CLI 标签：harness 切到那个标签（窗口里已经有标签时）。
 * CLI 会话在左边时，currentId 也切到它的镜像项（与点侧栏的 CLI 会话一致）：下一次回到主标签，
 * 现成的 useRestoreNomiOnMain 会把 Nomi 当前会话拉回最近的 Nomi 会话。
 */
export function syncCurrentToPane(
  key: string | null,
  deps: {
    store: ConversationStore | undefined;
    tabIdOf: (key: string) => string | undefined;
    currentTabId: string | undefined;
    activateTab: (id: string) => void;
    /** 窗口里有没有 harness 标签（没有时只切 Nomi 会话） */
    hasTabs: boolean;
  },
): void {
  const parsed = parseSessionKey(key);
  if (!parsed) return;
  if (parsed.kind === 'nomi') {
    if (deps.store?.get(parsed.id) && deps.store.currentId() !== parsed.id) {
      try {
        deps.store.switchTo(parsed.id);
      } catch {
        /* 会话在这期间被删了：不动 */
      }
    }
    return;
  }
  const tabId = deps.tabIdOf(key!);
  if (deps.hasTabs && tabId && tabId !== deps.currentTabId) deps.activateTab(tabId);
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
  };
}

/** 焦点会话变成 store 的 current 之后：把当前会话的消息补回给「当前」那一份（只做一次，避免循环） */
export function useSyncFocusedPaneSession(opts: {
  store: ConversationStore | undefined;
  scheduleSync: (key: string | null) => void;
}): void {
  const panes = useSessionPanes();
  const key = panes?.focusedKey ?? null;
  const prev = useRef<string | null | undefined>(undefined);
  const schedule = opts.scheduleSync;
  useEffect(() => {
    // 挂载时那一次不补（当前的会话就是它，消息已经在了）
    if (prev.current === undefined) {
      prev.current = key;
      return;
    }
    if (prev.current === key) return;
    prev.current = key;
    schedule(key);
  }, [key, schedule]);
}
