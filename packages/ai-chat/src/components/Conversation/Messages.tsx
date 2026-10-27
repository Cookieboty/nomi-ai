/** 会话里的消息：用户气泡、助手消息（时间线 + 正文 + 元信息）、错误卡片、消息操作 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Check, CircleAlert, Copy, Layers, OctagonX, Pencil, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';

import { joinFileAttachments, splitFileAttachments } from '../../services/fileAttachments';
import type { ConvMessage } from '../../types/conversation';
import { segmentBody } from '../../utils/convSegments';
import { formatFullTime, turnSummary } from '../../utils/convTime';
import { entriesFromLegacyTools, hasRunning, reduceTrace } from '../../utils/toolTrace';
import { FileChipRow } from '../FileAttachment';

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
  /** 错误卡片里额外的操作按钮（如「信任此文件夹」）；retry 只在这一轮可以重试时提供 */
  errorActions?: (m: ConvMessage, ctx: { retry?: () => void }) => React.ReactNode;
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
      label={done ? t('ui.usage-tools.copied') : t('ui.knowledge-local.copy')}
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
  const s = turnSummary(message) ?? {};
  const redacted = message.usage?.redacted ?? 0;
  if (!s.duration && !s.tokens && !s.cost && !redacted) return null;
  const hid = redacted ? t('ui.usage-tools.hid-n-keys', redacted) : '';
  const title = [
    s.duration && t('ui.usage-tools.took', s.duration),
    s.tokens,
    s.cost && t('ui.usage-tools.cost-named', s.cost),
    redacted && t('ui.usage-tools.outbound-protection-hid-n-keys-in-this-turn', redacted),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={styles.summary} data-testid="conv-turn-summary" title={title}>
      {s.duration && <span data-part="duration">{t('ui.usage-tools.took', s.duration)}</span>}
      {s.tokens && <span data-part="tokens">{s.tokens}</span>}
      {s.cost && <span data-part="cost">{s.cost}</span>}
      {hid && (
        <span
          data-part="redacted"
          data-testid="conv-redacted"
          title={t('ui.usage-tools.outbound-protection-hid-n-keys-in-this-turn', redacted)}
        >
          {hid}
        </span>
      )}
    </span>
  );
};

/** 错误卡片：失败原因 + 重试 */
export const ErrorCard: React.FC<{
  message: string;
  onRetry?: () => void;
  /** 排在「重试」前面的额外操作 */
  extra?: React.ReactNode;
}> = ({ message, onRetry, extra }) => (
  <div className={styles.errorCard} role="alert" data-testid="conv-error-card">
    <div className={styles.errorHead}>
      <Icon icon={CircleAlert} size={15} />
      <span className={styles.errorTitle}>{t('ui.usage-tools.this-turn-didn-t-finish')}</span>
    </div>
    <pre className={styles.errorText}>{message}</pre>
    <div className={styles.errorActions}>
      {extra}
      {onRetry && (
        <button
          type="button"
          className={styles.errorBtn}
          onClick={onRetry}
          data-testid="conv-error-retry"
        >
          <Icon icon={RefreshCw} size={13} />
          {t('ui.mascot-theme.retry')}
        </button>
      )}
      <CopyAction text={message} />
    </div>
  </div>
);

