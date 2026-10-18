/**
 * 统一会话视图（Codex Desktop 式交互思路）：Nomi 普通对话与 Claude Code / Codex / Grok / dsh 标签共用。
 * 用户消息右对齐气泡；助手消息 = 工具时间线 + Markdown 正文 + 元信息（时间 / 耗时 / token / 费用）；
 * 运行中：实时时间线 / 流式正文 / 权限卡 / 等待态状态行；贴底自动跟随，上滑不抢滚动条；
 * 长对话分页；消息操作：复制 / 重新生成 / 编辑重发 / 停止；排队中的待发消息。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ArrowDown, ChevronsUp, ShieldAlert, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SlashCard } from '../../slash/types';
import type { ConvLive, ConvMessage, ConvPhase } from '../../types/conversation';
import { deriveStatus } from '../../utils/convStatus';
import { timeLabels } from '../../utils/convTime';
import { buildTimeline, reduceTrace } from '../../utils/toolTrace';
import { SystemCardView } from '../SystemCards';

import styles from './index.module.css';
import { Markdown } from './Markdown';
import { AssistantMessage, type ConvSlots, UserMessage } from './Messages';
import { StatusLine } from './StatusLine';
import { ToolTimeline } from './ToolTimeline';

export type { ConvSlots } from './Messages';

/** 距底部不超过该像素视为「贴底」 */
export const NEAR_BOTTOM_PX = 48;

export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  px = NEAR_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= px;
}

/** 权限请求：醒目卡片 */
const PermissionCard: React.FC<{
  summary: string;
  onReply: (allow: boolean) => void;
}> = ({ summary, onReply }) => (
  <div
    className={styles.perm}
    data-testid="conv-permission-card"
    role="alertdialog"
    aria-label={t('需要确认工具权限')}
  >
    <div className={styles.permHead}>
      <Icon icon={ShieldAlert} size={16} />
      <span className={styles.permTitle}>{t('需要确认工具权限')}</span>
    </div>
    <code className={styles.permSummary}>{summary}</code>
    <div className={styles.permActions}>
      <button
        type="button"
        className={styles.permAllow}
        data-testid="conv-permission-allow"
        onClick={() => onReply(true)}
      >
        {t('允许')}
      </button>
      <button
        type="button"
        className={styles.permDeny}
        data-testid="conv-permission-deny"
        onClick={() => onReply(false)}
      >
        {t('拒绝')}
      </button>
    </div>
  </div>
);

/** 首屏最多渲染的消息条数，以及按内容体量折算的预算（超大消息会让窗口变小） */
export const WINDOW_MESSAGES = 30;
export const WINDOW_BUDGET = 400;
export const LOAD_MORE_STEP = 30;
/** 会话视图首帧渲染的末尾消息条数，以及之后每批往上补多少条 */
export const INITIAL_RENDER = 6;
export const RENDER_STEP = 6;

/** 估算一条消息的渲染成本：正文每 400 字符 1，每个轨迹事件 0.5，至少 1 */
function messageWeight(m: Pick<ConvMessage, 'text' | 'trace' | 'error'>): number {
  return Math.max(
    1,
    ((m.text?.length ?? 0) + (m.error?.length ?? 0)) / 400 + (m.trace?.length ?? 0) * 0.5,
  );
}

/**
 * 长对话分页：从末尾往前取，直到条数达到 limit 或体量预算用完（至少 1 条）；返回起始下标。
 * `extra` 为用户点「显示更早的消息」追加的条数。
 */
export function windowStart(
  messages: readonly Pick<ConvMessage, 'text' | 'trace' | 'error'>[],
  extra = 0,
): number {
  const limit = WINDOW_MESSAGES + extra;
  let budget = WINDOW_BUDGET + extra * 10;
  let i = messages.length;
  while (i > 0 && messages.length - i < limit) {
    const w = messageWeight(messages[i - 1]!);
    if (budget - w < 0 && i < messages.length) break;
    budget -= w;
    i--;
  }
  return i;
}

