import { t, Icon, useLocale } from '@nomi-ai/ui';
import { Archive, Ellipsis, Pin, PinOff, Trash2 } from 'lucide-react';
import React from 'react';
import { type RowComponentProps } from 'react-window';

import type { HarnessTabMeta } from '../../services/harnessClient';
import type { HistorySession } from '../../services/historyClient';
import { EndpointIcon } from '../EndpointIcon';

import { historyOrigin, routeInitial, routeTag } from './historyRoute';
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
const PinIcon = () => <Icon icon={Pin} size={14} />;
const UnpinIcon = () => <Icon icon={PinOff} size={14} />;
const TrashIcon = () => <Icon icon={Trash2} size={14} />;
const ArchiveIcon = () => <Icon icon={Archive} size={14} />;
const MoreIcon = () => <Icon icon={Ellipsis} size={14} />;

export interface RowActionHandlers {
  /** 置顶 / 取消置顶（改标题在悬停卡片里点标题） */
  onPin?: () => void;
  pinned?: boolean;
  /** Nomi 对话：归档（可在设置里找回）；CLI 标签：关闭标签；本机历史：删除 */
  onDelete?: () => void;
  /** 「更多」按钮本身：菜单锚在它下方，再点它关掉菜单 */
  onMore: (anchor: HTMLElement) => void;
}

/**
 * 行尾三个图标按钮：置顶 / 归档（CLI 标签是关闭，本机历史是删除）/ 更多。悬浮、行内键盘焦点时显示；
 * 永久删除在「更多」里（与右键菜单共用 ConversationMenu），行内不常驻挂载菜单。
 */
