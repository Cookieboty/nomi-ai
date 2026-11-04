/**
 * 输入框上方的待发列表：运行中发出、还没交出去的消息（见 utils/pendingSends）。
 * 每条标「插入」（Enter，下一步并进这一轮）或「排队」（Ctrl+Enter，这一轮结束后发出），
 * 可以撤回修改（文字退回输入框）或删除。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { CornerDownRight, ListEnd, Pencil, X } from 'lucide-react';
import React, { memo } from 'react';

import type { PendingSend } from '../../utils/pendingSends';

import styles from './index.module.css';

export const PendingDock = memo(function PendingDock({
  items,
  onWithdraw,
  onRemove,
}: {
  items: readonly PendingSend[] | undefined;
  /** 撤回修改：文字退回输入框，并从列表里移除 */
  onWithdraw: (item: PendingSend) => void;
  onRemove: (id: string) => void;
}) {
  useLocale();
  if (!items?.length) return null;
  return (
    <section
      className={styles.dock}
      aria-label={t('ui.session-workspace.pending-messages')}
      data-testid="pending-dock"
    >
      <ul className={styles.list}>
        {items.map((item) => (
          <li
            key={item.id}
            className={styles.item}
            data-mode={item.mode}
            data-testid="pending-item"
          >
            <span className={styles.tag}>
              <Icon icon={item.mode === 'steer' ? CornerDownRight : ListEnd} size={12} />
              {item.mode === 'steer'
                ? t('ui.session-workspace.inserted')
                : t('ui.usage-tools.queued')}
            </span>
            <span className={styles.text} title={item.text}>
              {item.text}
            </span>
            <button
              type="button"
              className={styles.action}
              aria-label={t('ui.session-workspace.withdraw-and-edit')}
              title={t('ui.session-workspace.withdraw-and-edit')}
              data-testid="pending-withdraw"
              onClick={() => onWithdraw(item)}
            >
              <Icon icon={Pencil} size={13} />
            </button>
            <button
              type="button"
              className={styles.action}
              aria-label={t('ui.foundation.delete')}
              title={t('ui.foundation.delete')}
              data-testid="pending-remove"
              onClick={() => onRemove(item.id)}
            >
              <Icon icon={X} size={13} />
            </button>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>{t('ui.session-workspace.pending-hint')}</p>
    </section>
  );
});
