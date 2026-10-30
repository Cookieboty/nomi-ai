import React, { forwardRef } from 'react';

import { cx } from './cx';

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * 复选框：仍是原生 <input type="checkbox">（键盘、表单、label、测试照旧），
 * 去掉系统外观，方框与勾用令牌绘制、跟随主题。
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} type="checkbox" className={cx('cd-checkbox', className)} {...rest} />;
});
