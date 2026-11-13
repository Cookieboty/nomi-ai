/**
 * 标签区的标签栏（参考浏览器 / Codex 的分栏标签）：图标 + 名字 + 状态点 + ×；末尾是「+」、拆分、弹出、铺满 / 还原。
 * - 拖动标签排序（主会话标签固定在最前）；键盘：焦点在标签上时 Ctrl+Shift+PageUp/PageDown 或 Alt+Shift+←/→；
 * - 拖出窗口松手 = 弹到独立窗口；拖到「拆分」按钮上 = 向右拆分；
 * - 子任务标签（包括侧边聊天）右键（或 Shift+F10）：在新窗口打开 / 向右拆分 / 关闭；
 *   文件标签右键是预览区自己的菜单；
 * - 鼠标停在不在看的子任务标签上：悬停卡片（AgentHoverCard）；
 * - 「+」：新侧边聊天 / 浏览文件。
 */
import { Icon, IconButton, t } from '@nomi-ai/ui';
import {
  Bot,
  Columns2,
  FileText,
  GitCompareArrows,
  Maximize2,
  MessageCirclePlus,
  MessageSquare,
  Minimize2,
  Plus,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import type { SideTabMeta } from '../../contexts/SubagentPaneContext';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { basename, resourceTarget } from '../../utils/resourceLinks';
import { dropIndex, type SideTabItem, type SubagentTarget } from '../../utils/sideTabs';
import { AgentHoverCard, setHoverCardsSuppressed } from '../AgentHoverCard';
import { EndpointIcon } from '../EndpointIcon';
import type { PreviewEntry } from '../ResourcePreview/ResourcePreview';

import styles from './SideWorkspace.module.css';

import type { SideWorkspaceModel } from './index';

const DRAG_TYPE = 'application/x-nomi-side-tab';

const fileLabel = (entry: PreviewEntry) =>
  basename(entry.diff?.path ?? resourceTarget(entry.href)?.path ?? entry.href);

const TabIcon: React.FC<{
  item: SideTabItem;
  backendOf: (t: SubagentTarget) => string | null;
  entry?: PreviewEntry;
}> = ({ item, backendOf, entry }) => {
  if (item.kind === 'main') return <Icon icon={MessageSquare} size={14} />;
  if (item.target?.kind === 'side-chat') return <Icon icon={MessageCirclePlus} size={14} />;
  if (item.kind === 'file')
    return <Icon icon={entry?.diff ? GitCompareArrows : FileText} size={14} />;
  const backend = item.target ? backendOf(item.target) : null;
  if (backend && backend in ENDPOINT_NAME)
    return <EndpointIcon backend={backend as keyof typeof ENDPOINT_NAME} size={14} decorative />;
  return <Icon icon={Bot} size={14} />;
};

const fallbackName = (target: SubagentTarget | undefined, backend: string | null) => {
  if (target?.kind === 'harness' && backend && backend in ENDPOINT_NAME)
    return t(ENDPOINT_NAME[backend as keyof typeof ENDPOINT_NAME]);
  if (target?.kind === 'side-chat') return t('ui.session-workspace.side-chat-title');
  return t('ui.usage-tools.subagent');
};

/** 松手时指针在窗口外（拖出窗口） */
const outsideWindow = (e: React.DragEvent) =>
  e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;

/** 点外面 / Esc 收起菜单 */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, ref, close]);
}

interface TabMenu {
  item: SideTabItem;
  x: number;
  y: number;
}

