import React from 'react';

import { cx } from './cx';
import { t } from './i18n';
import { useLocale } from './i18n';
import { useTabIndicator } from './useTabIndicator';

export interface TabItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  /** 渲染为该标签按钮的 data-testid */
  testId?: string;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** segmented：分段底板（默认）；underline：下划线，用作页内二级标签，和外层分段标签区分层级 */
  variant?: 'segmented' | 'underline';
  'aria-label'?: string;
}

/** 分段式 / 下划线 Tabs（role=tablist / tab，←/→ 键切换）。内容区由调用方按 value 渲染。 */
export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  className,
  variant = 'segmented',
  ...rest
}: TabsProps<T>) {
  const locale = useLocale();
  const { listRef, indicator } = useTabIndicator<HTMLDivElement>(
    `${value}\0${locale}\0${items.length}`,
  );
  const enabled = items.filter((i) => !i.disabled);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const idx = enabled.findIndex((i) => i.value === value);
    const next =
      enabled[(idx + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      data-sliding={indicator.visible ? 'true' : undefined}
      className={cx('cd-tabs', variant === 'underline' && 'cd-tabs--underline', className)}
      onKeyDown={onKey}
      {...rest}
    >
      {indicator.visible && (
        <span
          aria-hidden="true"
          data-animate={indicator.animate ? 'true' : undefined}
          className="cd-tabs__indicator"
          style={
            variant === 'underline'
              ? {
                  width: `${indicator.width}px`,
                  transform: `translate3d(${indicator.left}px, 0, 0)`,
                }
              : {
                  width: `${indicator.width}px`,
                  height: `${indicator.height}px`,
                  transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
                }
          }
        />
      )}
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          tabIndex={it.value === value ? 0 : -1}
          disabled={it.disabled}
          className="cd-tab"
          data-testid={it.testId}
          onClick={() => onChange(it.value)}
        >
          {t(it.label)}
        </button>
      ))}
    </div>
  );
}
