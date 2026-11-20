/**
 * 两条可拖动的分割线：对话列 | 中栏，对话区 | 右栏（改动 · 文件）。拖动时实时改宽度，松手记住，Esc 取消，双击复位。
 */
import type React from 'react';
import { useState } from 'react';

import {
  FILES_RAIL_W_DEFAULT,
  FILES_RAIL_W_KEY,
  FILES_RAIL_W_MAX,
  FILES_RAIL_W_MIN,
  readFilesRailWidth,
} from '../services/filesRailPrefs';
import {
  CHAT_COL_RATIO_DEFAULT,
  CHAT_COL_RATIO_MAX,
  CHAT_COL_RATIO_MIN,
  clampChatColumnRatio,
  persistChatColumnRatio,
  readChatColumnRatio,
} from '../utils/chatColumnWidth';
import { startSplitDrag } from '../utils/splitDrag';

export interface SplitWidth {
  width: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

export interface SplitRatio {
  ratio: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

const persistRail = (w: number) => {
  try {
    localStorage.setItem(FILES_RAIL_W_KEY, String(w));
  } catch {
    /* ignore */
  }
};

function useSplit(opts: {
  read: () => number;
  persist: (w: number) => void;
  min: number;
  max: number;
  def: number;
  /** 右栏在右边：往左拖变宽 */
  fromRight?: boolean;
  /** 窄屏下当前列被 flex 压缩时，以实际渲染宽度作为拖拽起点 */
  measureActual?: (splitter: HTMLDivElement) => number | undefined;
}): SplitWidth {
  const [width, setWidth] = useState(opts.read);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const savedW = width;
    const actual = opts.measureActual?.(e.currentTarget);
    const startW = actual && actual > 0 && actual < savedW ? Math.round(actual) : savedW;
    startSplitDrag({
      el: e.currentTarget,
      pointerId: e.pointerId,
      onMove: (ev) => {
        const dx = opts.fromRight ? startX - ev.clientX : ev.clientX - startX;
        setWidth(Math.min(opts.max, Math.max(opts.min, startW + dx)));
      },
      onEnd: (cancelled) => {
        if (cancelled) {
          setWidth(savedW);
          return;
        }
        setWidth((w) => {
          opts.persist(w);
          return w;
        });
      },
    });
  };
  const onDoubleClick = () => {
    setWidth(opts.def);
    opts.persist(opts.def);
  };
  return { width, onPointerDown, onDoubleClick };
}

function useChatColumnSplit(): SplitRatio {
  const [ratio, setRatio] = useState(readChatColumnRatio);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = e.currentTarget.parentElement;
    if (!host) return;
    const hostW = host.getBoundingClientRect().width;
    if (hostW <= 0) return;
    e.preventDefault();
    const avail = Math.max(1, hostW - 1);
    const chatEl = host.querySelector<HTMLElement>(':scope > [data-testid="chat-column"]');
    const wsEl = host.querySelector<HTMLElement>(':scope > [data-testid="side-workspace"]');
    const parseMin = (el: HTMLElement | null) => {
      if (!el) return 0;
      const n = parseFloat(getComputedStyle(el).minWidth);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const chatMin = parseMin(chatEl);
    const sideMin = parseMin(wsEl);
    const minR = Math.max(CHAT_COL_RATIO_MIN, Math.min(0.5, chatMin / avail));
    const maxR = Math.min(CHAT_COL_RATIO_MAX, Math.max(0.5, 1 - sideMin / avail));
    const savedRatio = ratio;
    const actualChatW = chatEl?.getBoundingClientRect().width ?? 0;
    const startRatio = actualChatW > 0 ? clampChatColumnRatio(actualChatW / avail) : savedRatio;
    const startX = e.clientX;
    let current = startRatio;
    let moved = false;
    startSplitDrag({
      el: e.currentTarget,
      pointerId: e.pointerId,
      onMove: (ev) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 1) return;
        moved = true;
        const next = Math.min(maxR, Math.max(minR, startRatio + dx / avail));
        current = Math.round(next * 10000) / 10000;
        setRatio(current);
      },
      onEnd: (cancelled) => {
        if (cancelled) {
          setRatio(savedRatio);
          return;
        }
        if (moved) persistChatColumnRatio(current);
      },
    });
  };
  const onDoubleClick = () => {
    setRatio(CHAT_COL_RATIO_DEFAULT);
    persistChatColumnRatio(CHAT_COL_RATIO_DEFAULT);
  };
  return { ratio, onPointerDown, onDoubleClick };
}

export function useSplitWidths(): { filesRail: SplitWidth; chatColumn: SplitRatio } {
  const filesRail = useSplit({
    read: readFilesRailWidth,
    persist: persistRail,
    min: FILES_RAIL_W_MIN,
    max: FILES_RAIL_W_MAX,
    def: FILES_RAIL_W_DEFAULT,
    fromRight: true,
    measureActual: (el) => el.nextElementSibling?.getBoundingClientRect().width,
  });
  const chatColumn = useChatColumnSplit();
  return { filesRail, chatColumn };
}
