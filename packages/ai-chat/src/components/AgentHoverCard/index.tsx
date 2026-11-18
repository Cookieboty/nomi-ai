/**
 * 子任务悬停卡片：鼠标停在子任务上（标签栏的子任务 / 侧边聊天标签、对话里的委派卡片 / 子代理行、会话详情的列表）
 * 约 300ms 后浮出一张小卡片：名字 + 状态、最近发给它的一句（右侧气泡）、它最近的输出（最多四行），
 * 内容跟着实时更新；点卡片打开 / 切到这个子任务的标签。移到卡片上不收起，移开 / Esc 收起；拖动标签时不出。
 * 内容只在卡片开着时订阅（./preview.ts 取摘录）。
 */
import { Icon, t } from '@nomi-ai/ui';
import { IconRobot as Bot, IconChevronRight } from '@tabler/icons-react';
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  useHarnessDetached,
  useHarnessLive,
  useHarnessTabMessages,
  useHarnessTabs,
} from '../../contexts/HarnessTabsContext';
import { sideChatName, useSideChat } from '../../services/sideChat';
import { tasksApi, type TaskTraceView } from '../../services/tasksClient';
import type { ConvMessage } from '../../types/conversation';
import { nestedOwnerBackend } from '../../utils/agentIdentity';
import { fromHarnessMessage } from '../../utils/convAdapters';
import { resolveDelegateTarget } from '../../utils/delegateTarget';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import type { LiveAgent } from '../../utils/liveState';
import type { SubagentTarget } from '../../utils/sideTabs';
import { EndpointIcon } from '../EndpointIcon';
import {
  applyTaskLiveEvent,
  liveFromView,
  nestedMessages,
  nomiTaskMessages,
  type NomiTaskLive,
} from '../SubagentPane/project';

import styles from './AgentHoverCard.module.css';
import {
  callStillOpen,
  excerpt,
  harnessCardState,
  lastExchange,
  nestedCardState,
  taskCardState,
  type AgentCardPreview,
  type AgentCardState,
} from './preview';

export const HOVER_OPEN_DELAY = 300;
const HOVER_CLOSE_DELAY = 150;

/** 正在拖标签：不出卡片（标签栏在拖动开始 / 结束时设） */
let dragging = false;
export function setHoverCardsSuppressed(on: boolean): void {
  dragging = on;
}

const STATE_LABEL: Record<AgentCardState, string> = {
  running: 'ui.session-workspace.agent-card-running',
  waiting: 'ui.session-workspace.needs-your-approval',
  done: 'ui.foundation.done',
  failed: 'ui.foundation.failed',
  idle: 'ui.mascot-theme.idle',
};

/** 实时来源里还没有内容时（主会话里刚派出的子代理等）用调用方给的任务 / 结果顶上 */
export interface AgentCardFallback {
  name?: string;
  lastUser?: string;
  lastOutput?: string;
}
const FallbackCtx = React.createContext<AgentCardFallback | undefined>(undefined);

const CardView: React.FC<{ preview: AgentCardPreview; backend?: string | null }> = ({
  preview: raw,
  backend,
}) => {
  const fb = React.useContext(FallbackCtx);
  const preview: AgentCardPreview = {
    ...raw,
    lastUser: raw.lastUser || excerpt(fb?.lastUser, 160),
    lastOutput: raw.lastOutput || excerpt(fb?.lastOutput),
  };
  const known = !!backend && backend in ENDPOINT_NAME;
  return (
    <>
      <div className={styles.head}>
        <span className={styles.avatar} aria-hidden="true">
          {known ? (
            <EndpointIcon backend={backend as keyof typeof ENDPOINT_NAME} size={16} decorative />
          ) : (
            <Icon icon={Bot} size={16} />
          )}
        </span>
        <span className={styles.name}>{preview.name}</span>
        <span className={styles.badge} data-state={preview.state} data-testid="agent-card-state">
          {t(STATE_LABEL[preview.state])}
        </span>
      </div>
      {preview.waitingHint && <div className={styles.waiting}>{preview.waitingHint}</div>}
      {preview.lastUser && (
        <div className={styles.section}>
          <div className={styles.label}>{t('ui.session-workspace.agent-card-task')}</div>
          <div className={styles.quote} data-testid="agent-card-user">
            {preview.lastUser}
          </div>
        </div>
      )}
      <div className={styles.section}>
        <div className={styles.label}>{t('ui.session-workspace.agent-card-latest')}</div>
        <div className={styles.output} data-testid="agent-card-output">
          {preview.lastOutput || (
            <span className={styles.muted}>{t('ui.session-workspace.no-output-yet')}</span>
          )}
        </div>
      </div>
    </>
  );
};

const EMPTY: readonly ConvMessage[] = [];
const EMPTY_AGENTS: Record<string, LiveAgent> = {};

