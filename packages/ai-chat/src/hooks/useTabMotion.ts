import { useLayoutEffect, useRef, useState } from 'react';

/** 系统未开启「减少动态效果」时才启用空间位移与退场动画 */
export function prefersMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches === true;
  } catch {
    return false;
  }
}

export type DirectionalTabMotion = 'right-a' | 'right-b' | 'left-a' | 'left-b';

interface DirectionalState {
  key: string | null;
  index: number;
  parity: 0 | 1;
  motion?: DirectionalTabMotion;
}

/**
 * 计算标签内容切换的方向动画标记（a/b 奇偶交替，使连续同向切换也能重触发 CSS @keyframes，
 * 同时保持面板 DOM 原地保活不重挂载）。
 */
export function useDirectionalTabMotion(
  orderedKeys: readonly string[],
  activeKey: string | null | undefined,
): DirectionalTabMotion | undefined {
  const currentKey = activeKey ?? null;
  const currentIndex = currentKey ? orderedKeys.indexOf(currentKey) : -1;
  const [state, setState] = useState<DirectionalState>(() => ({
    key: currentKey,
    index: currentIndex,
    parity: 0,
    motion: undefined,
  }));

  if (currentKey !== state.key) {
    let motion: DirectionalTabMotion | undefined;
    const nextParity: 0 | 1 = state.parity === 0 ? 1 : 0;
    if (state.key !== null && currentKey !== null && state.index >= 0 && currentIndex >= 0) {
      const dir = currentIndex >= state.index ? 'right' : 'left';
      motion = `${dir}-${nextParity === 0 ? 'a' : 'b'}`;
    }
    setState({
      key: currentKey,
      index: currentIndex,
      parity: nextParity,
      motion,
    });
  }

  return state.motion;
}

/**
 * 标签栏增删与拖拽 / 快捷键重排的轻量 FLIP 过渡：
 * - 组件挂载后新增的标签标记 `data-tab-entering="true"` 播放展开入场；
 * - 关闭中间标签或移动标签顺序时，相邻标签平滑滑向新位置。
 */
export function useTabStripFlip(
  stripRef: React.RefObject<HTMLElement | null>,
  keys: readonly string[],
  dataAttr: string,
): void {
  const prevPositions = useRef<Map<string, number> | null>(null);
  const cleanupTimers = useRef<number[]>([]);
  const keysSignature = keys.join('\0');

  useLayoutEffect(() => {
    const host = stripRef.current;
    if (!host) return;

    const elements = Array.from(host.querySelectorAll<HTMLElement>(`[${dataAttr}]`));
    const scrollLeft = host.scrollLeft || 0;
    const currentPositions = new Map<string, number>();
    for (const el of elements) {
      const k = el.getAttribute(dataAttr);
      if (!k) continue;
      currentPositions.set(k, el.getBoundingClientRect().left + scrollLeft);
    }

    const prev = prevPositions.current;
    prevPositions.current = currentPositions;

    if (!prev || !prefersMotion()) return;

    for (const id of cleanupTimers.current) window.clearTimeout(id);
    cleanupTimers.current = [];

    for (const el of elements) {
      const k = el.getAttribute(dataAttr);
      if (!k) continue;
      const oldX = prev.get(k);
      const newX = currentPositions.get(k);
      if (oldX === undefined) {
        // 新打开的标签：轻盈入场展开
        el.dataset.tabEntering = 'true';
        const timer = window.setTimeout(() => {
          delete el.dataset.tabEntering;
        }, 190);
        cleanupTimers.current.push(timer);
        continue;
      }
      if (newX === undefined) continue;
      const deltaX = oldX - newX;
      if (Math.abs(deltaX) < 1.5 || el.hasAttribute('data-dragging')) continue;

      el.style.transition = 'none';
      el.style.transform = `translate3d(${deltaX}px, 0, 0)`;
      // 触发同步回流以提交起始帧
      void el.offsetWidth;
      el.style.transition = 'transform var(--cd-duration-fast) var(--cd-ease-out)';
      el.style.transform = '';
      const timer = window.setTimeout(() => {
        el.style.transition = '';
        el.style.transform = '';
      }, 220);
      cleanupTimers.current.push(timer);
    }
  }, [stripRef, keysSignature, dataAttr]);

  useLayoutEffect(
    () => () => {
      for (const id of cleanupTimers.current) window.clearTimeout(id);
      cleanupTimers.current = [];
    },
    [],
  );
}

const notifyLayoutSettled = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('nomi:layout-settled'));
  }
};

