/**
 * 侧栏收起时的对话列表：每个对话一个方块，方块里是端点图标（Nomi / Claude Code / Codex…），
 * 右上角是运行状态点，当前对话高亮。
 * 悬停 / 键盘聚焦时立刻在方块右侧弹出一张卡片：完整标题 + 端点 · 多久前 · 状态（不用等系统 title）。
 * 卡片挂到 body 上用 fixed 定位，不会被侧栏的 overflow 裁掉。放不下的用「+N」展开侧栏看全部。
 */
import { t, useLocale } from '@nomi-ai/ui';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import type { HarnessTabMeta } from '../../services/harnessClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import rail from './CollapsedRail.module.css';
import styles from './index.module.css';
import { liveOf, rel } from './SidebarRows';
import type { Meta } from './types';

/** 收起态最多列出的对话数（其余展开侧栏查看） */
export const RAIL_MAX = 30;

/** 状态点对应的文字（卡片第二行）；没有特别状态时不显示 */
const LIVE_LABEL: Record<string, string> = {
  running: 'ui.chat-settings.in-progress',
  queued: 'ui.mascot-theme.queued',
  unread: 'ui.mascot-theme.new-result',
  error: 'ui.chat-settings.error',
  background: 'ui.chat-settings.running-in-background',
  dormant: 'ui.cli-monitor.dormant',
};

interface Peek {
  id: string;
  top: number;
  left: number;
}

export const CollapsedRail: React.FC<{
  items: Meta[];
  activeId?: string;
  tabById: Map<string, HarnessTabMeta>;
  onOpen: (id: string) => void;
  onCtx: (id: string, e: React.MouseEvent) => void;
  onExpand: () => void;
}> = ({ items, activeId, tabById, onOpen, onCtx, onExpand }) => {
  useLocale();
  const [peek, setPeek] = useState<Peek | null>(null);
  if (!items.length) return null;
  const shown = items.slice(0, RAIL_MAX);
  const show = (id: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPeek({ id, top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hide = () => setPeek(null);
  const peeked = peek && shown.find((c) => c.id === peek.id);
  const nameOf = (c: Meta) => (c.name ? t(c.name) : t('ui.chat-settings.new-chat'));
  const liveFor = (c: Meta) => liveOf(c.tabId ? tabById.get(c.tabId) : undefined);
  const statusOf = (c: Meta) => (LIVE_LABEL[liveFor(c)] ? t(LIVE_LABEL[liveFor(c)]!) : '');

  return (
    <nav
      className={rail.rail}
      aria-label={t('ui.chat-settings.history')}
      data-testid="collapsed-rail"
      onScroll={hide}
    >
      {shown.map((c) => {
        const live = liveFor(c);
        return (
          <button
            key={c.id}
            type="button"
            className={rail.item}
            data-active={c.id === activeId || undefined}
            onClick={() => {
              hide();
              void onOpen(c.id);
            }}
            onContextMenu={(e) => {
              hide();
              onCtx(c.id, e);
            }}
            onMouseEnter={(e) => show(c.id, e.currentTarget)}
            onMouseLeave={hide}
            onFocus={(e) => show(c.id, e.currentTarget)}
            onBlur={hide}
            aria-label={nameOf(c)}
            aria-current={c.id === activeId ? 'page' : undefined}
            data-testid="collapsed-rail-item"
            data-conversation-id={c.id}
          >
            <EndpointIcon backend={c.backend} size={20} decorative />
            <span className={`${styles.dot} ${rail.dot}`} data-live={live || undefined} />
          </button>
        );
      })}
      {items.length > RAIL_MAX && (
        <button
          type="button"
          className={rail.more}
          onClick={onExpand}
          title={t('ui.chat-settings.expand-sidebar-ctrl-b')}
          aria-label={t('ui.chat-settings.expand-sidebar')}
          data-testid="collapsed-rail-more"
        >
          +{items.length - RAIL_MAX}
        </button>
      )}
      {peek &&
        peeked &&
        createPortal(
          <div
            className={rail.peek}
            style={{ top: peek.top, left: peek.left }}
            role="tooltip"
            data-testid="collapsed-rail-peek"
          >
            <span className={rail.peekTitle}>{nameOf(peeked)}</span>
            <span className={rail.peekMeta}>
              {[t(ENDPOINT_NAME[peeked.backend]), rel(peeked.updatedAt), statusOf(peeked)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>,
          document.body,
        )}
    </nav>
  );
};
