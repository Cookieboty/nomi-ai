/**
 * 「模型 · 思考深度」按钮浮层的外壳（编程助手标签与 Nomi 对话共用）：
 * 挂 body、fixed、向上弹，避免输入栏 overflow 裁剪；Esc / 点外面关闭，Esc 后焦点回按钮。
 */
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './index.module.css';

export const ChipMenu: React.FC<{
  btnRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  label: string;
  testId: string;
  width?: number;
  children: React.ReactNode;
}> = ({ btnRef, menuRef, onClose, label, testId, width = 300, children }) => {
  const [pos, setPos] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - r.top + 6,
      width,
    });
  }, [btnRef, width]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        onClose();
        btnRef.current?.focus();
        return;
      }
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menuRef, btnRef, onClose]);
  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={pos}
      role="dialog"
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </div>,
    document.body,
  );
};

/**
 * 模型页（共享 ModelPicker）的高度上限：浮层向上弹，不超出按钮上方的空间；
 * 有「‹ 模型」返回行 / 长上下文一组时各让出一些
 */
export function pickerHeight(btn: HTMLElement | null, backRow: boolean, footer: boolean): number {
  const top = btn?.getBoundingClientRect().top ?? 600;
  const reserved = 6 + 16 + 12 + (backRow ? 36 : 0) + (footer ? 84 : 0);
  return Math.max(200, Math.min(420, top - reserved));
}
