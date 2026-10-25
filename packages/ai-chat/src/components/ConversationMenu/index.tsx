/**
 * 唯一的对话右键菜单：侧栏条目与顶部标签共用。
 * 重命名 / 分叉为新对话 / 分叉到其他端 /（CLI 标签）关闭标签 / 关闭左右标签 /（Nomi 对话）删除对话。
 * 关闭 = 仅关掉标签，CLI 会话仍在磁盘，可从历史重新打开；删除 = 永久移除 Nomi 对话。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useRef } from 'react';

import { formatCombo, useShortcutBindings } from '../../services/shortcuts';

import styles from './index.module.css';

export interface ConversationMenuProps {
  x: number;
  y: number;
  /** 该对话是否对应一个 CLI 标签 */
  isTab: boolean;
  /** 磁盘历史会话（只读）没有重命名 / 分叉 / 删除，只给 onOpen */
  onOpen?: () => void;
  onRename?: () => void;
  onFork?: () => void;
  onForkCross?: () => void;
  onClose?: () => void;
  onCloseLeft?: () => void;
  onCloseRight?: () => void;
  onDelete?: () => void;
  onDismiss: () => void;
}

export const ConversationMenu: React.FC<ConversationMenuProps> = ({
  x,
  y,
  isTab,
  onOpen,
  onRename,
  onFork,
  onForkCross,
  onClose,
  onCloseLeft,
  onCloseRight,
  onDelete,
  onDismiss,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const bindings = useShortcutBindings();

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('blur', onDismiss);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onDismiss]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onDismiss();
      e.stopPropagation();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    e.preventDefault();
  };

  const act = (fn?: () => void) => () => {
    onDismiss();
    fn?.();
  };

  // 贴边时往里收一点，避免菜单被窗口裁掉
  const left = Math.max(4, Math.min(x, window.innerWidth - 210));
  const menuHeight = onCloseLeft || onCloseRight ? 330 : 220;
  const top = Math.max(4, Math.min(y, window.innerHeight - menuHeight));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('ui.cli-monitor.conversation-actions')}
      className={styles.menu}
      style={{ left, top }}
      data-testid="conversation-context-menu"
      onKeyDown={onKey}
    >
      {onOpen && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onOpen)}
          data-testid="conversation-open"
        >
          {t('ui.cli-monitor.open-in-a-tab')}
        </button>
      )}
      {onRename && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onRename)}
          data-testid="conversation-rename"
        >
          {t('ui.cli-monitor.rename')}
          {isTab && <span className={styles.key}>{formatCombo(bindings.renameTab)}</span>}
        </button>
      )}
      {onFork && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onFork)}
          data-testid="fork-same"
        >
          {t('ui.cli-monitor.fork-as-new-chat')}
        </button>
      )}
      {onForkCross && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onForkCross)}
          data-testid="fork-cross"
        >
          {t('ui.cli-monitor.fork-to-another-endpoint')}
        </button>
      )}
      {(onClose || onDelete) && <div className={styles.sep} role="separator" />}
      {onClose && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onClose)}
          data-testid="conversation-close"
        >
          {t('ui.mascot-theme.close-tab-118f00')}
          <span className={styles.key}>{formatCombo(bindings.closeTab)}</span>
        </button>
      )}
      {onCloseLeft && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onCloseLeft)}
          data-testid="conversation-close-left"
        >
          {t('ui.mascot-theme.close-tabs-to-the-left')}
        </button>
      )}
      {onCloseRight && (
        <button
          type="button"
          role="menuitem"
          className={styles.item}
          onClick={act(onCloseRight)}
          data-testid="conversation-close-right"
        >
          {t('ui.mascot-theme.close-tabs-to-the-right')}
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          role="menuitem"
          className={`${styles.item} ${styles.danger}`}
          onClick={act(onDelete)}
          data-testid="conversation-delete"
        >
          {t('ui.cli-monitor.delete-chat')}
        </button>
      )}
    </div>
  );
};
