import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { cx } from './cx';
import { Icon } from './icons';

export type BadgeTone = 'accent' | 'neutral' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  outline?: boolean;
  /** 文字前的 lucide 小图标（12px） */
  icon?: LucideIcon;
}

export const Badge: React.FC<BadgeProps> = ({
  tone = 'accent',
  outline,
  icon,
  className,
  children,
  ...rest
}) => (
  <span
    className={cx(
      'cd-badge',
      tone !== 'accent' && `cd-badge--${tone}`,
      outline && 'cd-badge--outline',
      className,
    )}
    {...rest}
  >
    {icon && <Icon icon={icon} size={12} className="cd-badge__icon" />}
    {children}
  </span>
);

export const Tag = Badge;
