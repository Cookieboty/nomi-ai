import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { cx } from './cx';
import { Icon } from './icons';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** lucide 图标组件（放进圆角淡色底容器居中展示）；不要传 emoji */
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

/** 全站统一的空状态 / 占位：图标容器 + 标题 + 说明 + 可选操作。 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className,
  ...rest
}) => (
  <div className={cx('cd-empty', className)} {...rest}>
    {icon != null && (
      <div className="cd-empty__icon" aria-hidden>
        <Icon icon={icon} size="empty" />
      </div>
    )}
    <p className="cd-empty__title">{title}</p>
    {description != null && <p className="cd-empty__desc">{description}</p>}
    {action != null && <div className="cd-empty__action">{action}</div>}
  </div>
);
