import { TriangleAlert } from 'lucide-react';
import React from 'react';

import { Button } from './Button';
import { cx } from './cx';
import { t } from './i18n';
import { Icon } from './icons';
import { SkeletonList } from './Skeleton';

export interface ErrorStateProps {
  /** 标题（默认「出错了」） */
  title?: React.ReactNode;
  /** 错误详情（例如后端返回的消息） */
  detail?: React.ReactNode;
  /** 提供时显示「重试」按钮 */
  onRetry?: () => void;
  retryLabel?: string;
  /** 重试进行中：按钮禁用并显示「重试中…」 */
  retrying?: boolean;
  /** 紧凑模式：用于列表行内（例如某个模型下载失败） */
  compact?: boolean;
  className?: string;
  'data-testid'?: string;
  /** 重试按钮的 data-testid */
  retryTestId?: string;
}

/** 统一的错误状态：图标 + 标题 + 详情 + 重试。role="alert"，读屏会立即播报。 */
export const ErrorState: React.FC<ErrorStateProps> = ({
  title,
  detail,
  onRetry,
  retryLabel,
  retrying,
  compact,
  className,
  'data-testid': testId,
  retryTestId,
}) => (
  <div
    role="alert"
    className={cx('cd-error-state', compact && 'cd-error-state--compact', className)}
    data-testid={testId}
  >
    <span className="cd-error-state__icon" aria-hidden>
      <Icon icon={TriangleAlert} size={18} />
    </span>
    <div className="cd-error-state__text">
      <p className="cd-error-state__title">{title ?? t('出错了')}</p>
      {detail != null && detail !== '' && <p className="cd-error-state__detail">{detail}</p>}
    </div>
    {onRetry && (
      <Button
        size="sm"
        variant={compact ? 'ghost' : 'secondary'}
        onClick={onRetry}
        disabled={retrying}
        data-testid={retryTestId}
      >
        {retrying ? t('重试中…') : (retryLabel ?? t('重试'))}
      </Button>
    )}
  </div>
);

/** 统一的加载状态：骨架行 + 可选说明（role="status"）。 */
export const LoadingState: React.FC<{
  rows?: number;
  label?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}> = ({ rows = 3, label, className, 'data-testid': testId }) => (
  <div className={cx('cd-loading-state', className)} data-testid={testId} aria-busy="true">
    <SkeletonList rows={rows} />
    {label != null && <p className="cd-loading-state__label">{label}</p>}
  </div>
);
