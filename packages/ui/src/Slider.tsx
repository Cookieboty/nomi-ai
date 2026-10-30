import React, { forwardRef } from 'react';

import { cx } from './cx';

export type SliderProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 滑块：仍是原生 <input type="range">（键盘、无障碍、测试照旧），
 * 去掉系统外观，轨道、已选部分与拖柄用令牌绘制、跟随主题。
 */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { className, style, min, max, value, defaultValue, onInput, ...rest },
  ref,
) {
  const lo = num(min, 0);
  const hi = num(max, 100);
  const fill = (v: unknown) => {
    const pct = hi > lo ? ((num(v, (lo + hi) / 2) - lo) / (hi - lo)) * 100 : 0;
    return `${Math.min(100, Math.max(0, pct))}%`;
  };
  return (
    <input
      ref={ref}
      type="range"
      className={cx('cd-slider', className)}
      min={min}
      max={max}
      value={value}
      defaultValue={defaultValue}
      style={{ ...style, ['--slider-fill' as string]: fill(value ?? defaultValue) }}
      onInput={(e) => {
        // 非受控时 React 不会重渲染，直接更新已选部分
        if (value == null)
          e.currentTarget.style.setProperty('--slider-fill', fill(e.currentTarget.value));
        onInput?.(e);
      }}
      {...rest}
    />
  );
});