const HarnessBody: React.FC<{ tabId: string }> = ({ tabId }) => {
  const tabs = useHarnessTabs();
  const tab = tabs.state?.tabs.find((x) => x.id === tabId);
  const raw = useHarnessTabMessages(tabId);
  const live = useHarnessLive((map) => map[tabId]);
  const backend = tab?.backend;
  // 只在卡片开着时算一次（React Compiler 负责缓存）
  const messages = backend ? raw.map((m) => fromHarnessMessage(m, backend)) : EMPTY;
  const running = tab?.status === 'running' || tab?.status === 'queued';
  const ex = lastExchange(messages, running ? live?.text : undefined);
  const permission = live?.permissions?.[0]?.summary ?? tab?.sandboxPending?.[0]?.path;
  const waiting = !!(live?.permissions?.length || tab?.sandboxPending?.length);
  const name = backend ? t(ENDPOINT_NAME[backend] ?? backend) : t('ui.usage-tools.subagent');
  return (
    <CardView
      backend={backend}
      preview={{
        name,
        state: harnessCardState(tab?.status, waiting),
        lastUser: ex.lastUser || excerpt(tab?.delegation?.goal, 160),
        lastOutput: ex.lastOutput,
        ...(waiting && permission ? { waitingHint: excerpt(String(permission), 120) } : {}),
      }}
    />
  );
};

const NomiTaskBody: React.FC<{ taskId: string }> = ({ taskId }) => {
  const [rec, setRec] = useState<{ goal: string; title: string; status: string } | null>(null);
  const [view, setView] = useState<TaskTraceView | null>(null);
  const [live, setLive] = useState<NomiTaskLive | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void tasksApi
        .get(taskId)
        .then((r) => {
          if (alive && r) setRec({ goal: r.task.goal, title: r.task.title, status: r.task.status });
        })
        .catch(() => undefined);
      void tasksApi
        .trace(taskId)
        .then((v) => {
          if (!alive) return;
          setView(v);
          setLive(liveFromView(v));
        })
        .catch(() => undefined);
    };
    load();
    const offChange = tasksApi.onChange(load);
    const offLive = tasksApi.onLive((p) => {
      if (p.id === taskId) setLive((prev) => applyTaskLiveEvent(prev, p.attemptId, p.event));
    });
    return () => {
      alive = false;
      offChange();
      offLive();
    };
  }, [taskId]);
  const messages = useMemo(
    () =>
      rec
        ? nomiTaskMessages(rec.goal, view ?? { attemptId: null, lines: [] }, live?.attemptId)
        : EMPTY,
    [rec, view, live?.attemptId],
  );
  const state = taskCardState(rec?.status);
  const ex = lastExchange(messages, state === 'running' ? live?.text : undefined);
  return (
    <CardView
      backend="nomi"
      preview={{
        name: rec?.title || t('ui.usage-tools.subagent'),
        state,
        lastUser: ex.lastUser,
        lastOutput: ex.lastOutput,
      }}
    />
  );
};

const NestedBody: React.FC<{
  callId: string;
  parentTabId: string | null;
  columnMessages: readonly ConvMessage[];
}> = ({ callId, parentTabId, columnMessages }) => {
  const tabs = useHarnessTabs();
  const parent = parentTabId ? tabs.state?.tabs.find((x) => x.id === parentTabId) : undefined;
  const raw = useHarnessTabMessages(parentTabId);
  const live = useHarnessLive((map) => (parentTabId ? map[parentTabId] : undefined));
  const off = useHarnessDetached((map) => (parentTabId ? map[parentTabId] : undefined));
  const parentMessages = useMemo(
    () => (parent ? raw.map((m) => fromHarnessMessage(m, parent.backend)) : columnMessages),
    [parent, raw, columnMessages],
  );
  const agent = useMemo(() => {
    const match = (a: LiveAgent) => a.callId === callId || a.id === callId;
    return (
      Object.values(off?.agents ?? EMPTY_AGENTS).find(match) ??
      Object.values(live?.agents ?? EMPTY_AGENTS).find(match)
    );
  }, [off?.agents, live?.agents, callId]);
  const deltas = useMemo(
    () => ({ ...off?.agentDeltas, ...live?.agentDeltas }),
    [off?.agentDeltas, live?.agentDeltas],
  );
  const messages = useMemo(
    () => nestedMessages(parentMessages, callId, live?.trace, { deltas }),
    [parentMessages, callId, live?.trace, deltas],
  );
  const state = nestedCardState(agent?.status, callStillOpen(live?.trace, callId));
  const ex = lastExchange(messages);
  return (
    <CardView
      backend={nestedOwnerBackend(parentTabId, tabs.state?.tabs, callId, columnMessages)}
      preview={{
        name: agent?.label || agent?.agentType || t('ui.usage-tools.subagent'),
        state,
        lastUser: ex.lastUser,
        lastOutput:
          ex.lastOutput || excerpt(state === 'running' ? agent?.progress : agent?.summary),
      }}
    />
  );
};