export const SideTabStrip: React.FC<{
  model: SideWorkspaceModel;
  /** 主列消息（主会话里进程内子代理的悬停卡片用） */
  columnMessages?: readonly ConvMessage[];
  onBrowseFiles?: () => void;
}> = ({ model, columnMessages, onBrowseFiles }) => {
  const harness = useHarnessTabs();
  const backendOf = useCallback(
    (target: SubagentTarget): string | null => {
      if (target.kind === 'nomi-task' || target.kind === 'side-chat') return 'nomi';
      if (target.kind === 'harness')
        return harness.state?.tabs.find((x) => x.id === target.tabId)?.backend ?? null;
      return null;
    },
    [harness.state?.tabs],
  );
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean } | null>(null);
  const [splitHot, setSplitHot] = useState(false);
  // 键盘排序后焦点跟着标签走（排好后的下一次渲染里聚焦）
  const refocus = useRef<string | null>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  useDismiss(menu, menuRef, closeMenu);
  useDismiss(!!tabMenu, tabMenuRef, closeTabMenu);
  // 当前标签被挤到可见范围外（标签多、这一栏窄）时滚过去
  const current = model.stripActive;
  const tabEl = (key: string) =>
    Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[data-side-tab-key]') ?? []).find(
      (x) => x.dataset.sideTabKey === key,
    );
  useEffect(() => {
    if (!current) return;
    tabEl(current)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    tabEl(key)?.querySelector<HTMLElement>('[role="tab"]')?.focus();
  }, [model.items]);
  // 拖动结束（不论落在哪）：恢复悬停卡片
  useEffect(() => {
    if (!drag) return;
    setHoverCardsSuppressed(true);
    return () => setHoverCardsSuppressed(false);
  }, [drag]);
  const label = (item: SideTabItem): string => {
    if (item.kind === 'main') return t('ui.session-workspace.side-tab-main');
    if (item.kind === 'file') {
      const entry = model.entryOf(item);
      return entry ? fileLabel(entry) : '';
    }
    const meta: SideTabMeta | undefined = model.meta[item.key];
    return meta?.name || fallbackName(item.target, item.target ? backendOf(item.target) : null);
  };
  const currentItem = model.items.find((i) => i.key === model.stripActive);
  const sideItem = currentItem && currentItem.kind !== 'main' ? currentItem : undefined;
  const moveBy = (item: SideTabItem, dir: -1 | 1) => {
    const index = model.items.findIndex((i) => i.key === item.key);
    refocus.current = item.key;
    model.move(item.key, index + dir);
  };
  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
    setSplitHot(false);
  };
  return (
    <div className={styles.strip} data-testid="side-tab-strip">
      <div
        ref={stripRef}
        className={styles.tabs}
        role="tablist"
        aria-label={t('ui.session-workspace.side-tabs-label')}
      >
        {model.items.map((item) => {
          const selected = item.key === model.stripActive;
          const state = item.kind === 'agent' ? model.meta[item.key]?.state : undefined;
          const name = label(item);
          const movable = item.kind !== 'main';
          return (
            <div
              key={item.key}
              className={styles.tab}
              data-active={selected || undefined}
              data-kind={item.kind}
              data-dragging={drag === item.key || undefined}
              data-drop={dropAt?.key === item.key ? (dropAt.after ? 'after' : 'before') : undefined}
              data-testid="side-tab"
              data-side-tab-key={item.key}
              draggable={movable}
              onDragStart={(e) => {
                if (!movable) return;
                e.dataTransfer.setData(DRAG_TYPE, item.key);
                e.dataTransfer.effectAllowed = 'move';
                setDrag(item.key);
              }}
              onDragOver={(e) => {
                if (!drag || drag === item.key) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const box = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > box.left + box.width / 2;
                if (dropAt?.key !== item.key || dropAt.after !== after)
                  setDropAt({ key: item.key, after });
              }}
              onDragLeave={() => {
                if (dropAt?.key === item.key) setDropAt(null);
              }}
              onDrop={(e) => {
                if (!drag) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > box.left + box.width / 2;
                model.move(drag, dropIndex(model.items, drag, item.key, after));
                endDrag();
              }}
              onDragEnd={(e) => {
                // 拖出窗口松手：弹到独立窗口
                if (drag && e.dataTransfer.dropEffect === 'none' && outsideWindow(e))
                  model.detach(item, name);
                endDrag();
              }}
              onContextMenu={
                item.kind === 'file' && item.entryKey
                  ? (event) => {
                      event.preventDefault();
                      const trigger =
                        event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')!;
                      model.control.current?.openMenu({
                        key: item.entryKey!,
                        x: event.clientX,
                        y: event.clientY,
                        trigger,
                      });
                    }
                  : item.kind === 'agent'
                    ? (event) => {
                        event.preventDefault();
                        setTabMenu({ item, x: event.clientX, y: event.clientY });
                      }
                    : undefined
              }
            >
              <AgentHoverCard
                target={item.kind === 'agent' ? item.target : null}
                disabled={selected || !!drag}
                columnMessages={columnMessages}
                onOpen={() => model.activate(item)}
                className={styles.hoverWrap}
              >
                <button
                  type="button"
                  role="tab"
                  className={styles.tabMain}
                  aria-selected={selected}
                  onClick={() => model.activate(item)}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    model.toggleMaximized(item);
                  }}
                  onMouseDown={(e) => {
                    // 中键关标签（和浏览器一样）
                    if (e.button === 1 && item.closable) {
                      e.preventDefault();
                      model.close(item);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (!movable) return;
                    const pg = e.ctrlKey && e.shiftKey && !e.altKey;
                    const arrow = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
                    if ((pg && e.key === 'PageUp') || (arrow && e.key === 'ArrowLeft')) {
                      e.preventDefault();
                      moveBy(item, -1);
                    } else if ((pg && e.key === 'PageDown') || (arrow && e.key === 'ArrowRight')) {
                      e.preventDefault();
                      moveBy(item, 1);
                    } else if (item.kind === 'agent' && e.shiftKey && e.key === 'F10') {
                      e.preventDefault();
                      const box = e.currentTarget.getBoundingClientRect();
                      setTabMenu({ item, x: box.left, y: box.bottom });
                    }
                  }}
                >
                  <TabIcon item={item} backendOf={backendOf} entry={model.entryOf(item)} />
                  <span className={styles.tabLabel}>{name}</span>
                  {state && state !== 'idle' && (
                    <span
                      className={styles.dot}
                      data-state={state}
                      data-testid="side-tab-status"
                      aria-label={
                        state === 'waiting'
                          ? t('ui.session-workspace.needs-your-approval')
                          : t('ui.knowledge-local.running')
                      }
                    />
                  )}
                </button>
              </AgentHoverCard>
              {item.closable && (
                <button
                  type="button"
                  className={styles.close}
                  aria-label={t('ui.session-workspace.side-tab-close', name)}
                  data-testid="side-tab-close"
                  onClick={() => model.close(item)}
                >
                  <Icon icon={X} size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {tabMenu && (
        <div
          ref={tabMenuRef}
          className={`${styles.menu} ${styles.menuFixed}`}
          role="menu"
          data-testid="side-tab-menu"
          style={{
            left: Math.max(4, Math.min(tabMenu.x, window.innerWidth - 220)),
            top: tabMenu.y,
          }}
        >
          {model.canDetach(tabMenu.item) && (
            <button
              type="button"
              role="menuitem"
              data-testid="side-tab-detach"
              onClick={() => {
                setTabMenu(null);
                model.detach(tabMenu.item, label(tabMenu.item));
              }}
            >
              <Icon icon={SquareArrowOutUpRight} size={14} />
              {t('ui.session-workspace.side-tab-detach')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            data-testid="side-tab-split"
            onClick={() => {
              setTabMenu(null);
              model.toggleSplit(tabMenu.item);
            }}
          >
            <Icon icon={Columns2} size={14} />
            {t(
              model.split
                ? 'ui.session-workspace.side-tab-unsplit'
                : 'ui.session-workspace.side-tab-split',
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setTabMenu(null);
              model.close(tabMenu.item);
            }}
          >
            <Icon icon={X} size={14} />
            {t('ui.session-workspace.side-tab-close', label(tabMenu.item))}
          </button>
        </div>
      )}
      {(onBrowseFiles || model.newSideChat) && (
        <div className={styles.addWrap} ref={menuRef}>
          <IconButton
            size="sm"
            label={t('ui.session-workspace.side-tab-add')}
            icon={<Icon icon={Plus} size={14} />}
            onClick={() => setMenu((v) => !v)}
            aria-expanded={menu}
            aria-haspopup="menu"
            data-testid="side-tab-add"
          />
          {menu && (
            <div className={styles.menu} role="menu">
              {model.newSideChat && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="side-tab-new-chat"
                  onClick={() => {
                    setMenu(false);
                    model.newSideChat?.();
                  }}
                >
                  <Icon icon={MessageCirclePlus} size={14} />
                  {t('ui.session-workspace.side-chat-new')}
                </button>
              )}
              {onBrowseFiles && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onBrowseFiles();
                  }}
                >
                  <Icon icon={FileText} size={14} />
                  {t('ui.session-workspace.side-tab-browse-files')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {(sideItem || model.split) && (
        <span
          className={styles.dropTarget}
          data-hot={splitHot || undefined}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            setSplitHot(true);
          }}
          onDragLeave={() => setSplitHot(false)}
          onDrop={(e) => {
            if (!drag) return;
            e.preventDefault();
            const item = model.items.find((i) => i.key === drag);
            if (item && !model.split) model.toggleSplit(item);
            else if (item) model.activate(item);
            endDrag();
          }}
        >
          <IconButton
            size="sm"
            label={t(
              model.split
                ? 'ui.session-workspace.side-tab-unsplit'
                : 'ui.session-workspace.side-tab-split',
            )}
            icon={<Icon icon={Columns2} size={14} />}
            aria-pressed={model.split}
            onClick={() => model.toggleSplit(sideItem)}
            data-testid="side-tab-split-toggle"
          />
        </span>
      )}
      {sideItem && model.canDetach(sideItem) && (
        <IconButton
          size="sm"
          label={t('ui.session-workspace.side-tab-detach')}
          icon={<Icon icon={SquareArrowOutUpRight} size={14} />}
          onClick={() => model.detach(sideItem, label(sideItem))}
          data-testid="side-tab-popout"
        />
      )}
      <IconButton
        size="sm"
        label={t(
          model.maximized
            ? 'ui.session-workspace.side-tab-restore'
            : 'ui.session-workspace.side-tab-maximize',
        )}
        icon={<Icon icon={model.maximized ? Minimize2 : Maximize2} size={14} />}
        onClick={() => (model.maximized ? model.restore() : model.toggleMaximized(currentItem))}
        data-testid="side-tab-maximize"
      />
    </div>
  );
};