export const RowActions: React.FC<RowActionHandlers & { kind: 'conv' | 'tab' | 'hist' }> = ({
  kind,
  onPin,
  pinned,
  onDelete,
  onMore,
}) => {
  const pinLabel = pinned ? t('ui.knowledge-local.unpin') : t('ui.cli-monitor.pin-chat');
  const delLabel =
    kind === 'tab'
      ? t('ui.mascot-theme.close-tab-action')
      : kind === 'conv'
        ? t('ui.cli-monitor.archive-chat')
        : t('ui.cli-monitor.delete-chat');
  return (
    <div
      className={styles.rowActions}
      role="group"
      aria-label={t('ui.cli-monitor.conversation-actions')}
      data-testid="row-actions"
    >
      {onPin && (
        <button
          type="button"
          className={styles.rowBtn}
          title={pinLabel}
          aria-label={pinLabel}
          aria-pressed={pinned}
          onClick={onPin}
          data-testid="row-pin"
        >
          {pinned ? <UnpinIcon /> : <PinIcon />}
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className={`${styles.rowBtn} ${kind === 'conv' ? '' : styles.rowBtnDanger}`}
          title={delLabel}
          aria-label={delLabel}
          onClick={onDelete}
          data-testid={kind === 'conv' ? 'row-archive' : 'row-delete'}
        >
          {kind === 'conv' ? <ArchiveIcon /> : <TrashIcon />}
        </button>
      )}
      <button
        type="button"
        className={styles.rowBtn}
        title={t('ui.cli-monitor.more-actions')}
        aria-label={t('ui.cli-monitor.more-actions')}
        aria-haspopup="menu"
        onClick={(e) => onMore(e.currentTarget)}
        data-testid="row-more"
      >
        <MoreIcon />
      </button>
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
  /** 行内的置顶 / 取消置顶 */
  onPinToggle?: (id: string) => void;
  /** 行内的归档（Nomi 对话）/ 关闭（CLI 标签） */
  onDeleteRequest?: (id: string) => void;
  onMore?: (id: string, anchor: HTMLElement) => void;
  /** 悬停 / 聚焦：el 为 null 时收起详情卡片 */
  onPeek?: (id: string, el: HTMLElement | null) => void;
  /**
   * 行尾的端点小图标（灰色）：只在工坊「全部」里给编程助手的会话标出端点；Nomi 是默认，不标。
   * 行首不画图标，所有标题左对齐（Codex 式）。
   */
  showIcon?: boolean;
  style?: React.CSSProperties;
}> = ({
  c,
  active,
  tab,
  onOpen,
  onCtx,
  renaming,
  onRename,
  onPinToggle,
  onDeleteRequest,
  onMore,
  onPeek,
  showIcon = true,
  style,
}) => {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  const cls = `${styles.thread} ${active ? styles.threadActive : ''}`;
  const live = liveOf(tab);
  const layout = 'plain';
  const endpointMark = showIcon && c.backend !== 'nomi';
  // 状态点不占列：压在行首内边距里，只有运行 / 新结果 / 出错时才看得见
  const lead = <span className={styles.dot} data-live={live || undefined} aria-hidden />;
  if (renaming) {
    return (
      <div
        className={cls}
        style={style}
        data-layout={layout}
        data-testid="history-item"
        data-backend={c.backend}
      >
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
      data-testid="conversation-row"
      onMouseEnter={onPeek ? (e) => onPeek(c.id, e.currentTarget) : undefined}
      onMouseLeave={onPeek ? () => onPeek(c.id, null) : undefined}
    >
      <button
        className={cls}
        onClick={() => {
          onPeek?.(c.id, null);
          void onOpen(c.id);
        }}
        onContextMenu={(e) => {
          onPeek?.(c.id, null);
          onCtx(c.id, e);
        }}
        // 有详情卡片时不再叠一个系统提示
        title={
          onPeek
            ? undefined
            : tab?.dormant
              ? t('ui.cli-monitor.named-dormant', t(c.name))
              : t(c.name)
        }
        data-layout={layout}
        data-testid="history-item"
        data-backend={c.backend}
        data-conversation-id={c.id}
      >
        {lead}
        <span className={styles.threadName}>
          {c.name ? t(c.name) : t('ui.chat-settings.new-chat')}
        </span>
        {/* 不显示时间（悬停卡片里有）；进行中 / 排队只看行首的状态点，不再重复写字，文字只给读屏 */}
        {(live === 'running' || live === 'queued') && (
          <span className={styles.srOnly} data-live={live} data-testid="thread-live">
            {live === 'running' ? t('ui.chat-settings.in-progress') : t('ui.mascot-theme.queued')}
          </span>
        )}
        {endpointMark ? (
          <span className={styles.threadEp} data-testid="thread-endpoint" aria-hidden>
            <EndpointIcon backend={c.backend} size={12} decorative />
          </span>
        ) : (
          <span />
        )}
      </button>
      {onMore && (
        <RowActions
          kind={c.tabId ? 'tab' : 'conv'}
          onPin={onPinToggle ? () => onPinToggle(c.id) : undefined}
          pinned={Boolean(c.pinnedAt)}
          onDelete={() => onDeleteRequest?.(c.id)}
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
  onPinToggle: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  onMore: (id: string, anchor: HTMLElement) => void;
  onPeek?: (id: string, el: HTMLElement | null) => void;
  showIcon?: boolean;
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
  onPinToggle,
  onDeleteRequest,
  onMore,
  onPeek,
  showIcon,
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
        onPinToggle={onPinToggle}
        onDeleteRequest={onDeleteRequest}
        onMore={onMore}
        onPeek={onPeek}
        showIcon={showIcon}
      />
    </div>
  );
};

/**
 * 「本机历史」里的一行（磁盘上的 CLI 会话）：点开在标签里打开；右键 / 「更多」出菜单；
 * 没有重命名，删除 = 把 CLI 的会话记录移到废纸篓。
 */
export const HistoryRow: React.FC<{
  h: HistorySession;
  /** 正在打开这一条 */
  busy: boolean;
  onOpen: () => void;
  /** 在 (x, y) 打开这一行的菜单（右键或「更多」） */
  onMenu: (x: number, y: number, anchor?: HTMLElement) => void;
  onDelete: () => void;
}> = ({ h, busy, onOpen, onMenu, onDelete }) => {
  const tag = routeTag(h);
  return (
    <div className={`${styles.row} ${styles.histRow}`} data-testid="history-session-row">
      <button
        type="button"
        className={styles.thread}
        data-testid="history-session-item"
        data-backend={h.backend}
        data-session-id={h.sessionId}
        data-cwd-missing={h.cwdMissing || undefined}
        aria-busy={busy}
        title={[
          h.title,
          h.cwd,
          ...historyOrigin(h),
          h.cwdMissing ? t('ui.cli-monitor.the-original-directory-no-longer-exists') : '',
        ]
          .filter(Boolean)
          .join('\n')}
        onClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        }}
      >
        <span className={styles.dot} aria-hidden />
        <EndpointIcon backend={h.backend} size={14} />
        {/* 标签放在标题格里：行是 4 列网格，多一个子元素会把时间挤到第二行 */}
        <span className={styles.histTitle}>
          <span className={styles.threadName}>{h.title}</span>
          {tag && (
            <span className={styles.histTag} aria-label={tag} data-testid="history-route-tag">
              {routeInitial(h)}
            </span>
          )}
        </span>
        <span className={styles.threadTime}>{rel(h.updatedAt)}</span>
      </button>
      <RowActions
        kind="hist"
        onDelete={onDelete}
        onMore={(a) => {
          const r = a.getBoundingClientRect();
          onMenu(r.right - 184, r.bottom + 2, a);
        }}
      />
    </div>
  );
};