function animateInline(
  el: HTMLElement | null | undefined,
  fromTransform: string,
  fromOpacity: string,
  origin?: string,
): () => void {
  if (!el) return () => undefined;
  el.style.transition = 'none';
  if (origin) el.style.transformOrigin = origin;
  el.style.transform = fromTransform;
  el.style.opacity = fromOpacity;
  void el.offsetWidth;
  el.style.transition =
    'transform var(--cd-duration-smooth) var(--cd-ease-out), opacity var(--cd-duration-fast) var(--cd-ease-out)';
  el.style.transform = '';
  el.style.opacity = '';
  const clear = () => {
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    if (origin) el.style.transformOrigin = '';
    notifyLayoutSettled();
  };
  const id = window.setTimeout(clear, 260);
  return () => {
    window.clearTimeout(id);
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    if (origin) el.style.transformOrigin = '';
  };
}

/**
 * 只在标签栏容器自身内部横向滚动，使当前选中标签完整落入可视区域。
 * 严禁调用原生 `element.scrollIntoView`，否则会连带把外层 `.ai-chat-app` / `.workspace-card` 滚偏，挤走左侧会话栏。
 */
export function scrollTabIntoStrip(
  stripEl: HTMLElement | null | undefined,
  tabEl: HTMLElement | null | undefined,
  smooth = true,
): void {
  if (!stripEl || !tabEl) return;
  const viewWidth = stripEl.clientWidth;
  if (viewWidth <= 0 || stripEl.scrollWidth <= viewWidth) return;

  const pad = 16;
  const tabLeft = tabEl.offsetLeft;
  const tabRight = tabLeft + tabEl.offsetWidth;
  const curLeft = stripEl.scrollLeft;
  const curRight = curLeft + viewWidth;

  let nextLeft: number | null = null;
  if (tabLeft < curLeft + pad) {
    nextLeft = Math.max(0, tabLeft - pad);
  } else if (tabRight > curRight - pad) {
    nextLeft = Math.min(stripEl.scrollWidth - viewWidth, tabRight - viewWidth + pad);
  }
  if (nextLeft === null || Math.abs(nextLeft - curLeft) < 1) return;

  if (typeof stripEl.scrollTo === 'function') {
    stripEl.scrollTo({
      left: nextLeft,
      behavior: smooth && prefersMotion() ? 'smooth' : 'auto',
    });
  } else {
    stripEl.scrollLeft = nextLeft;
  }
}

/**
 * 工作区「分栏 ↔ 双击全屏铺满 ↔ 向右拆分」以及「整栏滑入 ↔ 滑出」的空间连续过渡。
 * 动画结束后立即清除内联 transform，避免改变内部 fixed 浮层的定位包含块。
 */
