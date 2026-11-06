/**
 * 侧栏里的弹出菜单（新建、整理侧栏）：挂到 body 上，贴在按钮右侧展开。
 * 按钮在会话列表这个滚动容器里，菜单放在里面会被裁掉、还会把列表横向撑出滚动条，所以不放在原地。
 * 右边放不下时改到按钮左侧，上下不超出窗口。
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;
const EDGE = 8;

export const AnchoredPopover: React.FC<{
  /** 按钮（取它的位置） */
  anchor: HTMLElement | null;
  /** 让调用方判断「点在菜单里」 */
  popRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}> = ({ anchor, popRef, children }) => {
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const local = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = local.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = a.right + GAP;
    if (left + w > window.innerWidth - EDGE) left = Math.max(EDGE, a.left - GAP - w);
    const top = Math.max(EDGE, Math.min(a.top, window.innerHeight - EDGE - h));
    setPos({ left, top });
  }, [anchor]);
  return createPortal(
    <div
      ref={(el) => {
        local.current = el;
        popRef.current = el;
      }}
      style={{ position: 'fixed', zIndex: 2400, ...pos }}
      data-testid="sidebar-popover"
    >
      {children}
    </div>,
    document.body,
  );
};
