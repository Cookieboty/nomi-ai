/**
 * 统一会话视图（Codex Desktop 式交互思路）：Nomi 普通对话与 Claude Code / Codex / Grok / dsh 标签共用。
 * 每一次发送是一轮：用户消息在上，助手回复按发生顺序分成文字段和工具，工具插在对应的文字之间。
 * 运行中同样穿插；贴底自动跟随，上滑不抢滚动条；长对话分页。
 * 消息操作：复制 / 重新生成 / 编辑重发 / 停止；排队中的待发消息。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
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
import {
  ConversationQuickNav,
  firstSentence,
  summarizeAssistantText,
} from './ConversationQuickNav';
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
import { HandoffTriggerButton, StatusLine } from './StatusLine';
import { TranscriptViewProvider, useTranscriptViewMode } from './transcriptViewContext';
import {
  captureScrollAnchor,
  extraToReachMessage,
  groupTurns,
  INITIAL_RENDER,
  LOAD_EARLIER_THRESHOLD,
  LOAD_MORE_STEP,
  RENDER_STEP,
  type ScrollAnchor,
  snapStartToTurn,
  turnStartMessageIndex,
  WINDOW_BUDGET,
  WINDOW_MESSAGES,
  windowStart,
} from './windowing';

export type { ConvSlots } from './Messages';
export {
  extraToReachMessage,
  groupTurns,
  INITIAL_RENDER,
  LOAD_EARLIER_THRESHOLD,
  LOAD_MORE_STEP,
  RENDER_STEP,
  snapStartToTurn,
  summarizeAssistantText,
  turnStartMessageIndex,
  WINDOW_BUDGET,
  WINDOW_MESSAGES,
  windowStart,
};

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
  /** 前台长程 Nomi 对话流支持「主动转后台」时的回调 */
  onHandoffToBackground?: () => Promise<unknown> | void;
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
  onHandoffToBackground,
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
  const minimal = transcriptView === 'minimal';
  const [extra, setExtra] = useState(0);
  const rawFullStart = useMemo(
    () => windowStart(messages, extra, { minimal }),
    [messages, extra, minimal],
  );
  const snappedRawFull = useMemo(
    () => snapStartToTurn(messages, rawFullStart),
    [messages, rawFullStart],
  );
  // 切换会话 / 首次挂载：先只渲染末尾几条（首帧尽快出现），其余按帧分批往上补，主线程不会被一次性占满
  const [eagerCount, setEagerCount] = useState(INITIAL_RENDER);
  // 锁定单会话内窗口上界严格不收缩，防止新消息 / 大 trace 完成瞬间卸载上方已读历史引发跳动
  const [windowAnchor, setWindowAnchor] = useState<{
    floor: number;
    floorId: string | null;
    len: number;
    staged: boolean;
  }>(() => {
    if (messages.length === 0) return { floor: -1, floorId: null, len: 0, staged: false };
    const stagedNow =
      snapStartToTurn(messages, Math.max(snappedRawFull, messages.length - INITIAL_RENDER)) <=
      snappedRawFull;
    return {
      floor: snappedRawFull,
      floorId: messages[snappedRawFull]?.id ?? null,
      len: messages.length,
      staged: stagedNow,
    };
  });

  let nextAnchor = windowAnchor;
  let resetEager = false;
  if (messages.length === 0) {
    if (windowAnchor.floor !== -1 || windowAnchor.len !== 0 || windowAnchor.staged) {
      nextAnchor = { floor: -1, floorId: null, len: 0, staged: false };
      resetEager = true;
    }
  } else if (windowAnchor.floor < 0) {
    const stagedNow =
      snapStartToTurn(messages, Math.max(snappedRawFull, messages.length - INITIAL_RENDER)) <=
      snappedRawFull;
    nextAnchor = {
      floor: snappedRawFull,
      floorId: messages[snappedRawFull]?.id ?? null,
      len: messages.length,
      staged: stagedNow,
    };
    resetEager = eagerCount !== INITIAL_RENDER || extra !== 0;
  } else {
    const truncated =
      messages.length < windowAnchor.len ||
      (windowAnchor.floorId !== null && messages[windowAnchor.floor]?.id !== windowAnchor.floorId);
    const nextFloor = truncated ? snappedRawFull : Math.min(windowAnchor.floor, snappedRawFull);
    const reachedFloor =
      snapStartToTurn(messages, Math.max(nextFloor, messages.length - eagerCount)) <= nextFloor;
    const nextStaged = truncated ? true : windowAnchor.staged || reachedFloor;
    const nextFloorId = messages[nextFloor]?.id ?? null;
    if (
      nextFloor !== windowAnchor.floor ||
      nextFloorId !== windowAnchor.floorId ||
      messages.length !== windowAnchor.len ||
      nextStaged !== windowAnchor.staged
    ) {
      nextAnchor = {
        floor: nextFloor,
        floorId: nextFloorId,
        len: messages.length,
        staged: nextStaged,
      };
    }
  }

  if (nextAnchor !== windowAnchor) setWindowAnchor(nextAnchor);
  if (resetEager) {
    if (eagerCount !== INITIAL_RENDER) setEagerCount(INITIAL_RENDER);
    if (extra !== 0) setExtra(0);
  }

  const fullStart = nextAnchor.floor < 0 ? 0 : nextAnchor.floor;
  const staged = nextAnchor.staged;
  const start = staged
    ? fullStart
    : snapStartToTurn(messages, Math.max(fullStart, messages.length - eagerCount));
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
  /** 向上加载更早消息前的视口锚点：加载后据此精准保持原阅读位置不跳 */
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const topSentinelRef = useRef<HTMLButtonElement | null>(null);
  const prevStartRef = useRef(start);
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
        const needed = extraToReachMessage(messages, messageIndex, { minimal });
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
    [messages, minimal, endJump],
  );

  const loadEarlier = useCallback(() => {
    if (start <= 0 || loadingEarlierRef.current) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    anchorRef.current = followRef.current ? null : captureScrollAnchor(scroller);
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

  // 分批往上补消息时不读 scrollHeight：待每批提交后在下面的 layoutEffect 中统一处理（贴底同步贴底 / 上滑精准锚定）。
  useEffect(() => {
    if (skipStagingRef.current) {
      skipStagingRef.current = false;
      return;
    }
    if (start <= fullStart || staged) return;
    const id = window.setTimeout(() => {
      if (!followRef.current && scrollRef.current) {
        anchorRef.current = captureScrollAnchor(scrollRef.current);
      }
      setEagerCount((n) => n + RENDER_STEP);
    }, 0);
    return () => window.clearTimeout(id);
  }, [start, fullStart, staged]);

  // 顶部哨兵无感向上预加载：当首屏未填满视口+400px，或用户上滑接近顶部时自动展开更早历史
  useEffect(() => {
    if (start <= 0 || start !== fullStart) return;
    const scroller = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!scroller || !sentinel || typeof IntersectionObserver === 'undefined') return;
    if (scroller.clientHeight <= 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (jumpingRef.current) return;
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        loadEarlier();
      },
      { root: scroller, rootMargin: '400px 0px 0px 0px', threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [start, fullStart, loadEarlier]);

  /** 上一次看到的滚动条与容器尺寸快照：区分主动滚动与内容高度缩小造成的被动 clamp */
  const lastTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = el.scrollHeight;
    // 切换会话和贴底跟随均立即定位，不继承外部 CSS 的平滑滚动。
    el.scrollTo({ top: h, behavior: 'instant' });
    lastTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = h;
    lastClientHeightRef.current = el.clientHeight;
  }, []);

  // 顶部窗口向前扩开（分批补齐或自动/手动加载更早消息）后保持阅读位置或同步贴底
  useLayoutEffect(() => {
    const prevStart = prevStartRef.current;
    prevStartRef.current = start;
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    loadingEarlierRef.current = false;
    if (!el || start >= prevStart) return;
    if (followRef.current) {
      scrollToBottom();
      return;
    }
    if (!anchor) return;
    let adjusted = false;
    if (anchor.turnIndex !== null) {
      const target = el.querySelector<HTMLElement>(
        `[data-testid="conv-turn"][data-turn-index="${anchor.turnIndex}"]`,
      );
      const box = el.getBoundingClientRect();
      const rect = target?.getBoundingClientRect();
      if (rect && rect.height > 0) {
        const delta = rect.top - box.top - anchor.offsetTop;
        if (Math.abs(delta) > 0.5) el.scrollTop += delta;
        adjusted = true;
      }
    }
    if (!adjusted) {
      const delta = el.scrollHeight - anchor.scrollHeight;
      if (delta > 0) el.scrollTop += delta;
    }
    lastTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    lastClientHeightRef.current = el.clientHeight;
  }, [start, extra, scrollToBottom]);

  // 滚轮 / 触控板往上：立即停止跟随（不等 scroll 事件，避免同一帧里的增长又把视口拉回底部）
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) followRef.current = false;
  }, []);

  // 区分用户主动上下滚与内容高度变小导致的被动 clamp：
  // 1. 运行中长内容 → 完成后极简收起导致高度骤缩时，严禁误将已上滑阅读历史的用户吸回底部，也严禁误断贴底态或误触加载更早。
  // 2. 内容变高时不改 scrollTop、程序贴底后下一帧才来的 scroll 事件不会误断跟随。
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    const prevTop = lastTopRef.current;
    const prevSh = lastScrollHeightRef.current;
    const prevCh = lastClientHeightRef.current;
    lastTopRef.current = top;
    lastScrollHeightRef.current = sh;
    lastClientHeightRef.current = ch;

    const heightShrank = sh < prevSh - 1 || ch < prevCh - 1;
    const near = isNearBottom(el);
    const scrolledUp = top < prevTop - 1;
    const scrolledDown = top > prevTop + 1;

    if (
      !jumpingRef.current &&
      !heightShrank &&
      top <= LOAD_EARLIER_THRESHOLD &&
      (scrolledUp || top === 0)
    ) {
      loadEarlier();
    }

    if (followRef.current) {
      if (!near && scrolledUp && !heightShrank) followRef.current = false;
    } else if (near && (scrolledDown || (!heightShrank && !scrolledUp))) {
      followRef.current = true;
    }
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
  const handoffForceShow = liveItems.length > 0 || !!live?.trace?.some((x) => x.type === 'tool');
  const handoffBlocked =
    !running ||
    status?.kind === 'permission' ||
    status?.kind === 'blocked' ||
    status?.kind === 'queued';
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
          handoff={
            onHandoffToBackground
              ? {
                  forceShow: handoffForceShow,
                  blocked: handoffBlocked,
                  onHandoff: onHandoffToBackground,
                }
              : undefined
          }
        />
      )}
      {status && minimalStepsOwnsStatus && onHandoffToBackground && !handoffBlocked && (
        <div className={styles.minimalHandoffRow}>
          <HandoffTriggerButton
            key={activeStartedAt ?? 'none'}
            startedAt={activeStartedAt}
            forceShow={handoffForceShow}
            blocked={handoffBlocked}
            onHandoff={onHandoffToBackground}
          />
        </div>
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
                ref={topSentinelRef}
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
                          userPrompt={turn.messages.find((x) => x.role === 'user')?.text}
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
