/**
 * 输入框上方的待发列表：运行中发出、还没交出去的消息（见 utils/pendingSends）。
 * 每条标「插入」（Enter，下一步并进这一轮）或「排队」（Ctrl+Enter，这一轮结束后发出），
 * 可以撤回修改（文字退回输入框）或删除。
 * 自动发送失败的那条留在最前面，带可见的原因与「重试」按钮（图片一并保留，见 HarnessTabsContext）。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import {
  IconBolt as Bolt,
  IconCornerDownRight as CornerDownRight,
  IconListTree as ListEnd,
  IconPencil as Pencil,
  IconX as X,
} from '@tabler/icons-react';
import React, { memo } from 'react';

import type { PendingSend } from '../../utils/pendingSends';

import styles from './index.module.css';

export const PendingDock = memo(function PendingDock({
  items,
  onWithdraw,
  onRemove,
  onFlush,
  failure,
  failedText,
  failedId,
  onRetry,
  onSendTextOnly,
}: {
  items: readonly PendingSend[] | undefined;
  /** 撤回修改：文字与附图退回输入框，并从列表里移除 */
  onWithdraw: (item: PendingSend) => void;
  onRemove: (id: string) => void;
  /** 打断当前轮并立刻发送待发列表 */
  onFlush?: () => void;
  /** 自动发送失败（队首那一条还没发出去）的原因；提示里带「重试」（不自动重试） */
  failure?: string;
  /** 失败的那条（提示用它的正文；与列表第一条一致） */
  failedText?: string;
  /** 指定失败项 id（避免与附件缺失条目或其他项混淆） */
  failedId?: string;
  onRetry?: () => void;
  /** 重启后丢失图片的有文条目：仅发送文字 */
  onSendTextOnly?: (id: string) => void;
}) {
  useLocale();
  // 词典没加载 / 查不到时 t() 原样返回 key（里面没有 {0}），原因插不进去：这时把原因补在后面，
  // 失败原因必须出现在这条 alert 里（生产有词典时仍是「待发消息没发出去：{原因}」，不重复）
  const lead = failure ? String(t('ui.session-workspace.pending-send-failed', failure)) : '';
  const heading =
    lead === 'ui.session-workspace.pending-send-failed' ? `${lead}：${failure}` : lead;
  if (!items?.length) return null;
  const missingHead = items[0]?.attachmentsMissing ? items[0] : undefined;
  const missingImageOnly = Boolean(
    missingHead && (missingHead.imageOnly || !missingHead.text.trim()),
  );
  return (
    <section
      className={styles.dock}
      aria-label={t('ui.session-workspace.pending-messages')}
      data-testid="pending-dock"
    >
      {missingHead ? (
        <div className={styles.missing} role="alert" data-testid="pending-attachments-missing">
          <span className={styles.missingText}>
            {missingImageOnly
              ? t('ui.session-workspace.pending-send-image-only-missing')
              : t('ui.session-workspace.pending-send-attachments-missing')}
          </span>
          <div className={styles.missingActions}>
            <button
              type="button"
              className={styles.missingAction}
              data-testid="pending-reattach"
              onClick={() => onWithdraw(missingHead)}
            >
              {t('ui.session-workspace.pending-reattach')}
            </button>
            {!missingImageOnly && onSendTextOnly && (
              <button
                type="button"
                className={styles.missingAction}
                data-testid="pending-send-text-only"
                onClick={() => onSendTextOnly(missingHead.id)}
              >
                {t('ui.session-workspace.pending-send-text-only')}
              </button>
            )}
            <button
              type="button"
              className={styles.missingAction}
              data-testid="pending-missing-remove"
              onClick={() => onRemove(missingHead.id)}
            >
              {t('ui.foundation.delete')}
            </button>
          </div>
        </div>
      ) : (
        failure && (
          <div className={styles.failure} role="alert" data-testid="pending-send-error">
            <span className={styles.failureText}>
              {heading}
              {failedText ? `「${failedText}」` : ''}
            </span>
            {onRetry && (
              <button
                type="button"
                className={styles.failureRetry}
                data-testid="pending-retry"
                onClick={onRetry}
              >
                {t('ui.foundation.retry')}
              </button>
            )}
          </div>
        )
      )}
      <ul className={styles.list}>
        {items.map((item) => {
          const imgs = item.images;
          const first = imgs?.[0];
          const isMissing = Boolean(item.attachmentsMissing);
          const isFailed =
            !isMissing &&
            Boolean(failure && (failedId ? item.id === failedId : item.id === items[0]?.id));
          const displayText =
            item.imageOnly && !item.text.trim()
              ? t('ui.session-workspace.pending-image-only-placeholder')
              : item.text;
          return (
            <li
              key={item.id}
              className={styles.item}
              data-mode={item.mode}
              data-state={isMissing ? 'attachments-missing' : isFailed ? 'failed' : undefined}
              data-testid="pending-item"
            >
              <span className={styles.tag}>
                <Icon icon={item.mode === 'steer' ? CornerDownRight : ListEnd} size={12} />
                {item.mode === 'steer'
                  ? t('ui.session-workspace.inserted')
                  : t('ui.usage-tools.queued')}
              </span>
              {first && (
                <span className={styles.images} data-testid="pending-images">
                  <img
                    src={first.thumb || `data:${first.mime};base64,${first.data}`}
                    alt={t('ui.knowledge-local.attached-image')}
                    className={styles.thumb}
                  />
                  {imgs.length > 1 && <span className={styles.moreCount}>+{imgs.length - 1}</span>}
                </span>
              )}
              <span className={styles.text} title={displayText}>
                {displayText}
              </span>
              <button
                type="button"
                className={styles.action}
                aria-label={t('ui.session-workspace.withdraw-and-edit')}
                data-testid="pending-withdraw"
                onClick={() => onWithdraw(item)}
              >
                <Icon icon={Pencil} size={13} />
              </button>
              <button
                type="button"
                className={styles.action}
                aria-label={t('ui.foundation.delete')}
                data-testid="pending-remove"
                onClick={() => onRemove(item.id)}
              >
                <Icon icon={X} size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.footer}>
        <p className={styles.hint}>{t('ui.session-workspace.pending-hint')}</p>
        {onFlush && (
          <button
            type="button"
            className={styles.flushAction}
            data-testid="pending-flush"
            onClick={onFlush}
          >
            <Icon icon={Bolt} size={12} />
            {t('ui.session-workspace.stop-and-send-now')}
          </button>
        )}
      </div>
    </section>
  );
});
