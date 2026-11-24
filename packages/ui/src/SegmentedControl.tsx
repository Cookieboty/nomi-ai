import React, { useEffect, useRef } from 'react';

import { cx } from './cx';
import { t as tr, useLocale } from './i18n';
import { useTabIndicator } from './useTabIndicator';

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
  // 没有选中项时让第一个可用选项可以 Tab 进来
  const focusable = options.some((o) => o.value === value) ? value : enabled[0]?.value;
  const locale = useLocale();
  const { listRef, indicator } = useTabIndicator<HTMLDivElement>(
    `${value ?? ''}\0${locale}\0${options.length}`,
    '[aria-checked="true"]',
  );
  // 方向键后要聚焦的新选项。等它成为「当前可聚焦项」（React 提交完 aria-checked / tabIndex）再聚焦，
  // 迟到的聚焦不能把用户在选中后 Tab 出去的焦点抢回来。定位只用控件自身的 listRef：
  // React 合成事件处理器返回后 currentTarget 会被置空，不能在 rAF 回调里再读事件对象。
  const pendingFocusRef = useRef<T | null>(null);
  const focusOption = (target: T) => {
    if (pendingFocusRef.current !== target) return;
    pendingFocusRef.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(target)}"]`)?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!fwd && !back) return;
    e.preventDefault();
    const idx = enabled.findIndex((o) => o.value === value);
    // 没有选中项时从第一个可用项开始（选中它），否则前后循环并跳过禁用项
    const next =
      idx < 0 ? enabled[0] : enabled[(idx + (fwd ? 1 : enabled.length - 1)) % enabled.length];
    if (!next) return;
    pendingFocusRef.current = next.value;
    onChange(next.value);
    // 受控组件通常在这里就已提交（选中项已同步变化）；没变时由下面的 effect 补上
    if (value === next.value) focusOption(next.value);
  };
  // 非受控 / 异步受控时，等选中项真正切到新值再聚焦
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending !== null && pending === value) focusOption(pending);
  }, [value]);
  return (
    <div
      ref={listRef}
      role="radiogroup"
      data-sliding={indicator.visible ? 'true' : undefined}
      className={cx('cd-tabs', 'cd-seg', className)}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      {...rest}
    >
      {indicator.visible && (
        <span
          aria-hidden="true"
          data-animate={indicator.animate ? 'true' : undefined}
          className="cd-tabs__indicator"
          style={{
            width: `${indicator.width}px`,
            height: `${indicator.height}px`,
            transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
          }}
        />
      )}
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
          {/* 与 Select / Tabs 一致：字符串文案可以是翻译 key */}
          {typeof o.label === 'string' ? tr(o.label) : o.label}
        </button>
      ))}
    </div>
  );
}
