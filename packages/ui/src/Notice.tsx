import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { cx } from './cx';
import { Icon } from './icons';

export interface NoticeProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  /** 行首 lucide 图标（不要用 emoji 前缀） */
  icon?: LucideIcon;
}

/** 行内提示条（面板顶部的说明 / 警告 / 错误）。 */
export const Notice: React.FC<NoticeProps> = ({
  tone = 'info',
  icon,
  className,
  children,
  ...rest
}) => (
  <div
    role={tone === 'danger' ? 'alert' : undefined}
    className={cx(
      'cd-notice',
      tone !== 'info' && `cd-notice--${tone}`,
      icon && 'cd-notice--icon',
      className,
    )}
    {...rest}
  >
    {icon && <Icon icon={icon} className="cd-notice__icon" />}
    {icon ? <span className="cd-notice__body">{children}</span> : children}
  </div>
);
