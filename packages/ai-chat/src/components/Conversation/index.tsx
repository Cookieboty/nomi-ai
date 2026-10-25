/**
 * 统一会话视图（Codex Desktop 式交互思路）：Nomi 普通对话与 Claude Code / Codex / Grok / dsh 标签共用。
 * 每一次发送是一轮：用户消息在上，助手回复按发生顺序分成文字段和工具，工具插在对应的文字之间。
 * 运行中同样穿插；贴底自动跟随，上滑不抢滚动条；长对话分页。
 * 消息操作：复制 / 重新生成 / 编辑重发 / 停止；排队中的待发消息。
 */
import { Icon, t } from '@nomi-ai/ui';
import { ArrowDown, ArrowLeftRight, ChevronsUp, Layers, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SlashCard } from '../../slash/types';
import type { ConvLive, ConvMessage, ConvPhase } from '../../types/conversation';
import { deriveStatus } from '../../utils/convStatus';
import { timeLabels } from '../../utils/convTime';
import { buildTimeline, reduceTrace } from '../../utils/toolTrace';
import { SystemCardView } from '../SystemCards';

import { AgentsByCallContext, agentsByCall } from './agentContext';
import { ApprovePlanCard } from './ApprovePlanCard';
import styles from './index.module.css';
import { AssistantBody, AssistantMessage, type ConvSlots, UserMessage } from './Messages';
import { PermissionCard } from './PermissionCard';
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

/**
 * Keep a scroll container pinned to the bottom while its content grows, as long as `followRef`
 * is set (the user has not scrolled away). Driven by a ResizeObserver on the content (and the
 * container, for viewport changes) instead of a per-frame layout effect.
 */
