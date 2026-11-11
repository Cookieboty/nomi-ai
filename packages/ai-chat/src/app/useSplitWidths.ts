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
  CHAT_COL_W_DEFAULT,
  CHAT_COL_W_MAX,
  CHAT_COL_W_MIN,
  persistChatColumnWidth,
  readChatColumnWidth,
} from '../utils/chatColumnWidth';
import { startSplitDrag } from '../utils/splitDrag';

export interface SplitWidth {
  width: number;
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
}): SplitWidth {
  const [width, setWidth] = useState(opts.read);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    startSplitDrag({
      el: e.currentTarget,
      pointerId: e.pointerId,
      onMove: (ev) => {
        const dx = opts.fromRight ? startX - ev.clientX : ev.clientX - startX;
        setWidth(Math.min(opts.max, Math.max(opts.min, startW + dx)));
      },
      onEnd: (cancelled) => {
        if (cancelled) {
          setWidth(startW);
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

export function useSplitWidths(): { filesRail: SplitWidth; chatColumn: SplitWidth } {
  const filesRail = useSplit({
    read: readFilesRailWidth,
    persist: persistRail,
    min: FILES_RAIL_W_MIN,
    max: FILES_RAIL_W_MAX,
    def: FILES_RAIL_W_DEFAULT,
    fromRight: true,
  });
  const chatColumn = useSplit({
    read: readChatColumnWidth,
    persist: persistChatColumnWidth,
    min: CHAT_COL_W_MIN,
    max: CHAT_COL_W_MAX,
    def: CHAT_COL_W_DEFAULT,
  });
  return { filesRail, chatColumn };
}
