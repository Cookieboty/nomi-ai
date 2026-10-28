import { ChevronRight } from 'lucide-react';
import React, { useId, useState } from 'react';

import { cx } from './cx';
import { Icon } from './icons';

export interface DisclosureProps {
  /** 标题行（点击展开 / 收起） */
  summary: React.ReactNode;
  defaultOpen?: boolean;
  /** 受控展开 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  summaryClassName?: string;
  bodyClassName?: string;
  'data-testid'?: string;
  children: React.ReactNode;
}

/**
 * 折叠区块，替代原生 <details>（系统三角箭头不跟主题）：
 * 标题是带 aria-expanded 的按钮，箭头自绘、展开时转 90°；
 * 收起时内容只是 hidden，仍在 DOM 里（与 <details> 一致，查找文字、测试照旧）。
 */
export const Disclosure: React.FC<DisclosureProps> = ({
  summary,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
  summaryClassName,
  bodyClassName,
  'data-testid': testId,
  children,
}) => {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const bodyId = useId();
  const toggle = () => {
    if (openProp === undefined) setOpenState(!open);
    onOpenChange?.(!open);
  };
  return (
    <div
      className={cx('cd-disclosure', className)}
      data-open={open || undefined}
      data-testid={testId}
    >
      <button
        type="button"
        className={cx('cd-disclosure__summary', summaryClassName)}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <Icon icon={ChevronRight} size={12} className="cd-disclosure__chevron" />
        {summary}
      </button>
      <div id={bodyId} className={cx('cd-disclosure__body', bodyClassName)} hidden={!open}>
        {children}
      </div>
    </div>
  );
};
