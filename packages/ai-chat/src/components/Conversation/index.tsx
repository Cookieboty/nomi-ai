/**
 * 统一会话视图（Codex Desktop 式交互思路）：Nomi 普通对话与 Claude Code / Codex / Grok / dsh 标签共用。
 * 每一次发送是一轮：用户消息在上，助手回复按发生顺序分成文字段和工具，工具插在对应的文字之间。
 * 运行中同样穿插；贴底自动跟随，上滑不抢滚动条；长对话分页。
 * 消息操作：复制 / 重新生成 / 编辑重发 / 停止；排队中的待发消息。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ArrowDown, ChevronsUp, Layers, ShieldAlert, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SlashCard } from '../../slash/types';
import type { ConvLive, ConvMessage, ConvPhase } from '../../types/conversation';
import { deriveStatus } from '../../utils/convStatus';
import { timeLabels } from '../../utils/convTime';
import { buildTimeline, reduceTrace } from '../../utils/toolTrace';
import { SystemCardView } from '../SystemCards';

import { AgentsByCallContext, agentsByCall } from './agentContext';
import styles from './index.module.css';
import { AssistantBody, AssistantMessage, type ConvSlots, UserMessage } from './Messages';
import { StatusLine } from './StatusLine';

export type { ConvSlots } from './Messages';

/** 距底部不超过该像素视为「贴底」 */
export const NEAR_BOTTOM_PX = 48;

export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  px = NEAR_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= px;
}

/** 剩余秒数（每秒刷新）；没有截止时间返回 null */
function useSecondsLeft(expiresAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return expiresAt === undefined ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** 权限请求：醒目卡片（注明来源子代理与自动拒绝倒计时） */
const PermissionCard: React.FC<{
  summary: string;
  agent?: string;
  expiresAt?: number;
  onReply: (allow: boolean) => void;
}> = ({ summary, agent, expiresAt, onReply }) => {
  const left = useSecondsLeft(expiresAt);
  return (
    <div
      className={styles.perm}
      data-testid="conv-permission-card"
      role="alertdialog"
      aria-label={agent ? t('子代理「{0}」需要确认工具权限', agent) : t('需要确认工具权限')}
    >
      <div className={styles.permHead}>
        <Icon icon={ShieldAlert} size={16} />
        <span className={styles.permTitle}>{t('需要确认工具权限')}</span>
        {agent && (
          <span className={styles.permSource} data-testid="conv-permission-agent">
            {t('子代理 · {0}', agent)}
          </span>
        )}
        {left !== null && (
          <span className={styles.permTimer} data-testid="conv-permission-timer">
            {t('{0} 秒后自动拒绝', String(left))}
          </span>
        )}
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
};

/** at 之后 ms 毫秒内为 true（到期由定时器翻转，不在渲染时读时钟） */
function useRecent(at: number | undefined, ms: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, at + ms - Date.now()) + 20);
    return () => window.clearTimeout(id);
  }, [at, ms]);
  return at !== undefined && now - at < ms;
}

/** 已运行时长（每秒刷新），如「1 分 12 秒」 */
function useElapsed(since: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return s >= 60
    ? t('{0} 分 {1} 秒', String(Math.floor(s / 60)), String(s % 60))
    : t('{0} 秒', String(s));
}

const BackgroundAgentRow: React.FC<{
  agent: { id: string; label?: string; startedAt: number; stoppable: boolean };
  onStop?: (id: string) => void;
}> = ({ agent, onStop }) => {
  const elapsed = useElapsed(agent.startedAt);
  const [stopping, setStopping] = useState(false);
  return (
    <li className={styles.bgRow} data-testid="conv-background-agent">
      <span className={styles.bgLabel} title={agent.label}>
        {agent.label || t('子代理')}
      </span>
      <span className={styles.bgElapsed}>{elapsed}</span>
      {onStop && (
        <button
          type="button"
          className={styles.bgStop}
          data-testid="conv-background-stop"
          disabled={!agent.stoppable || stopping}
          title={agent.stoppable ? t('停止这个子代理') : t('该编程助手不支持单独停止子代理')}
          aria-label={t('停止子代理「{0}」', agent.label || t('子代理'))}
          onClick={() => {
            setStopping(true);
            onStop(agent.id);
          }}
        >
          {stopping ? t('正在停止…') : t('停止')}
        </button>
      )}
    </li>
  );
};

/**
 * 后台任务条：一轮结束后仍在运行的后台子代理（以及后台 Bash 等任务的总数）。
 * 跨轮次显示，可单独停止（CLI 支持时）；全部结束后自动消失。
 */
