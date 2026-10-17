import React, { createContext, useContext, useId, useRef } from 'react';

import { cx } from './cx';
import { t } from './i18n';
import { useFocusTrap } from './useFocusTrap';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg';
  /** 点击遮罩关闭（默认 true） */
  closeOnOverlay?: boolean;
  /** 关闭按钮的无障碍名称（默认「关闭」；按钮可见文字固定为「关闭」） */
  closeLabel?: string;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
  'data-testid'?: string;
}

/**
 * 宿主模式：让同一个面板既能当弹窗，也能嵌进设置页（inline）或作为右侧抽屉（drawer）。
 * 只作用于最外层 Modal；面板内部的子对话框仍是普通弹窗。
 */
export interface ModalHost {
  mode: 'inline' | 'drawer';
  /** 抽屉头部「在设置中打开」 */
  onOpenSettings?: () => void;
}
export const ModalHostContext = createContext<ModalHost | null>(null);

/** 模态对话框：遮罩点击 / Esc 关闭，role="dialog" + aria-modal，焦点陷阱 + 关闭后焦点归还。 */
export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  footer,
  size = 'md',
  closeOnOverlay = true,
  closeLabel = t('关闭'),
  className,
  bodyClassName,
  children,
  'data-testid': testId,
}) => {
  const titleId = useId();
  const host = useContext(ModalHostContext);
  const inline = host?.mode === 'inline';
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // 焦点进入 / Tab 循环 / Esc 关闭最上层 / 关闭后焦点归还
  useFocusTrap(dialogRef, open && !inline, () => closeRef.current());

  if (!open) return null;
  const body = (
    <ModalHostContext.Provider value={null}>
      <div className={cx('cd-modal__body', bodyClassName)}>{children}</div>
      {footer != null && <div className="cd-modal__footer">{footer}</div>}
    </ModalHostContext.Provider>
  );
  if (inline) {
    return (
      <section
        aria-labelledby={title != null ? titleId : undefined}
        className={cx('cd-modal', 'cd-modal--inline', className)}
        data-testid={testId}
      >
        <div className="cd-modal__header">
          <h2 id={titleId} className="cd-modal__title">
            {title}
          </h2>
        </div>
        {body}
      </section>
    );
  }
  const drawer = host?.mode === 'drawer';
  return (
    <div
      className={cx('cd-modal-overlay', drawer && 'cd-modal-overlay--drawer')}
      data-testid={testId ? `${testId}-overlay` : undefined}
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        className={cx(
          'cd-modal',
          size === 'lg' && 'cd-modal--lg',
          drawer && 'cd-modal--drawer',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
        data-testid={testId}
      >
        <div className="cd-modal__header">
          <h2 id={titleId} className="cd-modal__title">
            {title}
          </h2>
          {drawer && host?.onOpenSettings && (
            <button
              type="button"
              className="cd-btn cd-btn--ghost cd-btn--sm"
              onClick={host.onOpenSettings}
              data-testid="open-in-settings"
            >
              {t('在设置中打开')}
            </button>
          )}
          <button
            type="button"
            className="cd-btn cd-btn--ghost cd-btn--sm cd-modal__close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            {t('关闭')}
          </button>
        </div>
        {body}
      </div>
    </div>
  );
};

export const Dialog = Modal;
