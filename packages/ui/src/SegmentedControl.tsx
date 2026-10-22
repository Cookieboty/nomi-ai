import React from 'react';

import { cx } from './cx';

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  /** 渲染为该选项按钮的 data-testid */
  testId?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** 无可见标签时必填（单选组的可访问名） */
  'aria-label'?: string;
  'data-testid'?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * 分段单选（role=radiogroup / radio，←/→ 切换并选中）。与分段 Tabs 同一外观，
 * 用于设置行右侧的二到四选一（语言、启动方式等）；切换视图用 Tabs。
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  disabled,
  className,
  ...rest
}: SegmentedControlProps<T>) {
  const enabled = options.filter((o) => !o.disabled);
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!fwd && !back) return;
    e.preventDefault();
    const idx = enabled.findIndex((o) => o.value === value);
    const next = enabled[(idx + (fwd ? 1 : enabled.length - 1) + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() =>
      (e.currentTarget as HTMLElement | null)
        ?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)
        ?.focus(),
    );
  };
  // 没有选中项时让第一个可用选项可以 Tab 进来
  const focusable = options.some((o) => o.value === value) ? value : enabled[0]?.value;
  return (
    <div
      role="radiogroup"
      className={cx('cd-tabs', 'cd-seg', className)}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      {...rest}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === focusable ? 0 : -1}
          disabled={disabled || o.disabled}
          className="cd-tab"
          data-value={o.value}
          data-testid={o.testId}
          onClick={() => o.value !== value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
