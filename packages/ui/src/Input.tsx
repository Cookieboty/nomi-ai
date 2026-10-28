import React, { forwardRef } from 'react';

import { cx } from './cx';
import { DateTimeField, type DateTimeKind } from './DateTimeField';

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