export function useWorkspaceLayoutMotion(opts: {
  mainRef: React.RefObject<HTMLElement | null>;
  maximized: boolean;
  split: boolean;
  open: boolean;
  closing?: boolean;
  chatWidth?: number;
}): void {
  const { mainRef, maximized, split, open, closing = false, chatWidth = 520 } = opts;
  const prevRef = useRef<{
    maximized: boolean;
    split: boolean;
    open: boolean;
    closing: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { maximized, split, open, closing };
    if (!prev || !prefersMotion()) return;
    const host = mainRef.current;
    if (!host) return;

    const cleanups: Array<() => void> = [];
    const chatEl = host.querySelector<HTMLElement>(':scope > [data-testid="chat-column"]');
    const workspaceEl = host.querySelector<HTMLElement>(':scope > [data-testid="side-workspace"]');
    const topStripEl = host.querySelector<HTMLElement>(':scope > [data-testid="side-tab-strip"]');

    // 1. 分栏态展开右侧工作区：宽度守恒推拉（右栏固定目标宽并从负右边距滑入，左栏同步从 100% 平滑收窄）
    if (!prev.open && open && !maximized && chatEl && workspaceEl) {
      const totalW = host.clientWidth;
      const sideW = totalW > 0 ? Math.max(360, totalW - chatWidth - 5) : 480;
      const savedChat = {
        flex: chatEl.style.flex,
        width: chatEl.style.width,
        maxWidth: chatEl.style.maxWidth,
      };
      chatEl.style.flex = '1 1 0';
      chatEl.style.width = 'auto';
      chatEl.style.maxWidth = 'none';
      workspaceEl.style.flex = `0 0 ${sideW}px`;
      workspaceEl.style.width = `${sideW}px`;
      workspaceEl.style.transition = 'none';
      workspaceEl.style.marginInlineEnd = `-${sideW}px`;
      void workspaceEl.offsetWidth;
      workspaceEl.style.transition = 'margin-inline-end 0.24s var(--cd-ease-out)';
      workspaceEl.style.marginInlineEnd = '0px';
      const clearSlideIn = (settled = true) => {
        chatEl.style.flex = savedChat.flex;
        chatEl.style.width = savedChat.width;
        chatEl.style.maxWidth = savedChat.maxWidth;
        workspaceEl.style.flex = '';
        workspaceEl.style.width = '';
        workspaceEl.style.transition = '';
        workspaceEl.style.marginInlineEnd = '';
        if (settled) notifyLayoutSettled();
      };
      const id = window.setTimeout(() => clearSlideIn(true), 250);
      cleanups.push(() => {
        window.clearTimeout(id);
        clearSlideIn(false);
      });
    } else if (!prev.closing && closing && !maximized && chatEl && workspaceEl) {
      // 2. 分栏态收起右侧工作区：锁定右栏当前实测宽度并滑向负右边距，左栏同步平滑撑满 100%
      const measuredW = workspaceEl.getBoundingClientRect().width;
      const totalW = host.clientWidth;
      const sideW =
        measuredW > 0 ? measuredW : totalW > 0 ? Math.max(360, totalW - chatWidth - 5) : 480;
      chatEl.style.flex = '1 1 0';
      chatEl.style.width = 'auto';
      chatEl.style.maxWidth = 'none';
      workspaceEl.style.flex = `0 0 ${sideW}px`;
      workspaceEl.style.width = `${sideW}px`;
      workspaceEl.style.transition = 'none';
      workspaceEl.style.marginInlineEnd = '0px';
      void workspaceEl.offsetWidth;
      workspaceEl.style.transition = 'margin-inline-end 0.2s var(--cd-ease)';
      workspaceEl.style.marginInlineEnd = `-${sideW}px`;
      const clearSlideOut = (settled = true) => {
        chatEl.style.flex = '';
        chatEl.style.width = '';
        chatEl.style.maxWidth = '';
        workspaceEl.style.flex = '';
        workspaceEl.style.width = '';
        workspaceEl.style.transition = '';
        workspaceEl.style.marginInlineEnd = '';
        if (settled) notifyLayoutSettled();
      };
      const id = window.setTimeout(() => clearSlideOut(true), 215);
      cleanups.push(() => {
        window.clearTimeout(id);
        clearSlideOut(false);
      });
    } else if (!prev.maximized && maximized && !split) {
      // 3. 分栏 → 全屏铺满：右侧工作区以右边缘为锚点向左舒展铺满，顶栏轻柔落位（保持高不透明度不发白）
      cleanups.push(
        animateInline(workspaceEl, 'translate3d(20px, 0, 0) scale(0.99)', '0.96', 'right center'),
      );
      cleanups.push(animateInline(topStripEl, 'translate3d(0, -5px, 0)', '0.9'));
    } else if (prev.maximized && !maximized) {
      // 4. 全屏铺满 → 回到分栏：主对话列自左迎上，右侧工作区收拢归位
      if (chatEl && !chatEl.hidden) {
        cleanups.push(animateInline(chatEl, 'translate3d(-16px, 0, 0)', '0.92'));
      }
      if (open && workspaceEl && !workspaceEl.hidden) {
        cleanups.push(animateInline(workspaceEl, 'translate3d(-16px, 0, 0)', '0.96'));
      }
    } else if (maximized && !prev.split && split) {
      // 5. 全屏下开启向右拆分：主会话与右侧标签各自微滑并拢
      if (chatEl && !chatEl.hidden) {
        cleanups.push(animateInline(chatEl, 'translate3d(-14px, 0, 0)', '0.92'));
      }
      if (workspaceEl && !workspaceEl.hidden) {
        cleanups.push(animateInline(workspaceEl, 'translate3d(14px, 0, 0)', '0.94'));
      }
    } else if (maximized && prev.split && !split) {
      // 6. 取消向右拆分回到单栏铺满
      const target = chatEl && !chatEl.hidden ? chatEl : workspaceEl;
      cleanups.push(animateInline(target, 'scale(0.992)', '0.95', 'center top'));
    }

    if (!cleanups.length) return;
    return () => {
      for (const fn of cleanups) fn();
    };
  }, [mainRef, maximized, split, open, closing, chatWidth]);
}
