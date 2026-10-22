import React, { useId } from 'react';

import { cx } from './cx';

export interface SettingsGroupProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  /** 分组说明：标题下方一行弱化文字 */
  description?: React.ReactNode;
  /** 标题右侧的操作（如「预览」「添加」） */
  actions?: React.ReactNode;
}

/** 设置分组卡片：标题 + 说明 + 右上角操作，下面是若干 SettingRow（行间细分隔线）。 */
export function SettingsGroup({
  title,
  description,
  actions,
  className,
  children,
  ...rest
}: SettingsGroupProps) {
  const id = useId();
  const hasHead = title != null || description != null || actions != null;
  return (
    <section
      className={cx('cd-sgroup', className)}
      aria-labelledby={title != null ? id : undefined}
      {...rest}
    >
      {hasHead && (
        <div className="cd-sgroup__head">
          <div className="cd-sgroup__heading">
            {title != null && (
              <h3 id={id} className="cd-sgroup__title">
                {title}
              </h3>
            )}
            {description != null && <p className="cd-sgroup__desc">{description}</p>}
          </div>
          {actions != null && <div className="cd-sgroup__actions">{actions}</div>}
        </div>
      )}
      {children != null && <div className="cd-sgroup__rows">{children}</div>}
    </section>
  );
}

export interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 右侧控件（开关 / 下拉框 / 按钮）；控件自己要有 aria-label 或与 title 同名的可访问名 */
  children?: React.ReactNode;
}

/** 设置行：左边标题 + 说明，右边控件，垂直居中。 */
export function SettingRow({ title, description, className, children, ...rest }: SettingRowProps) {
  return (
    <div className={cx('cd-srow', className)} {...rest}>
      <div className="cd-srow__text">
        <div className="cd-srow__title">{title}</div>
        {description != null && <p className="cd-srow__desc">{description}</p>}
      </div>
      {children != null && <div className="cd-srow__ctrl">{children}</div>}
    </div>
  );
}