/** 侧边聊天：内容就在这个窗口的内存里 */
const SideChatBody: React.FC<{ chatId: string }> = ({ chatId }) => {
  const chat = useSideChat(chatId);
  const ex = lastExchange(chat?.messages ?? EMPTY, chat?.running?.live.text);
  const last = chat?.messages[chat.messages.length - 1];
  return (
    <CardView
      backend="nomi"
      preview={{
        name: sideChatName(chat) || t('ui.session-workspace.side-chat-title'),
        state: chat?.running ? 'running' : last?.error ? 'failed' : 'idle',
        lastUser: ex.lastUser,
        lastOutput: ex.lastOutput,
      }}
    />
  );
};

const CardBody: React.FC<{ target: SubagentTarget; columnMessages: readonly ConvMessage[] }> = ({
  target: raw,
  columnMessages,
}) => {
  const tabs = useHarnessTabs();
  // 按「进程内子代理」打开的其实是 Nomi 的一次委派：看它的 agent 标签（和侧栏、标签同一个判断）
  const target = resolveDelegateTarget(raw, tabs.state?.tabs, columnMessages);
  if (target.kind === 'harness') return <HarnessBody tabId={target.tabId} />;
  if (target.kind === 'nomi-task') return <NomiTaskBody taskId={target.taskId} />;
  if (target.kind === 'side-chat') return <SideChatBody chatId={target.chatId} />;
  return (
    <NestedBody
      callId={target.callId}
      parentTabId={target.parentTabId}
      columnMessages={columnMessages}
    />
  );
};

export type AgentCardPlacement = 'bottom' | 'left';

export interface Place {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  /** 极端超窄窗口左右均放不下而回退上下放置时，不拦截指针移动以免挡住相邻列表项 */
  nonInteractive?: boolean;
}

const CARD_W = 340;
const MIN_SIDE_W = 220;
const CARD_H_GUESS = 220;
const GAP = 8;
const MARGIN = 8;

/** 计算悬停卡片坐标：bottom 用于横向标签/行内标题；left 用于纵向列表外沿，避免遮挡相邻条目 */
export function placeCard(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  opts: {
    placement?: AgentCardPlacement;
    boundary?: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
    cardHeight?: number;
    viewport?: { width: number; height: number };
  } = {},
): Place {
  const vw = opts.viewport?.width ?? window.innerWidth;
  const vh = opts.viewport?.height ?? window.innerHeight;
  const h = opts.cardHeight ?? CARD_H_GUESS;
  const placement = opts.placement ?? 'bottom';

  if (placement === 'left') {
    const box = opts.boundary ?? rect;
    const clampTop = (t: number) =>
      Math.max(MARGIN, Math.min(t, Math.max(MARGIN, vh - h - MARGIN)));
    const availLeft = box.left - GAP - MARGIN;
    if (availLeft >= MIN_SIDE_W) {
      const width = Math.min(CARD_W, Math.floor(availLeft));
      return { left: box.left - GAP - width, top: clampTop(rect.top), width };
    }
    const availRight = vw - MARGIN - (box.right + GAP);
    if (availRight >= MIN_SIDE_W) {
      const width = Math.min(CARD_W, Math.floor(availRight));
      return { left: box.right + GAP, top: clampTop(rect.top), width };
    }
    // 极端超窄窗口：左右均不足最小宽度时回退上下放置且不拦截指针，保证能继续滑向下一项
    const width = Math.min(CARD_W, Math.max(160, vw - MARGIN * 2));
    const left = Math.max(MARGIN, Math.min(rect.left, vw - width - MARGIN));
    if (rect.bottom + 6 + h > vh - MARGIN && rect.top > h + 6 + MARGIN) {
      return { left, bottom: vh - rect.top + 6, width, nonInteractive: true };
    }
    return { left, top: rect.bottom + 6, width, nonInteractive: true };
  }

  const width = Math.min(CARD_W, Math.max(160, vw - MARGIN * 2));
  const left = Math.max(MARGIN, Math.min(rect.left, vw - width - MARGIN));
  if (rect.bottom + 6 + h > vh && rect.top > h) {
    return { left, bottom: vh - rect.top + 6, width };
  }
  return { left, top: rect.bottom + 6, width };
}

/** 全局仅保留一张激活/待关闭的悬停卡片，跨行移动时旧卡片立即收起 */
let pendingEntry: { id: string; close: () => void } | null = null;
let activeEntry: { id: string; close: () => void } | null = null;

