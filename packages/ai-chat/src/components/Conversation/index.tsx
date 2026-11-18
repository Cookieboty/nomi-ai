/**
 * 统一会话视图（Codex Desktop 式交互思路）：Nomi 普通对话与 Claude Code / Codex / Grok / dsh 标签共用。
 * 每一次发送是一轮：用户消息在上，助手回复按发生顺序分成文字段和工具，工具插在对应的文字之间。
 * 运行中同样穿插；贴底自动跟随，上滑不抢滚动条；长对话分页。
 * 消息操作：复制 / 重新生成 / 编辑重发 / 停止；排队中的待发消息。
 */
import { FloatingTip, Icon, t, useLocale } from '@nomi-ai/ui';
import {
  IconArrowDown as ArrowDown,
  IconArrowLeftRight as ArrowLeftRight,
  IconChevronsUp as ChevronsUp,
  IconStack2 as Layers,
  IconX as X,
} from '@tabler/icons-react';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';

import {
  getConversationFontSize,
  subscribeConversationFontSize,
} from '../../services/conversationFontSize';
import type { TranscriptView } from '../../services/transcriptView';
import type { SlashCard } from '../../slash/types';
import type { ConvLive, ConvMessage, ConvPhase } from '../../types/conversation';
import { deriveStatus } from '../../utils/convStatus';
import { timeLabels } from '../../utils/convTime';
import { activeStageStartedAt, countActiveLiveSteps } from '../../utils/minimalTurn';
import { buildTimeline, reduceTraceCached } from '../../utils/toolTrace';
import { SystemCardView } from '../SystemCards';

import { AgentsByCallContext, agentsByCall } from './agentContext';
import { ApprovePlanCard } from './ApprovePlanCard';
import { ConvHostContext } from './convHost';
import styles from './index.module.css';
import {
  AssistantBody,
  AssistantMessage,
  CompactionNote,
  type ConvSlots,
  UserMessage,
} from './Messages';
import { MinimalOpenProvider } from './MinimalSteps';
import { PermissionCard } from './PermissionCard';
import { StatusLine } from './StatusLine';
import { TranscriptViewProvider, useTranscriptViewMode } from './transcriptViewContext';

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
    <div
      className={styles.bgBar}
      data-testid="conv-background-bar"
      data-no-selection-toolbar=""
      aria-live="polite"
    >
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
    <div
      className={styles.permQueue}
      data-testid="conv-permission-queue"
      data-no-selection-toolbar=""
    >
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
export const LOAD_EARLIER_THRESHOLD = 96;
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

