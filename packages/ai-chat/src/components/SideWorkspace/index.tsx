/**
 * 对话旁的工作区：子任务和工作区页共用一块；文件预览 tabs 属于“打开文件”页内部。
 * - 点「查看」开一个子任务标签（已开着就切过去），可以同时开好几个，切走的只隐藏、状态都在；
 * - 双击任意标签铺满整个对话区，主会话变成第一个标签（不能关）；再双击 / Esc / 右上角按钮回到分栏；
 * - 文件预览（预览区的文件 / Diff 标签）显示在“打开文件”页内部；
 * - 标签可以拖动排序；拖出窗口 / 右键「在新窗口打开」弹到独立窗口；铺满时可以「向右拆分」（左主会话、右标签）；
 * - 侧边聊天（只问 Nomi 的临时聊天）也是这一排里的可关闭标签；内容只在内存里。
 * 状态在 SubagentPaneContext（按会话各记一份），文件预览状态来自 App 的 useResourcePreview。
 * 设计见 docs/design/side-tabs-workspace.md。
 */
import { t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SplitWidth } from '../../app/useSplitWidths';
import { useResourceContext } from '../../contexts/ResourceContext';
import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import type { EmbeddedPreviewProps } from '../../hooks/useResourcePreview';
import { useDirectionalTabMotion } from '../../hooks/useTabMotion';
import { detachedWindows } from '../../services/detachedWindows';
import { persistWorkspaceTreeOpen, readWorkspaceTreeOpen } from '../../services/filesRailPrefs';
import { isMac } from '../../services/shortcuts';
import { exportSideChat, forgetSideChat, sideChatState } from '../../services/sideChat';
import type { ConvMessage } from '../../types/conversation';
import {
  canDetachTarget,
  detachedId,
  parseDetachedId,
  type DetachSpec,
} from '../../utils/detachedTabs';
import { isImeComposing, shouldIgnoreEscape } from '../../utils/keyboard';
import {
  cycleTabKey,
  CHANGES_SIDE_TAB,
  FILES_SIDE_TAB,
  fileTabKey,
  isMaximized,
  isSplit,
  pageKey,
  OPEN_FILE_SIDE_TAB,
  MAIN_SIDE_TAB,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  sideTabItems,
  type SideTabItem,
} from '../../utils/sideTabs';
import type { PreviewEntry, PreviewTabsControl } from '../ResourcePreview/ResourcePreview';
import { CenterChangesHost, useChangesUi } from '../SessionWorkspace';
import { SideChatPane } from '../SideChat';
import { SubagentPane, type SubagentPaneActions } from '../SubagentPane';
import { InTabStripProvider } from '../SubagentPane/chrome';

import { BrowserTab } from './BrowserTab';
import { ChangesTab } from './ChangesTab';
import { NewTabPage } from './NewTabPage';
import { OpenFileTab } from './OpenFileTab';
import styles from './SideWorkspace.module.css';
import { SideTabStrip } from './TabStrip';

export { SideTabStrip };

/** 预览区状态（App 的 useResourcePreview） */
export interface SideFiles {
  entries: readonly PreviewEntry[];
  activeKey: string;
  render: (p: EmbeddedPreviewProps) => React.ReactNode;
  /** 当内部预览组件尚未挂载控制句柄时，直接移除指定预览条目的兜底回调 */
  closeEntries?: (keys: string[]) => void;
  /** 打开文件 / 变更页右侧文件树的宽度控制。 */
  railSplit: SplitWidth;
}

/**
 * 标签区的状态和操作（App 里用一次，标签栏和主体共用）：当前是哪个标签、是否铺满、切换 / 关闭 / 双击。
 * 文件标签的切换和关闭交给预览区（先存草稿等），经 control 句柄。
 */
