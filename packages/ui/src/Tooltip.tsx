import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cx } from './cx';
import { tipPosition } from './tipPosition';

export interface TooltipProps {
  content: React.ReactNode;
  /**
   * top-end：在触发元素上方、与其右缘对齐（触发元素贴近容器右边缘时不被裁切）；
   * bottom-start：在触发元素下方、与其左缘对齐（触发元素贴近左边缘时不压到旁边的栏）
   */
  placement?: 'top' | 'top-end' | 'bottom' | 'bottom-start' | 'left' | 'right';
  className?: string;
  /** 追加到气泡元素（cd-tooltip__bubble）上的额外 CSS class，用于调整气泡外观（如宽度、对齐） */
  bubbleClassName?: string;
  children: React.ReactElement;
}

/** 纯 CSS 悬停 / 聚焦提示；触发元素通过 aria-describedby 关联。 */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  className,
  bubbleClassName,
  children,
}) => {
  const id = useId();
  const child = React.cloneElement(
    children as React.ReactElement<{ 'aria-describedby'?: string }>,
    {
      'aria-describedby': id,
    },
  );
  return (
    <span className={cx('cd-tooltip', className)}>
      {child}
      <span
        role="tooltip"
        id={id}
        className={cx('cd-tooltip__bubble', `cd-tooltip__bubble--${placement}`, bubbleClassName)}
      >
        {content}
      </span>
    </span>
  );
};

export interface FloatingTipProps {
  /** 提示跟随的元素；为 null 时不渲染 */
  anchor: HTMLElement | null;
  /**
   * side：放在 boundary（默认 anchor）右侧，放不下换到左侧，再放不下落到 anchor 下方；
   * bottom：放在 anchor 下方，放不下换到上方
   */
  placement?: 'side' | 'bottom';
  /** side 定位参照的外框（如整个下拉菜单），让提示贴着菜单外沿而不压住选项 */
  boundary?: HTMLElement | null;
  id?: string;
  children: React.ReactNode;
}

/**
 * 自绘悬停提示：portal 到 body、fixed 定位，不会被滚动容器裁切，并始终收在窗口内。
 * 用来替代原生 title（系统样式、延迟不可控、不跟主题），显隐时机由调用方控制。
 */
export const FloatingTip: React.FC<FloatingTipProps> = ({
  anchor,
  placement = 'bottom',
  boundary,
  id,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    setPos(
      tipPosition(
        anchor.getBoundingClientRect(),
        { width: el.offsetWidth, height: el.offsetHeight },
        placement,
        (boundary ?? anchor).getBoundingClientRect(),
      ),
    );
  }, [anchor, boundary, placement, children]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="cd-floating-tip"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
};