export interface ConversationViewProps {
  /** 会话标识：变化即重建视图（滚动 / 展开状态互不串） */
  scopeId: string;
  messages: ConvMessage[];
  /** 运行中的一轮 */
  live?: ConvLive | null;
  phase: ConvPhase;
  /** 已排队、等当前轮结束后自动发送的消息 */
  queued?: readonly string[];
  onRemoveQueued?: (index: number) => void;
  onPermission?: (requestId: string, allow: boolean) => void;
  /** 重新生成 / 重试（传入出错或最后一条助手消息的 id） */
  onRetry?: (assistantId: string) => void;
  /** 编辑某条用户消息并重新发送 */
  onEdit?: (userId: string, text: string) => void;
  /** 来源特有的扩展内容（Nomi 的记忆 / 图片 / 引用来源等） */
  slots?: ConvSlots;
  /** 斜杠命令的结果卡片：按 afterId 插在对应消息之后（不属于任何一轮模型回复） */
  cards?: readonly SlashCard[];
  onDismissCard?: (id: string) => void;
}

const ConversationInner: React.FC<ConversationViewProps> = ({
  messages,
  live,
  phase,
  queued,
  onRemoveQueued,
  onPermission,
  onRetry,
  onEdit,
  slots,
  cards,
  onDismissCard,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户是否停在底部：贴底才自动跟随；上滑阅读时不抢滚动条 */
  const followRef = useRef(true);
  const [away, setAway] = useState(false);
  const running = phase === 'running';
  const [extra, setExtra] = useState(0);
  const fullStart = useMemo(() => windowStart(messages, extra), [messages, extra]);
  // 切换会话 / 首次挂载：先只渲染末尾几条（首帧尽快出现），其余按帧分批往上补，主线程不会被一次性占满
  const [eagerCount, setEagerCount] = useState(INITIAL_RENDER);
  const start = Math.max(fullStart, messages.length - eagerCount);
  const shown = start > 0 ? messages.slice(start) : messages;
  const labels = useMemo(() => timeLabels(messages), [messages]);
  // 卡片归位：afterId 命中某条消息 → 紧跟其后；null → 会话开头；找不到（消息被删 / 重试）→ 末尾
  const cardPlan = useMemo(() => {
    const byMsg = new Map<string, SlashCard[]>();
    const head: SlashCard[] = [];
    const tail: SlashCard[] = [];
    const ids = new Set(messages.map((m) => m.id));
    for (const c of cards ?? []) {
      if (c.afterId === null) head.push(c);
      else if (ids.has(c.afterId)) byMsg.set(c.afterId, [...(byMsg.get(c.afterId) ?? []), c]);
      else tail.push(c);
    }
    return { byMsg, head, tail };
  }, [cards, messages]);
  const renderCards = (list: readonly SlashCard[] | undefined) =>
    list?.map((c) => <SystemCardView key={c.id} card={c} onDismiss={onDismissCard} />);
  /** 点「显示更早」前的 scrollHeight：加载后据此保持视口不跳 */
  const anchorRef = useRef<number | null>(null);

  const liveTrace = live?.trace;
  const liveItems = useMemo(
    () => (liveTrace?.length ? buildTimeline(reduceTrace(liveTrace), running) : []),
    [liveTrace, running],
  );
  const status = useMemo(
    () => deriveStatus({ phase, live, items: liveItems }),
    [phase, live, liveItems],
  );

  useEffect(() => {
    if (start <= fullStart) return;
    const id = window.setTimeout(() => {
      const el = scrollRef.current;
      // 没有贴底（用户已上滑）时，记下高度，补完后据此保持视口不跳
      if (el && !followRef.current) anchorRef.current = el.scrollHeight;
      setEagerCount((n) => n + RENDER_STEP);
    }, 0);
    return () => window.clearTimeout(id);
  }, [start, fullStart]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && anchorRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [start]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    followRef.current = near;
    setAway((v) => (v === !near ? v : !near));
  }, []);

  // 首次挂载（切换会话时由外层 key 重建）：直接到底部
  useLayoutEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const last = messages[messages.length - 1];
  // 自己刚发了消息：无论滚到哪都跟到底
  const lastUserId = last?.role === 'user' ? last.id : undefined;
  useLayoutEffect(() => {
    if (lastUserId) {
      followRef.current = true;
      scrollToBottom();
    }
  }, [lastUserId, scrollToBottom]);

  // 内容增长（新消息 / 流式文本 / 新工具 / 权限卡 / 状态变化）时，贴底则跟随
  useLayoutEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [
    messages.length,
    start,
    last?.id,
    live?.text,
    live?.trace?.length,
    live?.permission?.id,
    live?.status?.kind,
    queued?.length,
    cards?.length,
    phase,
    scrollToBottom,
  ]);

  const idle = phase === 'idle';
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i]!.role === 'assistant') return messages[i]!.id;
    return undefined;
  }, [messages]);
  const showLive = phase !== 'idle';

  return (
    <div className={styles.root} data-testid="conversation" data-status={phase}>
      <div className={styles.scroll} ref={scrollRef} onScroll={onScroll} data-testid="conv-scroll">
        <div className={styles.inner}>
          {start > 0 && start === fullStart && (
            <button
              type="button"
              className={styles.earlier}
              data-testid="conv-load-earlier"
              onClick={() => {
                anchorRef.current = scrollRef.current?.scrollHeight ?? null;
                setExtra((v) => v + LOAD_MORE_STEP);
              }}
            >
              <Icon icon={ChevronsUp} size={14} />
              {t('显示更早的 {0} 条消息', start)}
            </button>
          )}
          {start === 0 && renderCards(cardPlan.head)}
          {shown.map((m) => (
            <React.Fragment key={m.id}>
              {m.role === 'user' ? (
                <UserMessage
                  message={m}
                  timeLabel={labels.get(m.id)}
                  canEdit={idle}
                  onEdit={onEdit}
                  slots={slots}
                />
              ) : (
                <AssistantMessage
                  message={m}
                  timeLabel={labels.get(m.id)}
                  canRetry={idle && m.id === lastAssistantId}
                  onRetry={onRetry}
                  slots={slots}
                />
              )}
              {renderCards(cardPlan.byMsg.get(m.id))}
            </React.Fragment>
          ))}
          {renderCards(cardPlan.tail)}
          {showLive && (
            <div className={styles.assistant} data-testid="conv-live" aria-live="polite">
              {running && <ToolTimeline items={liveItems} />}
              {running && live?.permission && onPermission && (
                <PermissionCard
                  summary={live.permission.summary}
                  onReply={(allow) => onPermission(live.permission!.id, allow)}
                />
              )}
              {running && live?.text.trim() && <Markdown text={live.text} streaming />}
              {status && (
                <StatusLine status={status} startedAt={running ? live?.startedAt : undefined} />
              )}
            </div>
          )}
          {queued?.map((text, i) => (
            <div className={styles.pending} key={`${i}-${text}`} data-testid="conv-queued">
              <span className={styles.pendingText}>{text}</span>
              <span className={styles.pendingTag}>{t('已排队')}</span>
              {onRemoveQueued && (
                <button
                  type="button"
                  className={styles.action}
                  aria-label={t('移出队列')}
                  title={t('移出队列')}
                  data-testid="conv-queued-remove"
                  onClick={() => onRemoveQueued(i)}
                >
                  <Icon icon={X} size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {away && (
        <button
          type="button"
          className={styles.jump}
          data-testid="conv-jump-bottom"
          aria-label={t('回到底部')}
          title={t('回到底部')}
          onClick={() => {
            followRef.current = true;
            setAway(false);
            scrollToBottom();
          }}
        >
          <Icon icon={ArrowDown} size={16} />
        </button>
      )}
    </div>
  );
};

export const ConversationView: React.FC<ConversationViewProps> = (props) => (
  <ConversationInner key={props.scopeId} {...props} />
);