export function useSideWorkspace(files: SideFiles) {
  const pane = useSubagentPane();
  const { closeWorkbench } = useChangesUi();
  // 普通的可变对象（不是 ref）：随 model 往下传给预览区和标签栏
  const [control] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const [diffControl] = useState<{ current: PreviewTabsControl | null }>(() => ({ current: null }));
  const [treeOpen, setTreeOpen] = useState<boolean>(readWorkspaceTreeOpen);
  const toggleTree = useCallback(() => {
    setTreeOpen((prev) => {
      const next = !prev;
      persistWorkspaceTreeOpen(next);
      return next;
    });
  }, []);
  const scope = pane?.scope ?? '';
  const detached = pane?.detached;
  // 弹到独立窗口的文件不在这一侧显示
  const fileKeys = useMemo(
    () =>
      files.entries
        .map((e) => e.key)
        .filter((key) => !files.entries.find((entry) => entry.key === key)?.diff)
        .filter((k) => !detached?.size || !detached.has(fileTabKey(k))),
    [files.entries, detached],
  );
  const hasFiles = fileKeys.length > 0;
  const diffKeys = useMemo(
    () => files.entries.filter((entry) => !!entry.diff).map((entry) => entry.key),
    [files.entries],
  );
  const hasDiffs = diffKeys.length > 0;
  const tabs = pane?.tabs;
  const setFilesOpen = pane?.setFilesOpen;
  useEffect(() => {
    setFilesOpen?.(hasFiles);
  }, [hasFiles, setFilesOpen]);
  useEffect(() => {
    if (!pane || !hasFiles || tabs?.pages.some((p) => p.kind === 'open-file')) return;
    pane.openFileBrowser?.();
  }, [pane, hasFiles, tabs?.pages]);
  // 删除预览区最后一个文件 / Diff 后，先让预览状态移除，再移除对应的空工作区页。
  // 用前一次状态区分“刚关闭最后一项”和“用户主动打开空页面”，后者要保留；
  // 会话切换时只重置基准快照，绝不把切到无文件会话误判为“关闭最后一项”。
  const previousPreview = useRef({ scope, files: hasFiles, diffs: hasDiffs });
  useEffect(() => {
    const previous = previousPreview.current;
    previousPreview.current = { scope, files: hasFiles, diffs: hasDiffs };
    if (previous.scope !== scope) return;
    if (!pane || !tabs) return;
    if (previous.files && !hasFiles && tabs.pages.some((p) => p.kind === 'open-file'))
      pane.closeTab(OPEN_FILE_SIDE_TAB);
    if (previous.diffs && !hasDiffs && tabs.pages.some((p) => p.kind === 'changes')) {
      closeWorkbench();
      pane.closeTab(CHANGES_SIDE_TAB);
    }
  }, [scope, pane, tabs, hasFiles, hasDiffs, closeWorkbench]);
  const items = useMemo(() => (tabs ? sideTabItems(tabs) : []), [tabs]);
  const maximized = !!tabs && isMaximized(tabs, hasFiles);
  const split = !!tabs && isSplit(tabs, hasFiles);
  const splitRatio = tabs?.splitRatio ?? 0.5;
  const active = pane?.active ?? null;
  const open = !!pane && pane.paneVisible;
  const mounted =
    !!pane &&
    (pane.paneVisible ||
      (tabs != null && (tabs.agents.length > 0 || hasFiles || tabs.pages.length > 0)));
  /** 标签栏上高亮的那个：文件时是预览区当前的文件 */
  const stripActive = active === FILES_SIDE_TAB ? OPEN_FILE_SIDE_TAB : active;
  const activate = useCallback(
    (item: SideTabItem) => {
      if (!pane) return;
      if (item.kind === 'file') {
        pane.activate(OPEN_FILE_SIDE_TAB);
        if (item.entryKey) control.current?.activate(item.entryKey);
        return;
      }
      pane.activate(item.key);
    },
    [pane, control],
  );
  const close = useCallback(
    (item: SideTabItem) => {
      if (!pane || !item.closable) return;
      if (item.kind === 'file') {
        if (item.entryKey) control.current?.close([item.entryKey]);
        return;
      }
      // 关闭顶层「打开文件」标签：一并关闭里面打开的所有预览文件（走草稿保存守卫），清空后自动退出标签区
      if (item.kind === 'open-file') {
        if (fileKeys.length > 0) {
          if (control.current) {
            control.current.close(fileKeys);
          } else {
            files.closeEntries?.(fileKeys);
            pane.closeTab(OPEN_FILE_SIDE_TAB);
          }
          return;
        }
        pane.closeTab(OPEN_FILE_SIDE_TAB);
        return;
      }
      // 关闭顶层「变更（Diff）」标签：一并关闭里面打开的所有 Diff 预览并清理 workbench，退出标签区
      if (item.kind === 'changes') {
        if (diffKeys.length > 0) {
          if (diffControl.current) {
            diffControl.current.close(diffKeys);
          } else {
            files.closeEntries?.(diffKeys);
            closeWorkbench();
            pane.closeTab(CHANGES_SIDE_TAB);
          }
          return;
        }
        closeWorkbench();
        pane.closeTab(CHANGES_SIDE_TAB);
        return;
      }
      pane.closeTab(item.key);
    },
    [pane, control, diffControl, fileKeys, diffKeys, files, closeWorkbench],
  );
  const toggleMaximized = useCallback(
    (item?: SideTabItem) => {
      if (!pane) return;
      if (item?.kind === 'file') {
        if (item.entryKey) control.current?.activate(item.entryKey);
        pane.toggleMaximized(OPEN_FILE_SIDE_TAB);
        return;
      }
      pane.toggleMaximized(item?.key);
    },
    [pane, control],
  );
  const restore = useCallback(() => pane?.restore(), [pane]);
  const toggleSplit = useCallback(
    (item?: SideTabItem) => {
      if (!pane) return;
      if (item?.kind === 'file') {
        if (item.entryKey) control.current?.activate(item.entryKey);
        pane.toggleSplit(OPEN_FILE_SIDE_TAB);
        return;
      }
      pane.toggleSplit(item?.key);
    },
    [pane, control],
  );
  const setSplitRatio = useCallback((r: number) => pane?.setSplitRatio(r), [pane]);
  const move = useCallback(
    (key: string, toIndex: number) => pane?.moveTab(items, key, toIndex),
    [pane, items],
  );
  const entryOf = useCallback(
    (item: SideTabItem) =>
      item.entryKey ? files.entries.find((e) => e.key === item.entryKey) : undefined,
    [files.entries],
  );
  const canDetach = useCallback(
    (item: SideTabItem) => {
      if (!detachedWindows.available()) return false;
      if (item.target?.kind === 'side-chat')
        // 侧边聊天的内容在这个窗口的内存里：正在回答时不交接
        return !sideChatState(item.target.chatId)?.running;
      if (item.kind === 'agent') return !!item.target && canDetachTarget(item.target);
      if (item.kind === 'file') return !!entryOf(item) && !entryOf(item)!.diff;
      return false;
    },
    [entryOf],
  );
  /** 弹到独立窗口：子任务这一侧先隐藏（窗口关掉后回来）；文件从这一侧移过去 */
  const detach = useCallback(
    (item: SideTabItem, title: string) => {
      if (!canDetach(item)) return;
      let spec: DetachSpec | null = null;
      if (item.kind === 'agent' && item.target)
        spec = { v: 1, kind: 'agent', scope, target: item.target, title };
      const entry = entryOf(item);
      if (item.kind === 'file' && entry)
        spec = {
          v: 1,
          kind: 'file',
          scope,
          key: item.key,
          href: entry.href,
          origin: { ...entry.scope },
          title,
        };
      if (!spec) return;
      const target = item.target;
      if (target?.kind === 'side-chat') {
        // 内容先交给宿主（新窗口取走）；弹出成功后这一侧不再持有
        const data = exportSideChat(target.chatId);
        if (!data) return;
        const id = detachedId(scope, item.key);
        void detachedWindows
          .put(id, data)
          .then((ok) => (ok ? detachedWindows.detach(spec!) : false))
          .then((ok) => {
            if (ok) forgetSideChat(target.chatId);
            else void detachedWindows.take(id);
          });
        return;
      }
      void detachedWindows.detach(spec).then((ok) => {
        if (ok && item.kind === 'file' && item.entryKey) control.current?.close([item.entryKey]);
      });
    },
    [canDetach, entryOf, scope, control],
  );
  // 弹出窗口里「放回主窗口」：切到那个标签（标签回到标签栏由 detachedChanged 负责）
  const activateKey = pane?.activate;
  useEffect(
    () =>
      detachedWindows.onDocked((id) => {
        const p = parseDetachedId(id);
        if (p && p.scope === scope && !p.key.startsWith('file:')) activateKey?.(p.key);
      }),
    [scope, activateKey],
  );
  const setExpanded = useCallback(
    (next: boolean) => {
      if (!pane) return;
      if (next === maximized) return;
      const target = pane.active === CHANGES_SIDE_TAB ? CHANGES_SIDE_TAB : OPEN_FILE_SIDE_TAB;
      if (next) pane.toggleMaximized(target);
      else pane.restore();
    },
    [pane, maximized],
  );
  return {
    available: !!pane,
    open,
    maximized,
    active,
    stripActive,
    items,
    meta: pane?.meta ?? {},
    activate,
    close,
    toggleMaximized,
    restore,
    setExpanded,
    control,
    diffControl,
    treeOpen,
    toggleTree,
    files,
    split,
    splitRatio,
    toggleSplit,
    setSplitRatio,
    move,
    canDetach,
    detach,
    entryOf,
    scope,
    newSideChat: pane ? () => void pane.openSideChat({ fresh: true }) : undefined,
    openNewTab: pane ? () => void pane.openNewTab() : undefined,
    openChanges: pane ? pane.openChanges : undefined,
    openFileBrowser: pane ? pane.openFileBrowser : undefined,
    pages: pane?.pages ?? [],
    mounted,
    openBrowser: pane ? pane.openBrowser : undefined,
    setBrowserUrl: pane ? pane.setBrowserUrl : undefined,
    openSideChat: pane ? pane.openSideChat : undefined,
  };
}

