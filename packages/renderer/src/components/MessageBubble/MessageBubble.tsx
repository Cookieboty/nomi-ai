import { t as tr } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './style.module.css';

import { bubbleHover, useMascot } from '@/contexts/MascotContext';
import { EMPTY_HOLD, holdOnHidden, holdOnMessage, type BubbleHold } from '@/mascot/bubbleHold';
import {
  bubbleScale,
  intersects,
  placeBubble,
  type BubblePlacement,
} from '@/mascot/bubblePlacement';
import { layoutStore } from '@/mascot/layoutStore';
import { toBubbleText } from '@/security/bubbleText';

const PREF_W = 220;

/**
 * 看板娘气泡。
 * - 只渲染纯文本（React 文本节点；见 security/bubbleText）。
 * - 位置跟随头部：放在头顶 / 头侧 / 肩下，永不压住脸，避开工具栏槽位，贴屏幕边缘时换边；
 *   尾巴指向头部。长文本在最大高度内滚动。
 * - AI 回复被截短时显示「查看全文」→ 打开对话窗口。
 */
export const MessageBubble: React.FC = () => {
  const { state } = useMascot();
  const [hold, setHold] = useState<BubbleHold>(EMPTY_HOLD);
  const [place, setPlace] = useState<BubblePlacement | null>(null);
  const [scale, setScale] = useState(1);
  const measureRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  // 模块常量里的台词（tips / 触摸反应）在显示时晚翻译
  const incoming = tr(toBubbleText(state.currentMessage));
  const incomingMore = state.messageMore === true;
  // 首帧（SSR / 初次渲染）直接用当前消息，之后经 hold 保持淡出期间的旧文本
  const live = incoming.trim() ? { text: incoming, more: incomingMore } : null;
  const text = live?.text ?? hold.text;
  const more = live ? live.more : hold.more;
  const active = !!live;

  useLayoutEffect(() => {
    // hold 根据最新消息派生，setState 立即触发级联渲染是预期的（UI 需同步跟随新消息）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHold((prev) => holdOnMessage(prev, incoming, incomingMore));
    if (incoming.trim()) return undefined;
    const timer = setTimeout(() => setHold(holdOnHidden()), 300);
    return () => clearTimeout(timer);
  }, [incoming, incomingMore]);

  const compute = useCallback(() => {
    const { head, gutter } = layoutStore.get();
    const el = measureRef.current;
    if (!head || !el) {
      setPlace(null);
      return;
    }
    const vh = window.innerHeight;
    const maxH = Math.round(Math.min(vh * 0.45, 200));
    const p = placeBubble({
      head,
      gutter,
      view: { width: window.innerWidth, height: vh },
      prefWidth: PREF_W,
      preferAbove: document.documentElement.dataset.mascotRig === 'layered',
      screen: {
        winX: window.screenX,
        availLeft: (window.screen as Screen & { availLeft?: number }).availLeft ?? 0,
        availWidth: window.screen.availWidth,
      },
      measure: (w) => {
        el.style.width = `${w}px`;
        return Math.min(el.offsetHeight, maxH);
      },
    });
    setScale(bubbleScale(head));
    setPlace((prev) =>
      prev &&
      prev.candidate === p.candidate &&
      // 防抖：小幅变化沿用旧位置，但前提是旧位置仍不压到当前的头部
      !intersects(
        { left: prev.x, right: prev.x + prev.width, top: prev.y, bottom: prev.y + prev.height },
        head,
      ) &&
      Math.abs(prev.x - p.x) < 8 &&
      Math.abs(prev.y - p.y) < 8 &&
      Math.abs(prev.width - p.width) < 8 &&
      Math.abs(prev.height - p.height) < 8
        ? prev
        : p,
    );
  }, []);

  useLayoutEffect(() => {
    compute();
  }, [compute, text, more, scale]);

  useEffect(() => {
    const off = layoutStore.subscribe(() => compute());
    window.addEventListener('resize', compute);
    const t = setInterval(compute, 1000); // 窗口被拖到屏幕边缘时重新判断
    return () => {
      off();
      window.removeEventListener('resize', compute);
      clearInterval(t);
    };
  }, [compute]);

  // 只有内容溢出（需要滚轮）时才让气泡正文接收鼠标；否则点击穿过气泡落到角色身上
  useLayoutEffect(() => {
    const sc = bubbleRef.current?.firstElementChild as HTMLElement | null;
    setScrolls(!!sc && sc.scrollHeight > sc.clientHeight + 1);
  }, [place, text, more]);

  useEffect(() => {
    document.documentElement.dataset.bubbleCandidate = place?.candidate ?? 'fixed';
  }, [place]);

  const openChat = () => {
    void window.electronAPI?.openAiChat?.();
  };

  const style: React.CSSProperties & Record<string, string | number> = place
    ? {
        left: place.x,
        top: place.y,
        width: place.width,
        '--bubble-max-h': `${place.height}px`,
        '--tail-offset': `${place.tailOffset}px`,
        '--bubble-scale': scale,
      }
    : {};

  const body = (measure: boolean) => (
    <div className={styles.scroll}>
      <span className={styles.text}>{text}</span>
      {more && (
        <button
          type="button"
          className={styles.more}
          data-testid={measure ? undefined : 'bubble-see-more'}
          tabIndex={measure ? -1 : undefined}
          onClick={openChat}
        >
          {tr('ui.knowledge-local.view-full-text')}
        </button>
      )}
    </div>
  );

  return (
    <>
      <div
        ref={bubbleRef}
        id="waifu-tips-independent"
        data-mascot-ui={active && (scrolls || more) ? '' : undefined}
        data-scroll={scrolls ? '' : undefined}
        data-testid="mascot-bubble"
        data-tail={place?.tail ?? 'bottom'}
        data-empty={text.trim() ? undefined : ''}
        role="status"
        aria-live="polite"
        className={`${styles.messageBubble} ${place ? styles.placed : ''} ${active ? styles.active : ''}`}
        style={style}
        onPointerEnter={() => (bubbleHover.on = true)}
        onPointerLeave={() => (bubbleHover.on = false)}
      >
        {body(false)}
      </div>
      {/* 隐藏的测量层：同样式，用来求给定宽度下的高度 */}
      <div
        ref={measureRef}
        aria-hidden
        className={`${styles.messageBubble} ${styles.measure}`}
        style={{ '--bubble-scale': scale } as React.CSSProperties}
      >
        {body(true)}
      </div>
    </>
  );
};