export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
  followRef: React.RefObject<boolean>,
  scrollToBottom: () => void,
): void {
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom();
    });
    ro.observe(content);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scrollRef, contentRef, followRef, scrollToBottom]);
}

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
    ? t('ui.chat-settings.m-s', String(Math.floor(s / 60)), String(s % 60))
    : t('ui.mascot-theme.s', String(s));
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
        {agent.label || t('ui.usage-tools.subagent')}
      </span>
      <span className={styles.bgElapsed}>{elapsed}</span>
      {onStop && (
        <button
          type="button"
          className={styles.bgStop}
          data-testid="conv-background-stop"
          disabled={!agent.stoppable || stopping}
          title={
            agent.stoppable
              ? t('ui.chat-settings.stop-this-subagent')
              : t('ui.chat-settings.this-coding-agent-can-t-stop-a-single')
          }
          aria-label={t(
            'ui.chat-settings.stop-subagent',
            agent.label || t('ui.usage-tools.subagent'),
          )}
          onClick={() => {
            setStopping(true);
            onStop(agent.id);
          }}
        >
          {stopping ? t('ui.chat-settings.stopping') : t('ui.foundation.stop')}
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
        {t('ui.chat-settings.background-tasks', String(n))}
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
  onPermission?: (
    requestId: string,
    allow: boolean,
    opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
  ) => void;
}> = ({ live, onPermission }) => {
  const list = live?.permissions ?? [];
  const expired = live?.permissionExpired;
  const showExpired = useRecent(expired?.at, 15_000) && !!expired;
  if (!onPermission || (!list.length && !showExpired)) return null;
  return (
    <div className={styles.permQueue} data-testid="conv-permission-queue">
      {list.length > 1 && (
        <div className={styles.permCount} aria-live="polite">
          {t('ui.chat-settings.requests-waiting', String(list.length))}
        </div>
      )}
      {list.map((p) =>
        p.kind === 'approve-plan' ? (
          <ApprovePlanCard
            key={p.id}
            summary={p.summary}
            agent={p.agent}
            expiresAt={p.expiresAt}
            executePlan={p.toolName === 'execute_plan'}
            onChoice={(choice) => onPermission(p.id, choice !== 'deny', { approvePlan: choice })}
          />
        ) : (
          <PermissionCard
            key={p.id}
            summary={p.summary}
            agent={p.agent}
            expiresAt={p.expiresAt}
            onReply={(allow) => onPermission(p.id, allow)}
          />
        ),
      )}
      {showExpired && expired && (
        <div className={styles.permExpired} role="status" data-testid="conv-permission-expired">
          {expired.agent
            ? t(
                'ui.chat-settings.subagent-s-request-timed-out-and-was-denied',
                expired.agent,
                expired.summary,
              )
            : t('ui.chat-settings.the-request-timed-out-and-was-denied', expired.summary)}
        </div>
      )}
    </div>
  );
};

export const WINDOW_MESSAGES = 30;
export const WINDOW_BUDGET = 400;
export const LOAD_MORE_STEP = 30;
/** 会话视图首帧渲染的末尾消息条数，以及之后每批往上补多少条 */
export const INITIAL_RENDER = 3;
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
  onPermission?: (
    requestId: string,
    allow: boolean,
    opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
  ) => void;
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
  /**
   * 会话中途换了模型、还没发送下一条消息：切换后的模型名（空串 = 默认模型），显示一条弱提示。
   * 由来源决定（编程助手标签看切换记录，Nomi 对话比较最后一条助手消息的模型）
   */
  modelSwitchTip?: string | null;
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
  modelSwitchTip,
  backgroundAgents,
  backgroundCount,
  onStopAgent,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentMap = useMemo(() => agentsByCall(live?.agents), [live?.agents]);
  /** 用户是否停在底部：贴底才自动跟随；上滑阅读时不抢滚动条 */
  const followRef = useRef(true);
  const innerRef = useRef<HTMLDivElement>(null);
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

  // 分批往上补消息时不读 scrollHeight / 不改 scrollTop：每批都强制整列重排，切会话时是主要开销之一。
  // 内容已经超出一屏时，浏览器的滚动锚定（overflow-anchor）会让视口里的内容保持不动；
  // 还没超出一屏（scrollTop 为 0，锚定不生效）时才由下面的 effect 补一次贴底。
  useEffect(() => {
    if (start <= fullStart) return;
    const id = window.setTimeout(() => setEagerCount((n) => n + RENDER_STEP), 0);
    return () => window.clearTimeout(id);
  }, [start, fullStart]);

  /** 上次贴底时内容是否已超出一屏（超出后由滚动锚定保持位置） */
  const overflowedRef = useRef(false);
  /** 上一次看到的 scrollTop：判断这次滚动是不是用户往上滚 */
  const lastTopRef = useRef(0);
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = el.scrollHeight;
    el.scrollTop = h;
    lastTopRef.current = el.scrollTop;
    overflowedRef.current = h > el.clientHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && anchorRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [start]);

  // 滚轮 / 触控板往上：立即停止跟随（不等 scroll 事件，避免同一帧里的增长又把视口拉回底部）
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) followRef.current = false;
  }, []);

  // 只有用户往上滚（scrollTop 变小且离开底部）才停止跟随。不能只看「离底部多远」：程序贴底后
  // scroll 事件要到下一帧才来，这期间内容又长高一大截（大段流式输出、工具 / 权限卡、图片加载完、
  // 已完成轮次从占位高度换成真实高度）时会误判成用户滚开，从此不再跟随、停在半截。
  // 内容变高不改 scrollTop，程序贴底只会让它变大；上方内容缩短时滚动锚定会让它变小，但离底距离不变。
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    const scrolledUp = el.scrollTop < lastTopRef.current - 1;
    lastTopRef.current = el.scrollTop;
    if (near) followRef.current = true;
    else if (scrolledUp) followRef.current = false;
    const away = !followRef.current;
    setAway((v) => (v === away ? v : away));
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

  // 分批补上更早的消息：已超出一屏时交给滚动锚定，不再强制重排
  useLayoutEffect(() => {
    if (followRef.current && !overflowedRef.current) scrollToBottom();
  }, [start, scrollToBottom]);

  // 新消息 / 队列 / 卡片 / 阶段变化时，贴底则跟随（离散事件，每轮几次）
  useLayoutEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [messages.length, last?.id, queued?.length, cards?.length, phase, scrollToBottom]);

  // 流式文本 / 工具 / 权限卡让内容变高：由 ResizeObserver 驱动贴底，不再每帧在 layout effect 里
  // 读 scrollHeight 强制同步重排。RO 每帧最多回调一次（布局之后、绘制之前），同一帧内的多次增长
  // 合并为一次滚动；用户往上滚开（followRef=false）后不再跟随。
  useStickToBottom(scrollRef, innerRef, followRef, scrollToBottom);

  const idle = phase === 'idle';
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i]!.role === 'assistant') return messages[i]!.id;
    return undefined;
  }, [messages]);
  // 定稿消息已到、标签状态还没回到空闲的那一帧：不再画一个空的流式区（状态行会闪一下）
  const showLive = phase !== 'idle' && !(running && !live && last?.role === 'assistant');

  return (
    <AgentsByCallContext.Provider value={agentMap}>
      <div className={styles.root} data-testid="conversation" data-status={phase}>
        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          data-testid="conv-scroll"
        >
          <div className={styles.inner} ref={innerRef}>
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
                {t('ui.usage-tools.show-earlier-messages', start)}
              </button>
            )}
            {start === 0 && renderCards(cardPlan.head)}
            {turns.map((turn, i) => (
              <section
                key={turn.key}
                // 已完成的轮次（不是最后一轮）：视口外跳过样式 / 布局 / 绘制
                className={i < turns.length - 1 ? `${styles.turn} ${styles.turnDone}` : styles.turn}
                data-testid="conv-turn"
              >
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
                <span className={styles.pendingTag}>{t('ui.usage-tools.queued')}</span>
                {onRemoveQueued && (
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={t('ui.usage-tools.remove-from-queue')}
                    title={t('ui.usage-tools.remove-from-queue')}
                    data-testid="conv-queued-remove"
                    onClick={() => onRemoveQueued(i)}
                  >
                    <Icon icon={X} size={13} />
                  </button>
                )}
              </div>
            ))}
            <BackgroundBar agents={backgroundAgents} count={backgroundCount} onStop={onStopAgent} />
            {modelSwitchTip != null && !running && (
              <div
                className={styles.modelTip}
                data-testid="conv-model-switch-tip"
                role="note"
                aria-live="polite"
              >
                <Icon icon={ArrowLeftRight} size={12} />
                <span>
                  {t(
                    'ui.cli-monitor.switched-to-changing-models-mid-conversation-means-the',
                    modelSwitchTip || t('ui.providers-schedule.default-model'),
                  )}
                </span>
              </div>
            )}
            {dormant && !running && (
              <div className={styles.dormant} data-testid="conv-dormant" role="status">
                {t('ui.cli-monitor.the-coding-assistant-process-went-dormant-after-being')}
              </div>
            )}
          </div>
        </div>
        {away && (
          <button
            type="button"
            className={styles.jump}
            data-testid="conv-jump-bottom"
            aria-label={t('ui.usage-tools.jump-to-latest')}
            title={t('ui.usage-tools.jump-to-latest')}
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

/** Memoized: rerenders only when its props change (App rerenders on tabs / panels do not). */
export const ConversationView = React.memo(function ConversationView(props: ConversationViewProps) {
  return <ConversationInner key={props.scopeId} {...props} />;
});