export type SideWorkspaceModel = ReturnType<typeof useSideWorkspace>;

/** 键盘：焦点在标签区（铺满时整个对话区）里时，Ctrl+Tab 轮换标签、⌘/Ctrl+W 关当前标签；铺满时 Esc 回到分栏 */
export function useSideWorkspaceKeys(model: SideWorkspaceModel) {
  const ref = useRef(model);
  useEffect(() => {
    ref.current = model;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = ref.current;
      if (!m.open || e.defaultPrevented || isImeComposing(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      const inside = !!target?.closest(
        m.maximized ? '[data-side-max="true"]' : '[data-side-workspace]',
      );
      if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) {
        if (!inside) return;
        const next = cycleTabKey(m.items, m.stripActive, e.shiftKey ? -1 : 1);
        const item = m.items.find((i) => i.key === next);
        if (!item) return;
        e.preventDefault();
        m.activate(item);
        return;
      }
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        if (!inside) return;
        const item = m.items.find((i) => i.key === m.stripActive);
        if (!item?.closable) return;
        e.preventDefault();
        m.close(item);
        return;
      }
      // 文件标签的 Esc 由预览区自己处理（铺满时先退出铺满）
      if (
        e.key === 'Escape' &&
        m.maximized &&
        m.active !== FILES_SIDE_TAB &&
        m.active !== OPEN_FILE_SIDE_TAB
      ) {
        if (shouldIgnoreEscape(e)) return;
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        e.preventDefault();
        m.restore();
      }
    };
    // 捕获阶段：先于全局的 Ctrl+Tab（agent 标签轮换）
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/**
 * 标签区主体：子任务面板（都挂着，只显示当前的）+ 文件预览（隐藏时不接管 Esc）。
 * 没有标签时退回原来的中栏挂载点（右栏的未提交 / 磁盘文件预览 portal 进来）。
 * showStrip：分栏时标签栏进桌面标题栏的中栏槽位（没有标题栏时在这一栏顶上）；铺满时由 App 画在整个对话区顶上。
 * 里面的面板不画自己的头（名字 / 状态在标签上），会话顶和输入框底与左边主对话对齐。
 */
export const SideWorkspace: React.FC<{
  model: SideWorkspaceModel;
  messages: readonly ConvMessage[];
  cwd?: string | null;
  roots?: readonly string[] | null;
  busy?: boolean;
  actions?: SubagentPaneActions;
  showStrip: boolean;
  /** 收起工作区时的退场动画标记 */
  closing?: boolean;
}> = ({ model, messages, cwd, roots, busy, actions, showStrip, closing = false }) => {
  const resource = useResourceContext();
  const orderedKeys = useMemo(() => model.items.map((i) => i.key), [model.items]);
  const tabMotion = useDirectionalTabMotion(orderedKeys, model.stripActive);
  if (!model.mounted && !model.open && !closing)
    return <CenterChangesHost messages={messages} cwd={cwd} roots={roots} mode="slot" />;
  const filesActive = model.active === FILES_SIDE_TAB || model.active === OPEN_FILE_SIDE_TAB;
  const kind =
    model.active === MAIN_SIDE_TAB
      ? 'main'
      : filesActive
        ? 'files'
        : model.active?.startsWith('side-chat:')
          ? 'chat'
          : model.active?.startsWith('new-tab:')
            ? 'new-tab'
            : model.active === 'changes'
              ? 'changes'
              : model.active === 'open-file'
                ? 'open-file'
                : model.active?.startsWith('browser:')
                  ? 'browser'
                  : 'agent';
  return (
    <section
      className={styles.workspace}
      data-testid="side-workspace"
      data-side-workspace=""
      data-active-kind={kind}
      data-closing={closing || undefined}
      hidden={(!model.open && !closing) || undefined}
    >
      {showStrip && <SideTabStrip model={model} columnMessages={messages} inTitlebar />}
      <InTabStripProvider>
        <div className={styles.body} data-tab-motion={tabMotion}>
          <SubagentPane columnMessages={messages} actions={actions} tabbed />
          {model.pages.map((page) => {
            const key = pageKey(page);
            const scopedPageKey = `${model.scope}\0${key}`;
            const hidden =
              page.kind === 'open-file'
                ? model.active !== key && model.active !== FILES_SIDE_TAB
                : model.active !== key;
            if (page.kind === 'new-tab')
              return (
                <NewTabPage
                  key={scopedPageKey}
                  tabKey={key}
                  hidden={hidden}
                  cwd={cwd}
                  roots={roots}
                  onOpenChanges={() => model.openChanges?.({ replace: key })}
                  onOpenFiles={() => model.openFileBrowser?.({ replace: key })}
                  onOpenSideChat={() => void model.openSideChat?.({ fresh: true, replace: key })}
                  onOpenBrowser={(url) => model.openBrowser?.(url, { replace: key })}
                  onOpenFile={(href, root) => {
                    // 文件预览归入“打开文件”页面内部；新标签页由打开文件页替换。
                    model.openFileBrowser?.({ replace: key });
                    resource?.open(href, { ...resource.scope, cwd: root });
                  }}
                />
              );
            if (page.kind === 'changes')
              return (
                <ChangesTab
                  key={scopedPageKey}
                  hidden={hidden}
                  messages={messages}
                  cwd={cwd}
                  roots={roots}
                  busy={busy}
                  renderPreview={model.files.render}
                  expanded={model.maximized}
                  onExpanded={model.setExpanded}
                  controlRef={model.diffControl}
                  railSplit={model.files.railSplit}
                  treeOpen={model.treeOpen}
                  onToggleTree={model.toggleTree}
                />
              );
            if (page.kind === 'side-chat')
              return (
                <SideChatPane
                  key={scopedPageKey}
                  chatId={page.id}
                  cwd={cwd}
                  slot={{ tabKey: key, active: !hidden }}
                  onClose={() => model.close({ key, kind: 'side-chat', closable: true, page })}
                />
              );
            if (page.kind === 'open-file')
              return (
                <OpenFileTab
                  key={scopedPageKey}
                  hidden={hidden}
                  messages={messages}
                  cwd={cwd}
                  roots={roots}
                  busy={busy}
                  renderPreview={model.files.render}
                  expanded={model.maximized}
                  onExpanded={model.setExpanded}
                  controlRef={model.control}
                  railSplit={model.files.railSplit}
                  treeOpen={model.treeOpen}
                  onToggleTree={model.toggleTree}
                />
              );
            return (
              <BrowserTab
                key={scopedPageKey}
                tabKey={key}
                url={page.url}
                title={page.title}
                hidden={hidden}
                onNavigate={(url, title) => model.setBrowserUrl?.(key, url, title)}
              />
            );
          })}
        </div>
      </InTabStripProvider>
    </section>
  );
};

/**
 * 拆分时主会话和右边标签之间的分割线：拖动改左右宽度（按整个对话区算比例），双击回到一半；
 * 键盘：←/→ 每次 5%。
 */
export const SideSplitHandle: React.FC<{
  ratio: number;
  onRatio: (ratio: number) => void;
}> = ({ ratio, onRatio }) => {
  const drag = useRef<{ left: number; width: number } | null>(null);
  return (
    <div
      className="side-split-splitter"
      data-testid="side-split-splitter"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('ui.session-workspace.side-split-handle')}
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={(e) => {
        const box = e.currentTarget.parentElement?.getBoundingClientRect();
        if (!box || box.width <= 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { left: box.left, width: box.width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onRatio((e.clientX - d.left) / d.width);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onRatio(0.5)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onRatio(ratio + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        }
      }}
    />
  );
};
