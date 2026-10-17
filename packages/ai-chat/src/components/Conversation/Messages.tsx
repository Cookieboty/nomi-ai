/** 会话里的消息：用户气泡、助手消息（时间线 + 正文 + 元信息）、错误卡片、消息操作 */
import { Icon, t } from '@nomi-ai/ui';
import { Check, CircleAlert, Copy, OctagonX, Pencil, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';

import type { ConvMessage } from '../../types/conversation';
import { formatFullTime, turnSummary } from '../../utils/convTime';
import { buildTimeline, entriesFromLegacyTools, reduceTrace } from '../../utils/toolTrace';

import styles from './index.module.css';
import { Markdown } from './Markdown';
import { ToolTimeline } from './ToolTimeline';

export interface ConvSlots {
  /** 正文之前（记忆标签 / 图片等来源特有内容） */
  before?: (m: ConvMessage) => React.ReactNode;
  /** 替换默认正文渲染（如知识库引用）；返回 null / undefined 则用默认 */
  body?: (m: ConvMessage) => React.ReactNode;
  /** 正文之后（来源列表等） */
  after?: (m: ConvMessage) => React.ReactNode;
}

const ActionButton: React.FC<{
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  testId: string;
}> = ({ icon, label, onClick, testId }) => (
  <button
    type="button"
    className={styles.action}
    onClick={onClick}
    aria-label={label}
    title={label}
    data-testid={testId}
  >
    <Icon icon={icon} size={13} />
  </button>
);

/** 复制：成功后图标短暂变成对勾 */
const CopyAction: React.FC<{ text: string }> = ({ text }) => {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ActionButton
      icon={done ? Check : Copy}
      label={done ? t('已复制') : t('复制')}
      testId="msg-copy"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined);
      }}
    />
  );
};

/** 一轮的耗时 / token / 费用摘要（有数据才显示） */
export const TurnSummary: React.FC<{ message: ConvMessage }> = ({ message }) => {
  const s = turnSummary(message);
  if (!s) return null;
  const title = [s.duration && t('用时 {0}', s.duration), s.tokens, s.cost && t('费用 {0}', s.cost)]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={styles.summary} data-testid="conv-turn-summary" title={title}>
      {s.duration && <span data-part="duration">{t('用时 {0}', s.duration)}</span>}
      {s.tokens && <span data-part="tokens">{s.tokens}</span>}
      {s.cost && <span data-part="cost">{s.cost}</span>}
    </span>
  );
};

/** 错误卡片：失败原因 + 重试 */
export const ErrorCard: React.FC<{
  message: string;
  onRetry?: () => void;
}> = ({ message, onRetry }) => (
  <div className={styles.errorCard} role="alert" data-testid="conv-error-card">
    <div className={styles.errorHead}>
      <Icon icon={CircleAlert} size={15} />
      <span className={styles.errorTitle}>{t('这一轮没有完成')}</span>
    </div>
    <pre className={styles.errorText}>{message}</pre>
    <div className={styles.errorActions}>
      {onRetry && (
        <button
          type="button"
          className={styles.errorBtn}
          onClick={onRetry}
          data-testid="conv-error-retry"
        >
          <Icon icon={RefreshCw} size={13} />
          {t('重试')}
        </button>
      )}
      <CopyAction text={message} />
    </div>
  </div>
);

export const UserMessage = memo(function UserMessage({
  message,
  timeLabel,
  canEdit,
  onEdit,
  slots,
}: {
  message: ConvMessage;
  timeLabel?: string;
  canEdit: boolean;
  onEdit?: (id: string, text: string) => void;
  slots?: ConvSlots;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const full = formatFullTime(message.at);
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onEdit?.(message.id, text);
  };
  return (
    <div className={styles.user} data-testid="msg-user">
      {timeLabel && (
        <time className={styles.time} dateTime={new Date(message.at).toISOString()} title={full}>
          {timeLabel}
        </time>
      )}
      {editing ? (
        <div className={styles.editBox}>
          <textarea
            className={styles.editArea}
            value={draft}
            autoFocus
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            aria-label={t('编辑消息')}
            data-testid="msg-edit-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              else if (
                e.key === 'Enter' &&
                (e.ctrlKey || e.metaKey) &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className={styles.editActions}>
            <button type="button" className={styles.errorBtn} onClick={() => setEditing(false)}>
              {t('取消')}
            </button>
            <button
              type="button"
              className={`${styles.errorBtn} ${styles.primaryBtn}`}
              onClick={submit}
              disabled={!draft.trim()}
              data-testid="msg-edit-send"
            >
              {t('重新发送')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {slots?.before?.(message)}
          {message.text && (
            <div className={styles.userBubble} title={full}>
              {message.text}
            </div>
          )}
          <div className={`${styles.actions} ${styles.actionsRight}`} role="toolbar">
            <span className={styles.fullTime}>{full}</span>
            <CopyAction text={message.text} />
            {canEdit && onEdit && (
              <ActionButton
                icon={Pencil}
                label={t('编辑并重新发送')}
                testId="msg-edit"
                onClick={() => {
                  setDraft(message.text);
                  setEditing(true);
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  message,
  timeLabel,
  canRetry,
  onRetry,
  slots,
}: {
  message: ConvMessage;
  timeLabel?: string;
  canRetry: boolean;
  onRetry?: (id: string) => void;
  slots?: ConvSlots;
}) {
  const items = useMemo(() => {
    const entries = message.trace?.length
      ? reduceTrace(message.trace)
      : message.legacyTools?.length
        ? entriesFromLegacyTools(message.legacyTools)
        : [];
    return buildTimeline(entries, false, message.at);
  }, [message.trace, message.legacyTools, message.at]);
  const full = formatFullTime(message.at);
  const body = slots?.body?.(message);
  const retry = canRetry && onRetry ? () => onRetry(message.id) : undefined;
  return (
    <div className={styles.assistant} data-testid="msg-assistant">
      {slots?.before?.(message)}
      <ToolTimeline items={items} />
      {message.text.trim() && (body ?? <Markdown text={message.text} />)}
      {message.error && <ErrorCard message={message.error} onRetry={retry} />}
      {message.stopped && (
        <div className={styles.stopped} data-testid="stopped-note">
          <Icon icon={OctagonX} size={13} />
          {t('已停止生成')}
        </div>
      )}
      {slots?.after?.(message)}
      <div className={styles.meta}>
        {message.label && <span className={styles.label}>{message.label}</span>}
        {timeLabel && (
          <time dateTime={new Date(message.at).toISOString()} title={full}>
            {timeLabel}
          </time>
        )}
        <TurnSummary message={message} />
        <span className={styles.spacer} />
        <div className={styles.actions} role="toolbar">
          <span className={styles.fullTime}>{full}</span>
          <CopyAction text={message.text || message.error || ''} />
          {retry && !message.error && (
            <ActionButton
              icon={RefreshCw}
              label={t('重新生成')}
              testId="msg-retry"
              onClick={retry}
            />
          )}
        </div>
      </div>
    </div>
  );
});
