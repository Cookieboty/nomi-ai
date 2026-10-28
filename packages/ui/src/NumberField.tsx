import { ChevronDown, ChevronUp } from 'lucide-react';
import React, { forwardRef, useImperativeHandle, useRef } from 'react';

import { cx } from './cx';
import { emitInputValue } from './emitInputValue';
import { Icon } from './icons';

export interface NumberFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type'
> {
  size?: 'sm' | 'md';
  invalid?: boolean;
}

const decimals = (n: number) => {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

/**
 * 数字输入框：仍是原生 <input type="number">（键盘 ↑↓、inputMode、测试照旧），
 * 隐藏系统的上下箭头，换成右侧自绘的步进按钮（悬停 / 聚焦时出现）。
 * className / style 给外层，宽度、对齐写在外层即可，文字对齐会继承到输入框。
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { size = 'md', invalid, className, style, disabled, readOnly, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  const step = (dir: 1 | -1) => {
    const el = inputRef.current;
    if (!el || el.disabled || el.readOnly) return;
    // step="any" 时 stepUp 会抛错：按 1 步进
    const unit = Number(el.step) > 0 ? Number(el.step) : 1;
    const min = el.min !== '' ? Number(el.min) : -Infinity;
    const max = el.max !== '' ? Number(el.max) : Infinity;
    const cur = el.value !== '' && Number.isFinite(Number(el.value)) ? Number(el.value) : null;
    const base = cur ?? (Number.isFinite(min) ? min : 0);
    const raw = cur == null ? base : base + dir * unit;
    const next = Math.min(max, Math.max(min, raw));
    const fixed = next.toFixed(Math.max(decimals(unit), cur == null ? 0 : decimals(cur)));
    const text = String(Number(fixed));
    if (text !== el.value) emitInputValue(el, text);
    el.focus();
  };

  const btn = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      className="cd-number__step"
      disabled={disabled || readOnly}
      // 不抢焦点：失焦时才提交的输入框（如预算）不会被步进按钮提前提交
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => step(dir)}
    >
      <Icon icon={dir === 1 ? ChevronUp : ChevronDown} size={10} />
    </button>
  );

  return (
    <span className={cx('cd-number', size === 'sm' && 'cd-number--sm', className)} style={style}>
      <input
        ref={inputRef}
        type="number"
        aria-invalid={invalid || undefined}
        disabled={disabled}
        readOnly={readOnly}
        className={cx(
          'cd-input cd-number__input',
          size === 'sm' && 'cd-input--sm',
          invalid && 'cd-input--invalid',
        )}
        {...rest}
      />
      {/* 读屏与键盘用输入框自带的 ↑↓ 调整，步进按钮只给鼠标 */}
      <span className="cd-number__steps" aria-hidden>
        {btn(1)}
        {btn(-1)}
      </span>
    </span>
  );
});