const BackgroundBar: React.FC<{
  agents?: ReadonlyArray<{ id: string; label?: string; startedAt: number; stoppable: boolean }>;
  count?: number;
  onStop?: (id: string) => void;
}> = ({ agents, count, onStop }) => {
  const [open, setOpen] = useState(false);
  const n = Math.max(count ?? 0, agents?.length ?? 0);
  if (!n) return null;
  return (
    <div className={styles.bgBar} data-testid="conv-background-bar" aria-live="polite">
      <button
        type="button"
        className={styles.bgToggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <Icon icon={Layers} size={13} />
        {t('后台任务 {0} 个', String(n))}
      </button>
      {open && agents?.length ? (
        <ul className={styles.bgList}>
          {agents.map((a) => (
            <BackgroundAgentRow key={a.id} agent={a} onStop={onStop} />
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** 待确认的权限请求队列：按到达顺序全部列出（并行子代理会同时请求），超时自动拒绝时短暂提示 */
const PermissionQueue: React.FC<{
  live: ConvLive | null | undefined;
  onPermission?: (requestId: string, allow: boolean) => void;
}> = ({ live, onPermission }) => {
  const list = live?.permissions ?? [];
  const expired = live?.permissionExpired;
  const showExpired = useRecent(expired?.at, 15_000) && !!expired;
  if (!onPermission || (!list.length && !showExpired)) return null;
  return (
    <div className={styles.permQueue} data-testid="conv-permission-queue">
      {list.length > 1 && (
        <div className={styles.permCount} aria-live="polite">
          {t('{0} 项待确认', String(list.length))}
        </div>
      )}
      {list.map((p) => (
        <PermissionCard
          key={p.id}
          summary={p.summary}
          agent={p.agent}
          expiresAt={p.expiresAt}
          onReply={(allow) => onPermission(p.id, allow)}
        />
      ))}
      {showExpired && expired && (
        <div className={styles.permExpired} role="status" data-testid="conv-permission-expired">
          {expired.agent
            ? t('子代理「{0}」的请求已超时，已自动拒绝：{1}', expired.agent, expired.summary)
            : t('请求已超时，已自动拒绝：{0}', expired.summary)}
        </div>
      )}
    </div>
  );
};

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
/** 一次发送一轮：用户消息领起，随后的助手消息直到下一条用户消息都算这一轮 */
export function groupTurns(
  messages: readonly ConvMessage[],
): { key: string; messages: ConvMessage[] }[] {
  const turns: { key: string; messages: ConvMessage[] }[] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    if (m.role === 'user' || !last) turns.push({ key: m.id, messages: [m] });
    else last.messages.push(m);
  }
  return turns;
}

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
  /** 编程助手进程因空闲被回收：显示提示，发送下一条消息会自动续接 */
  dormant?: boolean;
  /** 仍在运行的后台子代理（跨轮次）与后台任务总数（docs/design/cli-subagents.md §5） */
  backgroundAgents?: ReadonlyArray<{
    id: string;
    label?: string;
    startedAt: number;
    stoppable: boolean;
  }>;
  backgroundCount?: number;
  onStopAgent?: (agentId: string) => void;
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
  dormant,
  backgroundAgents,
  backgroundCount,
  onStopAgent,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentMap = useMemo(() => agentsByCall(live?.agents), [live?.agents]);
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
  const turns = useMemo(() => groupTurns(shown), [shown]);
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
    live?.permissions?.length,
    live?.permissionExpired?.at,
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
    <AgentsByCallContext.Provider value={agentMap}>
      <div className={styles.root} data-testid="conversation" data-status={phase}>
        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="conv-scroll"
        >
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
            {turns.map((turn, i) => (
              <section key={turn.key} className={styles.turn} data-testid="conv-turn">
                {turn.messages.map((m) => (
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
                {i === turns.length - 1 && showLive && (
                  <div className={styles.assistant} data-testid="conv-live" aria-live="polite">
                    {running && (
                      <AssistantBody
                        text={live?.text ?? ''}
                        trace={live?.trace}
                        breaks={live?.textBreaks}
                        live
                        streaming
                        extra={<PermissionQueue live={live} onPermission={onPermission} />}
                      />
                    )}
                    {status && (
                      <StatusLine
                        status={status}
                        startedAt={running ? live?.startedAt : undefined}
                      />
                    )}
                  </div>
                )}
              </section>
            ))}
            {turns.length === 0 && showLive && (
              <div className={styles.assistant} data-testid="conv-live" aria-live="polite">
                {running && (
                  <AssistantBody
                    text={live?.text ?? ''}
                    trace={live?.trace}
                    breaks={live?.textBreaks}
                    live
                    streaming
                    extra={<PermissionQueue live={live} onPermission={onPermission} />}
                  />
                )}
                {status && (
                  <StatusLine status={status} startedAt={running ? live?.startedAt : undefined} />
                )}
              </div>
            )}
            {renderCards(cardPlan.tail)}
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
            <BackgroundBar agents={backgroundAgents} count={backgroundCount} onStop={onStopAgent} />
            {dormant && !running && (
              <div className={styles.dormant} data-testid="conv-dormant" role="status">
                {t('编程助手进程空闲已休眠，发送下一条消息会自动续接会话')}
              </div>
            )}
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
    </AgentsByCallContext.Provider>
  );
};

export const ConversationView: React.FC<ConversationViewProps> = (props) => (
  <ConversationInner key={props.scopeId} {...props} />
);
