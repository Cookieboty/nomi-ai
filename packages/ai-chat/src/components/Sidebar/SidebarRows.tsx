import { t, Icon, useLocale } from '@nomi-ai/ui';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import React from 'react';
import { type RowComponentProps } from 'react-window';

import type { HarnessTabMeta } from '../../services/harnessClient';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';
import type { Meta } from './types';

export const rel = (ts: number) => {
  const d = Date.now() - ts;
  if (d < 60_000) return t('ui.chat-settings.just-now');
  if (d < 3_600_000) return t('ui.chat-settings.min-ago', Math.floor(d / 60_000));
  if (d < 86_400_000) return t('ui.chat-settings.h-ago', Math.floor(d / 3_600_000));
  return t('ui.chat-settings.d-ago', Math.floor(d / 86_400_000));
};

export function liveOf(tab: HarnessTabMeta | undefined): string {
  if (!tab) return '';
  if (tab.status === 'running' || tab.status === 'queued' || tab.status === 'error')
    return tab.status;
  if (tab.unread > 0) return 'unread';
  if (tab.background) return 'background';
  return tab.dormant ? 'dormant' : '';
}

/** 行内操作的图标（描边，随文字色） */
const PenIcon = () => <Icon icon={Pencil} size={14} />;
const TrashIcon = () => <Icon icon={Trash2} size={14} />;
const MoreIcon = () => <Icon icon={Ellipsis} size={14} />;

export interface RowActionHandlers {
  onRename?: () => void;
  /** Nomi 对话：删除（两步确认）；CLI 标签：关闭标签 */
  onDelete?: () => void;
  onCancelDelete?: () => void;
  onMore: (anchor: DOMRect) => void;
}

/**
 * 行尾三个图标按钮：重命名 / 删除（或关闭标签）/ 更多。悬浮、行内键盘焦点、选中行时显示；
 * 「更多」只触发父级按需渲染的菜单（与右键菜单共用 ConversationMenu），行内不常驻挂载菜单。
 */
export const RowActions: React.FC<
  RowActionHandlers & { kind: 'conv' | 'tab' | 'hist'; confirming?: boolean }
> = ({ kind, confirming, onRename, onDelete, onCancelDelete, onMore }) => {
  const delLabel =
    kind === 'tab' ? t('ui.mascot-theme.close-tab-action') : t('ui.cli-monitor.delete-chat');
  return (
    <div
      className={styles.rowActions}
      role="group"
      aria-label={t('ui.cli-monitor.conversation-actions')}
      data-testid="row-actions"
      data-confirming={confirming || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && confirming) {
          e.stopPropagation();
          onCancelDelete?.();
        }
      }}
    >
      {confirming ? (
        <>
          <button
            type="button"
            className={`${styles.rowBtn} ${styles.rowBtnDanger} ${styles.rowBtnText}`}
            onClick={onDelete}
            data-testid="row-delete-confirm"
            autoFocus
          >
            {t('ui.knowledge-local.delete-confirm')}
          </button>
          <button
            type="button"
            className={`${styles.rowBtn} ${styles.rowBtnText}`}
            onClick={onCancelDelete}
            data-testid="row-delete-cancel"
          >
            {t('ui.foundation.cancel')}
          </button>
        </>
      ) : (
        <>
          {onRename && (
            <button
              type="button"
              className={styles.rowBtn}
              title={t('ui.cli-monitor.rename')}
              aria-label={t('ui.cli-monitor.rename')}
              onClick={onRename}
              data-testid="row-rename"
            >
              <PenIcon />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
              title={delLabel}
              aria-label={delLabel}
              onClick={onDelete}
              data-testid="row-delete"
            >
              <TrashIcon />
            </button>
          )}
          <button
            type="button"
            className={styles.rowBtn}
            title={t('ui.cli-monitor.more-actions')}
            aria-label={t('ui.cli-monitor.more-actions')}
            aria-haspopup="menu"
            onClick={(e) => onMore(e.currentTarget.getBoundingClientRect())}
            data-testid="row-more"
          >
            <MoreIcon />
          </button>
        </>
      )}
    </div>
  );
};

