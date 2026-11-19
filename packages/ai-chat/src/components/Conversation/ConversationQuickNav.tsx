/** 会话右侧/左侧边栏的轮次快捷导航条（悬停预览每轮助手摘要，点击平滑跳至对应轮次） */
import { FloatingTip, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import styles from './index.module.css';

/** 快捷导航只显示助手回复的摘要，避免悬停卡片展开整段 Markdown / 代码内容。 */
export function summarizeAssistantText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const blocks = normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const block =
    blocks.find(
      (candidate) => !candidate.startsWith('```') && !/^#{1,6}\s+[^\n]+$/.test(candidate.trim()),
    ) ??
    blocks[0] ??
    normalized;
  const summary = block
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength).trimEnd()}…`;
}

export function firstSentence(text: string): string {
  const match = text.match(/^(.+?[。！？!?])/);
  if (match?.[1]) return match[1].trim();
  const period = text.search(/\.\s/);
  if (period >= 0) return text.slice(0, period + 1).trim();
  return text.trim();
}

/** 仅在快捷导航自身容器内滚动对应刻度线，绝不调原生 scrollIntoView 连带滚动外层页面 / 对话滚区 */
function scrollChildIntoNav(nav: HTMLElement | null, child: HTMLElement | null): void {
  if (!nav || !child) return;
  const navRect = nav.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  if (navRect.height <= 0 || childRect.height <= 0) return;
  if (childRect.top < navRect.top) nav.scrollTop += childRect.top - navRect.top;
  else if (childRect.bottom > navRect.bottom) nav.scrollTop += childRect.bottom - navRect.bottom;
}

const HOVER_WIDTHS = [24, 18, 14, 10] as const;
const HOVER_HEIGHTS = [4, 3, 2, 2] as const;

const ConversationQuickNavItem = React.memo(function ConversationQuickNavItem({
  item,
  distance,
  inView,
  tabIndex,
  onNavigate,
  onHover,
  onKeyDown,
}: {
  item: { turnIndex: number; width: number; title: string; detail: string };
  distance: number;
  inView: boolean;
  tabIndex: number;
  onNavigate: (index: number) => void;
  onHover: (index: number, el: HTMLButtonElement) => void;
  onKeyDown: (index: number, e: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const hovered = distance >= 0 && distance <= 3;
  const style = {
    '--quick-nav-width': `${item.width}px`,
    '--quick-nav-sx': hovered ? String(HOVER_WIDTHS[distance]! / item.width) : '1',
    '--quick-nav-sy': hovered ? String(HOVER_HEIGHTS[distance]! / 2) : '1',
  } as CSSProperties;
  return (
    <button
      type="button"
      className={styles.quickNavItem}
      aria-label={t('ui.chat-settings.jump-to-conversation-turn', String(item.turnIndex + 1))}
      data-in-view={inView ? 'true' : undefined}
      data-testid="conversation-quick-nav-item"
      data-turn-index={item.turnIndex}
      tabIndex={tabIndex}
      onMouseEnter={(e) => onHover(item.turnIndex, e.currentTarget)}
      onFocus={(e) => onHover(item.turnIndex, e.currentTarget)}
      onKeyDown={(e) => onKeyDown(item.turnIndex, e)}
      onClick={() => onNavigate(item.turnIndex)}
    >
      <span className={styles.quickNavLine} style={style} />
    </button>
  );
});

export const ConversationQuickNav: React.FC<{
  items: readonly { turnIndex: number; width: number; title: string; detail: string }[];
  visibleIndices: ReadonlySet<number>;
  onNavigate: (index: number) => void;
}> = ({ items, visibleIndices, onNavigate }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const onHover = useCallback((turnIndex: number, el: HTMLButtonElement) => {
    setHovered(turnIndex);
    setAnchor(el);
    setViewport(el.closest<HTMLElement>('[data-testid="conversation"]'));
  }, []);
  const clearHover = useCallback(() => {
    setHovered(null);
    setAnchor(null);
    setViewport(null);
  }, []);
  const onItemKeyDown = useCallback(
    (turnIndex: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End')
        return;
      e.preventDefault();
      const pos = items.findIndex((item) => item.turnIndex === turnIndex);
      if (pos < 0) return;
      const next =
        e.key === 'ArrowDown'
          ? Math.min(items.length - 1, pos + 1)
          : e.key === 'ArrowUp'
            ? Math.max(0, pos - 1)
            : e.key === 'Home'
              ? 0
              : items.length - 1;
      const target = items[next];
      if (!target) return;
      setFocusIndex(target.turnIndex);
      const btn = navRef.current?.querySelector<HTMLButtonElement>(
        `[data-turn-index="${target.turnIndex}"]`,
      );
      btn?.focus({ preventScroll: true });
      scrollChildIntoNav(navRef.current, btn ?? null);
      if (btn) onHover(target.turnIndex, btn);
    },
    [items, onHover],
  );
  useEffect(() => {
    if (items.length <= 5) return;
    const first = [...visibleIndices].sort((a, b) => a - b)[0];
    if (first == null) return;
    const target =
      navRef.current?.querySelector<HTMLElement>(`[data-turn-index="${first}"]`) ?? null;
    scrollChildIntoNav(navRef.current, target);
  }, [visibleIndices, items.length]);
  if (items.length <= 5) return null;
  const hoveredPosition =
    hovered === null ? -1 : items.findIndex((item) => item.turnIndex === hovered);
  const tabStop =
    focusIndex != null && items.some((item) => item.turnIndex === focusIndex)
      ? focusIndex
      : (items.find((item) => visibleIndices.has(item.turnIndex))?.turnIndex ??
        items[0]!.turnIndex);
  const hoveredItem =
    hovered === null ? undefined : items.find((item) => item.turnIndex === hovered);
  return (
    <>
      <nav
        ref={navRef}
        className={styles.quickNav}
        data-hovered={hovered === null ? undefined : 'true'}
        aria-label={t('ui.chat-settings.conversation-quick-navigation')}
        data-testid="conversation-quick-nav"
        onMouseLeave={clearHover}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          clearHover();
        }}
      >
        {items.map((item, position) => {
          const distance =
            hoveredPosition < 0 ? -1 : Math.min(4, Math.abs(position - hoveredPosition));
          return (
            <ConversationQuickNavItem
              key={item.turnIndex}
              item={item}
              distance={distance}
              inView={visibleIndices.has(item.turnIndex)}
              tabIndex={item.turnIndex === tabStop ? 0 : -1}
              onNavigate={onNavigate}
              onHover={onHover}
              onKeyDown={onItemKeyDown}
            />
          );
        })}
      </nav>
      <FloatingTip
        anchor={anchor}
        placement="side"
        viewport={viewport}
        className={styles.quickNavTip}
      >
        {hoveredItem ? (
          <>
            <span className={styles.quickNavTipTitle}>{hoveredItem.title}</span>
            {hoveredItem.detail ? (
              <span className={styles.quickNavTipText}>{hoveredItem.detail}</span>
            ) : null}
          </>
        ) : null}
      </FloatingTip>
    </>
  );
};