/** 助手正文：文字段和工具按发生位置穿插，而不是把工具全部堆在最上面 */
export const AssistantBody: React.FC<{
  text: string;
  trace?: ConvMessage['trace'];
  legacyTools?: string[];
  breaks?: readonly number[];
  live?: boolean;
  streaming?: boolean;
  endedAt?: number;
  extra?: React.ReactNode;
}> = ({ text, trace, legacyTools, breaks, live, streaming, endedAt, extra }) => {
  const entries = useMemo(() => {
    if (trace?.length) return reduceTrace(trace);
    if (legacyTools?.length) return entriesFromLegacyTools(legacyTools);
    return [];
  }, [trace, legacyTools]);
  const segments = useMemo(
    () => segmentBody(text, entries, !!live, endedAt, breaks),
    [text, entries, live, endedAt, breaks],
  );
  if (!segments.length && !extra) return null;
  let lastText = -1;
  let runningAt = -1;
  segments.forEach((s, i) => {
    if (s.type === 'text') lastText = i;
    else if (hasRunning(s.items)) runningAt = i;
  });
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <div key={`t-${i}`} className={styles.segment} data-testid="conv-segment">
            <Markdown
              text={seg.text}
              settled={!streaming || i !== lastText}
              streaming={!!streaming && i === lastText}
            />
          </div>
        ) : (
          <React.Fragment key={`a-${i}`}>
            <ToolTimeline items={seg.items} />
            {extra && i === runningAt ? extra : null}
          </React.Fragment>
        ),
      )}
      {extra && runningAt < 0 ? extra : null}
    </>
  );
};

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
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  // 文件附件块从正文里拆出来画成卡片；编辑只改文字，重发时附件原样带上
  const { text: bodyText, files } = useMemo(
    () => splitFileAttachments(message.text),
    [message.text],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bodyText);
  const full = formatFullTime(message.at);
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onEdit?.(message.id, joinFileAttachments(text, files));
  };
  return (
    <div className={styles.user} data-testid="msg-user" data-message-id={message.id}>
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
            aria-label={t('ui.usage-tools.edit-message')}
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
              {t('ui.foundation.cancel')}
            </button>
            <button
              type="button"
              className={`${styles.errorBtn} ${styles.primaryBtn}`}
              onClick={submit}
              disabled={!draft.trim()}
              data-testid="msg-edit-send"
            >
              {t('ui.usage-tools.resend')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {slots?.before?.(message)}
          {files.length > 0 && <FileChipRow files={files} />}
          {bodyText && (
            <div className={styles.userBubble} title={full}>
              {bodyText}
            </div>
          )}
          <div className={`${styles.actions} ${styles.actionsRight}`} role="toolbar">
            <span className={styles.fullTime}>{full}</span>
            <CopyAction text={bodyText} />
            {canEdit && onEdit && (
              <ActionButton
                icon={Pencil}
                label={t('ui.usage-tools.edit-and-resend')}
                testId="msg-edit"
                onClick={() => {
                  setDraft(bodyText);
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
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  const full = formatFullTime(message.at);
  const body = slots?.body?.(message);
  const retry = canRetry && onRetry ? () => onRetry(message.id) : undefined;
  return (
    <div className={styles.assistant} data-testid="msg-assistant" data-message-id={message.id}>
      {message.origin === 'background' && (
        <div className={styles.stopped} data-testid="background-followup-note">
          <Icon icon={Layers} size={13} />
          {t('ui.chat-settings.follow-up-after-a-background-task-finished')}
        </div>
      )}
      {slots?.before?.(message)}
      <AssistantBody
        text={body ? '' : message.text}
        trace={message.trace}
        legacyTools={message.legacyTools}
        breaks={body ? undefined : message.textBreaks}
        endedAt={message.at}
      />
      {body}
      {message.error && (
        <ErrorCard
          message={message.error}
          onRetry={retry}
          extra={slots?.errorActions?.(message, { retry })}
        />
      )}
      {message.stopped && (
        <div className={styles.stopped} data-testid="stopped-note">
          <Icon icon={OctagonX} size={13} />
          {t('ui.usage-tools.generation-stopped')}
        </div>
      )}
      {slots?.after?.(message)}
      <div className={styles.meta}>
        {message.label && <span className={styles.label}>{message.label}</span>}
        {message.model && (
          <span
            className={styles.model}
            data-testid="conv-msg-model"
            title={t('ui.cli-monitor.model', message.model)}
            aria-label={t('ui.cli-monitor.model', message.model)}
          >
            {message.model}
          </span>
        )}
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
              label={t('ui.usage-tools.regenerate')}
              testId="msg-retry"
              onClick={retry}
            />
          )}
        </div>
      </div>
    </div>
  );
});