/**
 * 包住触发元素（标签 / 卡片标题 / 列表项）。onOpen：点卡片时打开 / 切到这个子任务。
 * as：外层元素（标签栏里要 div，行内用 span）。
 */
export const AgentHoverCard: React.FC<{
  target: SubagentTarget | null | undefined;
  onOpen?: () => void;
  columnMessages?: readonly ConvMessage[];
  fallback?: AgentCardFallback;
  disabled?: boolean;
  placement?: AgentCardPlacement;
  boundaryRef?: React.RefObject<HTMLElement | null>;
  as?: 'span' | 'div';
  className?: string;
  children: React.ReactNode;
}> = ({
  target,
  onOpen,
  columnMessages = EMPTY,
  fallback,
  disabled,
  placement = 'bottom',
  boundaryRef,
  as = 'span',
  className,
  children,
}) => {
  const [place, setPlace] = useState<Place | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const id = useId();
  const clear = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (pendingEntry?.id === id) pendingEntry = null;
    if (activeEntry?.id === id) activeEntry = null;
    setPlace(null);
  }, [id]);
  const scheduleOpen = () => {
    if (!target || disabled || dragging) return;
    if (pendingEntry && pendingEntry.id !== id) {
      const prev = pendingEntry;
      pendingEntry = null;
      prev.close();
    }
    if (activeEntry && activeEntry.id !== id) {
      const prev = activeEntry;
      activeEntry = null;
      prev.close();
    }
    clear();
    openTimer.current = window.setTimeout(() => {
      const el = anchor.current;
      if (!el || dragging) return;
      activeEntry = { id, close };
      setPlace(
        placeCard(el.getBoundingClientRect(), {
          placement,
          boundary: boundaryRef?.current?.getBoundingClientRect(),
        }),
      );
    }, HOVER_OPEN_DELAY);
  };
  const scheduleClose = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    pendingEntry = { id, close };
    closeTimer.current = window.setTimeout(() => {
      if (pendingEntry?.id === id) pendingEntry = null;
      if (activeEntry?.id === id) activeEntry = null;
      setPlace(null);
    }, HOVER_CLOSE_DELAY);
  };
  useEffect(
    () => () => {
      clear();
      if (pendingEntry?.id === id) pendingEntry = null;
      if (activeEntry?.id === id) activeEntry = null;
    },
    [id],
  );
  const open = !!place && !!target;
  const reposition = useCallback(() => {
    const el = anchor.current;
    const card = cardRef.current;
    if (!el || !card || card.offsetHeight <= 0) return;
    const next = placeCard(el.getBoundingClientRect(), {
      placement,
      boundary: boundaryRef?.current?.getBoundingClientRect(),
      cardHeight: card.offsetHeight,
    });
    setPlace((cur) => {
      if (
        cur &&
        cur.left === next.left &&
        cur.top === next.top &&
        cur.bottom === next.bottom &&
        cur.width === next.width &&
        cur.nonInteractive === next.nonInteractive
      ) {
        return cur;
      }
      return next;
    });
  }, [placement, boundaryRef]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const card = cardRef.current;
    const ro =
      card && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
    if (card && ro) ro.observe(card);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = () => close();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close, reposition]);
  const Tag = as;
  return (
    <>
      <Tag
        ref={(el: HTMLElement | null) => {
          anchor.current = el;
        }}
        className={className ?? styles.trigger}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(e: React.PointerEvent) => {
          if (e.pointerType !== 'touch' && e.buttons === 0) scheduleOpen();
        }}
        onPointerLeave={scheduleClose}
        onPointerDown={close}
        onDragStart={close}
      >
        {children}
      </Tag>
      {open &&
        target &&
        createPortal(
          <div
            ref={cardRef}
            id={id}
            role="tooltip"
            className={styles.card}
            data-testid="agent-hover-card"
            style={{
              left: place.left,
              top: place.top,
              bottom: place.bottom,
              width: place.width,
              ...(place.nonInteractive ? { pointerEvents: 'none' } : {}),
            }}
            onPointerEnter={() => {
              window.clearTimeout(closeTimer.current);
              if (pendingEntry?.id === id) pendingEntry = null;
            }}
            onPointerLeave={scheduleClose}
            // 卡片 portal 在 body 上，但 React 事件仍沿组件树冒泡：别让外面的折叠按钮等收到
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              close();
              onOpen?.();
            }}
            data-clickable={onOpen ? 'true' : undefined}
          >
            <FallbackCtx.Provider value={fallback}>
              <CardBody target={target} columnMessages={columnMessages} />
            </FallbackCtx.Provider>
            {onOpen && (
              <div className={styles.action}>
                {t('ui.session-workspace.agent-card-open')}
                <Icon icon={IconChevronRight} size={12} />
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
};
