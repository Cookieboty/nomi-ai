import React, { forwardRef } from 'react';

import { Checkbox } from './Checkbox';
import { cx } from './cx';
import { DateTimeField, type DateTimeKind } from './DateTimeField';
import { NumberField } from './NumberField';
import { Slider } from './Slider';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md';
  invalid?: boolean;
}

const DATE_TIME_KINDS: readonly string[] = ['date', 'time', 'datetime-local'];
const isDateTimeKind = (type: string | undefined): type is DateTimeKind =>
  type != null && DATE_TIME_KINDS.includes(type);

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid, className, ...rest },
  ref,
) {
  // 日期 / 时间不用系统日历，换成自绘选择器（取值格式与原生一致）
  const { type } = rest;
  if (isDateTimeKind(type)) {
    return (
      <DateTimeField
        ref={ref}
        {...rest}
        type={type}
        size={size}
        invalid={invalid}
        className={className}
      />
    );
  }
  // 数字、滑块、复选框同样换成自绘外观
  if (type === 'number') {
    return <NumberField ref={ref} {...rest} size={size} invalid={invalid} className={className} />;
  }
  if (type === 'range') return <Slider ref={ref} {...rest} className={className} />;
  if (type === 'checkbox') return <Checkbox ref={ref} {...rest} className={className} />;
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        'cd-input',
        size === 'sm' && 'cd-input--sm',
        invalid && 'cd-input--invalid',
        className,
      )}
      {...rest}
    />
  );
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx('cd-textarea', className)} {...rest} />;
});

export { Select } from './Select';
export type { SelectProps, SelectOption } from './Select';
