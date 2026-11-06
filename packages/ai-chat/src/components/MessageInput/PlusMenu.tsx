/**
 * 输入框左下角的「+」：给这条消息加东西 / 决定这条消息怎么处理（附件、@ 引用、交给编程助手、知识库问答）。
 * 去别的页面的入口（模型、设置）不放这里。点外面或 Esc 关闭；「交给编程助手」是第二层。
 */
import { Icon, t as tr } from '@nomi-ai/ui';
import { Plus } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { DelegateCli } from '../../services/delegateClient';

import { DelegateMenu } from './DelegateMenu';
import styles from './index.module.css';

export interface PlusMenuItem {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  testId: string;
  active?: boolean;
  run: () => void;
  /** 点了不执行，进入第二层 */
  submenu?: 'delegate';
}

export const PlusMenu: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly PlusMenuItem[];
  /** 「添加图片或文件」用的隐藏 file input（由输入框持有，`/attach` 也会点它） */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
  onDelegate: (cli: DelegateCli) => void;
}> = ({ open, onOpenChange, items, fileInputRef, onFiles, onDelegate }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'root' | 'delegate'>('root');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open, onOpenChange]);

  const pick = (c: PlusMenuItem) => {
    if (c.submenu) {
      setView(c.submenu);
      return;
    }
    onOpenChange(false);
    c.run();
  };

  return (
    <div className={styles.moreWrap} ref={ref}>
      <button
        type="button"
        className={styles.iconButton}
        onClick={() => {
          setView('root');
          onOpenChange(!open);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr('ui.knowledge-local.composer-add-tip')}
        aria-label={tr('ui.knowledge-local.more')}
        data-testid="composer-more"
      >
        <Icon icon={Plus} />
      </button>
      {open && (
        <div className={styles.menu} role="menu" data-testid="composer-menu">
          {view === 'delegate' ? (
            <DelegateMenu
              onBack={() => setView('root')}
              onPick={(cli) => {
                onOpenChange(false);
                onDelegate(cli);
              }}
            />
          ) : (
            items.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
                data-testid={c.testId}
                aria-pressed={c.active}
                aria-haspopup={c.submenu ? 'menu' : undefined}
                title={tr(c.label)}
              >
                <span className={styles.menuIcon}>{c.icon}</span>
                <span className={styles.menuLabel}>{tr(c.label)}</span>
                <span className={styles.menuHint}>{tr(c.hint)}</span>
              </button>
            ))
          )}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="composer-file-input"
        onChange={(e) => {
          const list = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = '';
          onFiles(list);
        }}
      />
    </div>
  );
};