const ThreadItemImpl: React.FC<{
  c: Meta;
  active: boolean;
  tab?: HarnessTabMeta;
  onOpen: (id: string) => void;
  onCtx: (id: string, e: React.MouseEvent) => void;
  renaming?: boolean;
  onRename?: (id: string, name: string | null) => void;
  confirming?: boolean;
  onRenameStart?: (id: string) => void;
  onDeleteRequest?: (id: string) => void;
  onDeleteCancel?: () => void;
  onMore?: (id: string, anchor: DOMRect) => void;
  style?: React.CSSProperties;
}> = ({
  c,
  active,
  tab,
  onOpen,
  onCtx,
  renaming,
  onRename,
  confirming,
  onRenameStart,
  onDeleteRequest,
  onDeleteCancel,
  onMore,
  style,
}) => {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  const cls = `${styles.thread} ${active ? styles.threadActive : ''}`;
  const live = liveOf(tab);
  const lead = (
    <>
      <span className={styles.dot} data-live={live || undefined} aria-hidden />
      <EndpointIcon backend={c.backend} size={14} />
    </>
  );
  if (renaming) {
    return (
      <div className={cls} style={style} data-testid="history-item" data-backend={c.backend}>
        {lead}
        <input
          className={styles.renameInput}
          data-testid="conversation-rename-input"
          defaultValue={c.name ? t(c.name) : ''}
          aria-label={t('ui.cli-monitor.rename')}
          maxLength={60}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onRename?.(c.id, e.currentTarget.value.trim() || null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onRename?.(c.id, e.currentTarget.value.trim() || null);
            if (e.key === 'Escape') onRename?.(c.id, null);
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={styles.row}
      style={style}
      data-active={active || undefined}
      data-confirming={confirming || undefined}
      data-testid="conversation-row"
    >
      <button
        className={cls}
        onClick={() => void onOpen(c.id)}
        onContextMenu={(e) => onCtx(c.id, e)}
        title={tab?.dormant ? t('ui.cli-monitor.named-dormant', t(c.name)) : t(c.name)}
        data-testid="history-item"
        data-backend={c.backend}
        data-conversation-id={c.id}
      >
        {lead}
        <span className={styles.threadName}>
          {c.name ? t(c.name) : t('ui.chat-settings.new-chat')}
        </span>
        {live === 'running' || live === 'queued' ? (
          // 进行中 / 排队：时间位置换成状态文字，一眼看出哪个任务在跑
          <span className={styles.threadLive} data-live={live} data-testid="thread-live">
            {live === 'running' ? t('ui.chat-settings.in-progress') : t('ui.mascot-theme.queued')}
          </span>
        ) : (
          <span className={styles.threadTime}>{rel(c.updatedAt)}</span>
        )}
      </button>
      {onMore && (
        <RowActions
          kind={c.tabId ? 'tab' : 'conv'}
          confirming={confirming}
          onRename={() => onRenameStart?.(c.id)}
          onDelete={() => onDeleteRequest?.(c.id)}
          onCancelDelete={onDeleteCancel}
          onMore={(r) => onMore(c.id, r)}
        />
      )}
    </div>
  );
};

/** Memoized: a sidebar rerender only rerenders rows whose props changed. */
export const ThreadItem = React.memo(ThreadItemImpl);

export type VirtualProps = {
  items: Meta[];
  current?: string;
  tabById: Map<string, HarnessTabMeta>;
  open: (id: string) => void;
  onCtx: (id: string, e: React.MouseEvent) => void;
  renamingId: string | null;
  onRename: (id: string, name: string | null) => void;
  confirmId: string | null;
  onRenameStart: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  onDeleteCancel: () => void;
  onMore: (id: string, anchor: DOMRect) => void;
};

/** react-window 2 already memoizes rowComponent (shallow props compare); no extra memo here. */
export const VirtualRow = ({
  index,
  style,
  items,
  current,
  tabById,
  open,
  onCtx,
  renamingId,
  onRename,
  confirmId,
  onRenameStart,
  onDeleteRequest,
  onDeleteCancel,
  onMore,
  ariaAttributes,
}: RowComponentProps<VirtualProps>) => {
  const c = items[index]!;
  return (
    <div style={style} {...ariaAttributes}>
      <ThreadItem
        c={c}
        active={c.id === current}
        tab={c.tabId ? tabById.get(c.tabId) : undefined}
        onOpen={open}
        onCtx={onCtx}
        renaming={renamingId === c.id}
        onRename={onRename}
        confirming={confirmId === c.id}
        onRenameStart={onRenameStart}
        onDeleteRequest={onDeleteRequest}
        onDeleteCancel={onDeleteCancel}
        onMore={onMore}
      />
    </div>
  );
};
