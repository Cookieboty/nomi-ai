import React from 'react';

import { cx } from './cx';
import { t as tr } from './i18n';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}

/** 加载占位（微光动画；尊重 prefers-reduced-motion）。 */
export function Skeleton({ width = '100%', height = 14, radius, className }: SkeletonProps) {
  return (
    <span
      className={cx('cd-skeleton', className)}
      style={{ width, height, borderRadius: radius }}
      aria-hidden
    />
  );
}

/** 多行占位列表 */
export function SkeletonList({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div
      className={cx('cd-skeleton-list', className)}
      role="status"
      aria-label={tr('ui.voice-mascot.loading')}
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={32} width={`${100 - ((i * 13) % 30)}%`} />
      ))}
    </div>
  );
}

/** 单行省略号 + 悬停显示完整内容 */
export function Truncate({
  children,
  title,
  className,
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const t = title ?? (typeof children === 'string' ? children : undefined);
  return (
    <span className={cx('cd-truncate', className)} title={t}>
      {children}
    </span>
  );
}
