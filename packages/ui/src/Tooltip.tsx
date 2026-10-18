import React, { useId } from 'react';

import { cx } from './cx';

export interface TooltipProps {
  content: React.ReactNode;
  /** top-end：在触发元素上方、与其右缘对齐（触发元素贴近容器右边缘时不被裁切） */
  placement?: 'top' | 'top-end' | 'bottom' | 'left' | 'right';
  className?: string;
  children: React.ReactElement;
}

/** 纯 CSS 悬停 / 聚焦提示；触发元素通过 aria-describedby 关联。 */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  className,
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
        className={cx('cd-tooltip__bubble', `cd-tooltip__bubble--${placement}`)}
      >
        {content}
      </span>
    </span>
  );
};