/** 快捷导航只显示助手回复的摘要，避免悬停卡片展开整段 Markdown / 代码内容。 */
export function summarizeAssistantText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const blocks = normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const block =
    blocks.find(
      (candidate) => !candidate.startsWith('```') && !/^#{1,6}\s+[^\n]+$/.test(candidate.trim()),
    ) ??
    blocks[0] ??
    normalized;
  const summary = block
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength).trimEnd()}…`;
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[。！？!?])/);
  if (match?.[1]) return match[1].trim();
  const period = text.search(/\.\s/);
  if (period >= 0) return text.slice(0, period + 1).trim();
  return text.trim();
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
    // 体量预算只约束首屏。用户点过「显示更早」之后按条数放开：
    // 一条巨大的工具轨迹（trace 上千条）就能把预算吃光，按预算走的话点多少次都跨不过去，
    // 而 loadingEarlier 的复位又等 start 变——结果就是「点了完全没反应」。
    if (extra === 0 && budget - w < 0 && i < messages.length) break;
    budget -= w;
    i--;
  }
  return i;
}

/** 窗口起点落在一轮中间时，回退到该轮用户消息，避免第一轮被助手 id 错标成 0。 */
export function snapStartToTurn(
  messages: readonly Pick<ConvMessage, 'role'>[],
  start: number,
): number {
  if (start <= 0 || messages.length === 0) return 0;
  let i = Math.min(start, messages.length - 1);
  while (i > 0 && messages[i]!.role !== 'user') i--;
  return i;
}

/** 第 turnIndex 轮第一条消息在全部消息中的下标（与 groupTurns 同一规则）。 */
export function turnStartMessageIndex(
  messages: readonly Pick<ConvMessage, 'role'>[],
  turnIndex: number,
): number {
  let current = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'user' || current < 0) current += 1;
    if (current === turnIndex) return i;
  }
  return 0;
}

/** 让分页窗口覆盖到 messageIndex 所需的 extra（一次算够，避免跳转时反复 +30）。 */
export function extraToReachMessage(
  messages: readonly Pick<ConvMessage, 'text' | 'trace' | 'error'>[],
  messageIndex: number,
): number {
  const target = Math.max(0, Math.min(messageIndex, Math.max(0, messages.length - 1)));
  if (windowStart(messages, 0) <= target) return 0;
  let lo = 1;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (windowStart(messages, mid) <= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const HOVER_WIDTHS = [24, 18, 14, 10] as const;
const HOVER_HEIGHTS = [4, 3, 2, 2] as const;

const ConversationQuickNavItem = React.memo(function ConversationQuickNavItem({
  item,
  distance,
  inView,
  tabIndex,
  onNavigate,
  onHover,
  onKeyDown,
}: {
  item: { turnIndex: number; width: number; title: string; detail: string };
  distance: number;
  inView: boolean;
  tabIndex: number;
  onNavigate: (index: number) => void;
  onHover: (index: number, el: HTMLButtonElement) => void;
  onKeyDown: (index: number, e: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const hovered = distance >= 0 && distance <= 3;
  const style = {
    '--quick-nav-width': `${item.width}px`,
    '--quick-nav-sx': hovered ? String(HOVER_WIDTHS[distance]! / item.width) : '1',
    '--quick-nav-sy': hovered ? String(HOVER_HEIGHTS[distance]! / 2) : '1',
  } as CSSProperties;
  return (
    <button
      type="button"
      className={styles.quickNavItem}
      aria-label={t('ui.chat-settings.jump-to-conversation-turn', String(item.turnIndex + 1))}
      data-in-view={inView ? 'true' : undefined}
      data-testid="conversation-quick-nav-item"
      data-turn-index={item.turnIndex}
      tabIndex={tabIndex}
      onMouseEnter={(e) => onHover(item.turnIndex, e.currentTarget)}
      onFocus={(e) => onHover(item.turnIndex, e.currentTarget)}
      onKeyDown={(e) => onKeyDown(item.turnIndex, e)}
      onClick={() => onNavigate(item.turnIndex)}
    >
      <span className={styles.quickNavLine} style={style} />
    </button>
  );
});

const ConversationQuickNav: React.FC<{
  items: readonly { turnIndex: number; width: number; title: string; detail: string }[];
  visibleIndices: ReadonlySet<number>;
  onNavigate: (index: number) => void;
}> = ({ items, visibleIndices, onNavigate }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const onHover = useCallback((turnIndex: number, el: HTMLButtonElement) => {
    setHovered(turnIndex);
    setAnchor(el);
    setViewport(el.closest<HTMLElement>('[data-testid="conversation"]'));
  }, []);
  const clearHover = useCallback(() => {
    setHovered(null);
    setAnchor(null);
    setViewport(null);
  }, []);
  const onItemKeyDown = useCallback(
    (turnIndex: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End')
        return;
      e.preventDefault();
      const pos = items.findIndex((item) => item.turnIndex === turnIndex);
      if (pos < 0) return;
      const next =
        e.key === 'ArrowDown'
          ? Math.min(items.length - 1, pos + 1)
          : e.key === 'ArrowUp'
            ? Math.max(0, pos - 1)
            : e.key === 'Home'
              ? 0
              : items.length - 1;
      const target = items[next];
      if (!target) return;
      setFocusIndex(target.turnIndex);
      const btn = navRef.current?.querySelector<HTMLButtonElement>(
        `[data-turn-index="${target.turnIndex}"]`,
      );
      btn?.focus();
      btn?.scrollIntoView({ block: 'nearest' });
      if (btn) onHover(target.turnIndex, btn);
    },
    [items, onHover],
  );
  useEffect(() => {
    if (items.length <= 5) return;
    const first = [...visibleIndices].sort((a, b) => a - b)[0];
    if (first == null) return;
    navRef.current
      ?.querySelector<HTMLElement>(`[data-turn-index="${first}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [visibleIndices, items.length]);
  if (items.length <= 5) return null;
  const hoveredPosition =
    hovered === null ? -1 : items.findIndex((item) => item.turnIndex === hovered);
  const tabStop =
    focusIndex != null && items.some((item) => item.turnIndex === focusIndex)
      ? focusIndex
      : (items.find((item) => visibleIndices.has(item.turnIndex))?.turnIndex ??
        items[0]!.turnIndex);
  const hoveredItem =
    hovered === null ? undefined : items.find((item) => item.turnIndex === hovered);
  return (
    <>
      <nav
        ref={navRef}
        className={styles.quickNav}
        data-hovered={hovered === null ? undefined : 'true'}
        aria-label={t('ui.chat-settings.conversation-quick-navigation')}
        data-testid="conversation-quick-nav"
        onMouseLeave={clearHover}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          clearHover();
        }}
      >
        {items.map((item, position) => {
          const distance =
            hoveredPosition < 0 ? -1 : Math.min(4, Math.abs(position - hoveredPosition));
          return (
            <ConversationQuickNavItem
              key={item.turnIndex}
              item={item}
              distance={distance}
              inView={visibleIndices.has(item.turnIndex)}
              tabIndex={item.turnIndex === tabStop ? 0 : -1}
              onNavigate={onNavigate}
              onHover={onHover}
              onKeyDown={onItemKeyDown}
            />
          );
        })}
      </nav>
      <FloatingTip
        anchor={anchor}
        placement="side"
        viewport={viewport}
        className={styles.quickNavTip}
      >
        {hoveredItem ? (
          <>
            <span className={styles.quickNavTipTitle}>{hoveredItem.title}</span>
            {hoveredItem.detail ? (
              <span className={styles.quickNavTipText}>{hoveredItem.detail}</span>
            ) : null}
          </>
        ) : null}
      </FloatingTip>
    </>
  );
};

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
  /** agent 进程因空闲被回收：显示提示，发送下一条消息会自动续接 */
  dormant?: boolean;
  /**
   * 会话中途换了模型、还没发送下一条消息：切换后的模型名（空串 = 默认模型），显示一条弱提示。
   * 由来源决定（agent 标签看切换记录，Nomi 对话比较最后一条助手消息的模型）
   */
  modelSwitchTip?: string | null;
  /** 仍在运行的后台子代理（跨轮次）与后台任务总数（docs/development/coding-agents.md） */
  backgroundAgents?: ReadonlyArray<{
    id: string;
    label?: string;
    startedAt: number;
    stoppable: boolean;
  }>;
  backgroundCount?: number;
  onStopAgent?: (agentId: string) => void;
  /** 沙箱挡下、等授权的卡片（agent 标签；一轮结束后也还在） */
  sandboxRequests?: React.ReactNode;
  /** 当前会话的 Transcript view；由 ChatBody 按会话注入；不传则跟随外层会话 */
  transcriptView?: TranscriptView;
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
  sandboxRequests,
}) => {
  const fontSize = useSyncExternalStore(subscribeConversationFontSize, getConversationFontSize);
  const transcriptView = useTranscriptViewMode();
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
  const start = snapStartToTurn(messages, Math.max(fullStart, messages.length - eagerCount));
  // 记住切片：live / 状态变化引起的重渲染（消息没变）不让 groupTurns 重算
  const shown = useMemo(() => (start > 0 ? messages.slice(start) : messages), [messages, start]);
  const turns = useMemo(() => groupTurns(shown), [shown]);
  const allTurns = useMemo(() => groupTurns(messages), [messages]);
  const allTurnIndexByMessage = useMemo(() => {
    const map = new Map<string, number>();
    allTurns.forEach((turn, index) => {
      for (const message of turn.messages) map.set(message.id, index);
    });
    return map;
  }, [allTurns]);
  const quickNavItems = useMemo(
    () =>
      allTurns.flatMap((turn, turnIndex) => {
        // 导航详情只反映模型返回的内容，用户输入不参与宽度或悬停文案计算。
        const text = turn.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => [message.text, message.error].filter(Boolean).join('\n'))
          .filter(Boolean)
          .join('\n\n')
          .trim();
        const detail = summarizeAssistantText(text);
        if (!detail) return [];
        const title = firstSentence(detail);
        return {
          turnIndex,
          width: Math.max(4, Math.min(11, 4 + Math.round(Math.log2(detail.length + 1)))),
          title,
          detail: detail.slice(title.length).trim(),
        };
      }),
    [allTurns],
  );
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
  const loadingEarlierRef = useRef(false);
  const [visibleTurns, setVisibleTurns] = useState<ReadonlySet<number>>(new Set());
  const [pendingTurn, setPendingTurn] = useState<number | null>(null);
  const jumpingRef = useRef(false);
  const skipStagingRef = useRef(false);
  const jumpClearRef = useRef<number | null>(null);

  const commitVisibleTurns = useCallback((next: Set<number>) => {
    setVisibleTurns((current) => {
      if (current.size === next.size && [...current].every((index) => next.has(index)))
        return current;
      return next;
    });
  }, []);

  const measureVisibleTurns = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const viewport = scroller.getBoundingClientRect();
    const next = new Set<number>();
    scroller.querySelectorAll<HTMLElement>('[data-testid="conv-turn"]').forEach((turn) => {
      const rect = turn.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return;
      const index = Number(turn.dataset.turnIndex);
      if (Number.isFinite(index)) next.add(index);
    });
    commitVisibleTurns(next);
  }, [commitVisibleTurns]);

  const endJump = useCallback(() => {
    jumpingRef.current = false;
    if (jumpClearRef.current != null) {
      window.clearTimeout(jumpClearRef.current);
      jumpClearRef.current = null;
    }
  }, []);

  const navigateToTurn = useCallback(
    (index: number) => {
      followRef.current = false;
      jumpingRef.current = true;
      const scroller = scrollRef.current;
      const target = scroller?.querySelector<HTMLElement>(
        `[data-testid="conv-turn"][data-turn-index="${index}"]`,
      );
      if (!scroller) return;
      if (!target) {
        setPendingTurn(index);
        const messageIndex = turnStartMessageIndex(messages, index);
        const needed = extraToReachMessage(messages, messageIndex);
        skipStagingRef.current = true;
        setExtra((value) => Math.max(value, needed));
        setEagerCount(messages.length);
        return;
      }
      const reduce =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scroller.scrollTo({
        top: Math.max(0, target.offsetTop - 24),
        behavior: reduce ? 'instant' : 'smooth',
      });
      setAway(true);
      if (reduce) {
        endJump();
        return;
      }
      const done = () => {
        scroller.removeEventListener('scrollend', done);
        endJump();
      };
      scroller.addEventListener('scrollend', done, { once: true });
      if (jumpClearRef.current != null) window.clearTimeout(jumpClearRef.current);
      jumpClearRef.current = window.setTimeout(done, 800);
    },
    [messages, endJump],
  );

  const loadEarlier = useCallback(() => {
    if (start <= 0 || loadingEarlierRef.current) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    anchorRef.current = scroller.scrollHeight;
    loadingEarlierRef.current = true;
    setExtra((value) => value + LOAD_MORE_STEP);
  }, [start]);

  const liveTrace = live?.trace;
  const liveEntries = useMemo(
    () => (liveTrace?.length ? reduceTraceCached(liveTrace) : []),
    [liveTrace],
  );
  const liveItems = useMemo(
    () => (liveEntries.length ? buildTimeline(liveEntries, running) : []),
    [liveEntries, running],
  );
  const liveStepCount = useMemo(
    () =>
      transcriptView === 'minimal' && running
        ? countActiveLiveSteps(liveEntries, live?.thinking)
        : 0,
    [transcriptView, running, liveEntries, live?.thinking],
  );
  const activeStartedAt = useMemo(
    () => (running ? activeStageStartedAt(liveEntries, live?.startedAt) : undefined),
    [running, liveEntries, live?.startedAt],
  );
  const status = deriveStatus({ phase, live, items: liveItems });

  // 分批往上补消息时不读 scrollHeight / 不改 scrollTop：每批都强制整列重排，切会话时是主要开销之一。
  // 内容已经超出一屏时，浏览器的滚动锚定（overflow-anchor）会让视口里的内容保持不动；
  // 还没超出一屏（scrollTop 为 0，锚定不生效）时才由下面的 effect 补一次贴底。
  useEffect(() => {
    if (skipStagingRef.current) {
      skipStagingRef.current = false;
      return;
    }
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
    // 切换会话和贴底跟随均立即定位，不继承外部 CSS 的平滑滚动。
    el.scrollTo({ top: h, behavior: 'instant' });
    lastTopRef.current = el.scrollTop;
    overflowedRef.current = h > el.clientHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && anchorRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
    }
    // 无论 start 变没变都要解锁：之前只在 start 变化时置 false，
    // 一次点击没让 start 变化（预算卡住 / scroller 一时不在）就会让它永久为 true，
    // 之后点「显示更早」、滚到顶部全部静默失改。
    anchorRef.current = null;
    loadingEarlierRef.current = false;
  }, [extra]);

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
    if (!jumpingRef.current && el.scrollTop <= LOAD_EARLIER_THRESHOLD) loadEarlier();
    const near = isNearBottom(el);
    const scrolledUp = el.scrollTop < lastTopRef.current - 1;
    lastTopRef.current = el.scrollTop;
    if (near) followRef.current = true;
    else if (scrolledUp) followRef.current = false;
    const away = !followRef.current;
    setAway((v) => (v === away ? v : away));
  }, [loadEarlier]);

  // 首次挂载（切换会话时由外层 key 重建）：直接到底部
  useLayoutEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // 用 IntersectionObserver 跟踪当前轮次；没有 IO（测试环境）时退回 rAF 节流测量。
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (typeof IntersectionObserver === 'undefined') {
      let raf = 0;
      const onScroll = () => {
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          measureVisibleTurns();
        });
      };
      measureVisibleTurns();
      scroller.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        scroller.removeEventListener('scroll', onScroll);
        if (raf) window.cancelAnimationFrame(raf);
      };
    }
    const seen = new Map<number, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.turnIndex);
          if (!Number.isFinite(index)) continue;
          seen.set(index, entry.isIntersecting);
        }
        const next = new Set<number>();
        for (const [index, on] of seen) if (on) next.add(index);
        commitVisibleTurns(next);
      },
      { root: scroller, threshold: 0 },
    );
    scroller.querySelectorAll<HTMLElement>('[data-testid="conv-turn"]').forEach((el) => {
      io.observe(el);
    });
    return () => io.disconnect();
  }, [messages.length, start, turns.length, commitVisibleTurns, measureVisibleTurns]);

  useLayoutEffect(() => {
    if (pendingTurn === null) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-testid="conv-turn"][data-turn-index="${pendingTurn}"]`,
    );
    if (target) {
      setPendingTurn(null);
      navigateToTurn(pendingTurn);
    }
  }, [pendingTurn, start, navigateToTurn]);

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
      if (messages[i]!.role === 'assistant' && messages[i]!.origin !== 'compaction')
        return messages[i]!.id;
    return undefined;
  }, [messages]);
  const lastTurn = turns[turns.length - 1];
  const doneInLastTurn = lastTurn
    ? lastTurn.messages.filter((m) => m.role === 'assistant' && m.origin !== 'compaction').length
    : 0;
  const liveMinimalKey = lastTurn ? `turn:${lastTurn.key}:${doneInLastTurn}` : 'turn:__head:0';
  const minimalStepsOwnsStatus = transcriptView === 'minimal' && running && liveStepCount > 0;
  // 定稿消息已到、标签状态还没回到空闲的那一帧：不再画一个空的流式区（状态行会闪一下）
  const showLive = phase !== 'idle' && !(running && !live && last?.role === 'assistant');
  const liveNode = showLive ? (
    <div className={styles.assistant} data-testid="conv-live" aria-live="polite">
      {running && (
        <AssistantBody
          text={live?.text ?? ''}
          trace={live?.trace}
          breaks={live?.textBreaks}
          live
          streaming
          thinking={live?.thinking}
          liveStatus={status ? { status, startedAt: activeStartedAt } : undefined}
          minimalStateKey={liveMinimalKey}
          extra={<PermissionQueue live={live} onPermission={onPermission} />}
        />
      )}
      {status && !minimalStepsOwnsStatus && (
        <StatusLine
          status={status}
          startedAt={activeStartedAt}
          stepCount={liveStepCount > 0 ? liveStepCount : undefined}
          minimal={transcriptView === 'minimal'}
        />
      )}
    </div>
  ) : null;

  return (
    <AgentsByCallContext.Provider value={agentMap}>
      <div
        className={styles.root}
        data-testid="conversation"
        data-selection-scope=""
        data-status={phase}
        style={
          { '--conv-text': `${fontSize}px`, '--conv-leading': `${fontSize + 8}px` } as CSSProperties
        }
      >
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
                  loadEarlier();
                }}
              >
                <Icon icon={ChevronsUp} size={14} />
                {t('ui.usage-tools.show-earlier-messages', start)}
              </button>
            )}
            {start === 0 && renderCards(cardPlan.head)}
            {turns.map((turn, i) => {
              let assistantSeq = 0;
              return (
                <section
                  key={turn.key}
                  // 已完成的轮次（不是最后一轮）：视口外跳过样式 / 布局 / 绘制
                  className={
                    i < turns.length - 1 ? `${styles.turn} ${styles.turnDone}` : styles.turn
                  }
                  data-testid="conv-turn"
                  data-turn-index={allTurnIndexByMessage.get(turn.messages[0]?.id ?? turn.key) ?? i}
                >
                  {turn.messages.map((m) => (
                    <React.Fragment key={m.id}>
                      {m.origin === 'compaction' ? (
                        <CompactionNote message={m} />
                      ) : m.role === 'user' ? (
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
                          minimalStateKey={`turn:${turn.key}:${assistantSeq++}`}
                        />
                      )}
                      {renderCards(cardPlan.byMsg.get(m.id))}
                    </React.Fragment>
                  ))}
                  {i === turns.length - 1 && liveNode}
                </section>
              );
            })}
            {turns.length === 0 && liveNode}
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
                    data-testid="conv-queued-remove"
                    onClick={() => onRemoveQueued(i)}
                  >
                    <Icon icon={X} size={13} />
                  </button>
                )}
              </div>
            ))}
            <BackgroundBar agents={backgroundAgents} count={backgroundCount} onStop={onStopAgent} />
            {sandboxRequests}
            {modelSwitchTip != null && !running && (
              <div
                className={styles.modelTip}
                data-testid="conv-model-switch-tip"
                data-no-selection-toolbar=""
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
              <div
                className={styles.dormant}
                data-testid="conv-dormant"
                data-no-selection-toolbar=""
                role="status"
              >
                {t('ui.cli-monitor.the-coding-assistant-process-went-dormant-after-being')}
              </div>
            )}
          </div>
        </div>
        <ConversationQuickNav
          items={quickNavItems}
          visibleIndices={visibleTurns}
          onNavigate={navigateToTurn}
        />
        {away && (
          <button
            type="button"
            className={styles.jump}
            data-testid="conv-jump-bottom"
            aria-label={t('ui.usage-tools.jump-to-latest')}
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
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  // 没传（委派卡片、子代理面板里嵌的会话）：跟随外层会话的设置
  const inherited = useTranscriptViewMode();
  // 没有冒号的 scope 是 agent 标签 id。子代理「查看」用它当父转录。
  const parentTabId =
    typeof props.scopeId === 'string' && !props.scopeId.includes(':') ? props.scopeId : null;
  return (
    <ConvHostContext.Provider value={parentTabId}>
      <TranscriptViewProvider value={props.transcriptView ?? inherited}>
        <MinimalOpenProvider key={props.scopeId}>
          <ConversationInner key={props.scopeId} {...props} />
        </MinimalOpenProvider>
      </TranscriptViewProvider>
    </ConvHostContext.Provider>
  );
});
