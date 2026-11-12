import React, { forwardRef } from 'react';

import { cx } from './cx';

export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

const classes = (variant: ButtonVariant, size: ButtonSize, block?: boolean) =>
  cx(
    'cd-btn',
    variant !== 'secondary' && `cd-btn--${variant}`,
    size !== 'md' && `cd-btn--${size}`,
    block && 'cd-btn--block',
  );

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(classes(variant, size, block), className)}
      {...rest}
    />
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'block' | 'title'> {
  /**
   * 无障碍名称：图标按钮的可访问名只走 aria-label，不写原生 title 悬停提示
   * （见 docs/development/frontend-standards.md「无障碍与提示」）
   */
  label: string;
  icon: React.ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  // 兼容对象展开传来的旧属性，运行时也不把 title 传进 DOM。
  const { title: _title, ...buttonProps } = rest as ButtonProps;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx(classes(variant, size), 'cd-icon-btn', className)}
      {...buttonProps}
    >
      {icon}
    </button>
  );
});
