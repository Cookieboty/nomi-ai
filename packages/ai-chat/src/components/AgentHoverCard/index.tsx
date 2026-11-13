/**
 * 子任务悬停卡片：鼠标停在子任务上（标签栏的子任务 / 侧边聊天标签、对话里的委派卡片 / 子代理行、会话详情的列表）
 * 约 300ms 后浮出一张小卡片：名字 + 状态、最近发给它的一句（右侧气泡）、它最近的输出（最多四行），
 * 内容跟着实时更新；点卡片打开 / 切到这个子任务的标签。移到卡片上不收起，移开 / Esc 收起；拖动标签时不出。
 * 内容只在卡片开着时订阅（./preview.ts 取摘录）。
 */
import { Icon, t } from '@nomi-ai/ui';
import { Bot, Loader2 } from 'lucide-react';
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
import { fromHarnessMessage } from '../../utils/convAdapters';
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
  return (
    <>
      <div className={styles.head}>
        {backend && backend in ENDPOINT_NAME ? (
          <EndpointIcon backend={backend as keyof typeof ENDPOINT_NAME} size={16} decorative />
        ) : (
          <Icon icon={Bot} size={16} />
        )}
        <span className={styles.name}>{preview.name}</span>
        {preview.state === 'running' && (
          <span className={styles.spin} aria-hidden="true">
            <Icon icon={Loader2} size={14} />
          </span>
        )}
      </div>
      <div className={styles.state} data-state={preview.state} data-testid="agent-card-state">
        {t(STATE_LABEL[preview.state])}
      </div>
      {preview.waitingHint && <div className={styles.waiting}>{preview.waitingHint}</div>}
      {preview.lastUser && (
        <div className={styles.bubble} data-testid="agent-card-user">
          {preview.lastUser}
        </div>
      )}
      <div className={styles.output} data-testid="agent-card-output">
        {preview.lastOutput || (
          <span className={styles.muted}>{t('ui.session-workspace.no-output-yet')}</span>
        )}
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
      backend={parent?.backend ?? null}
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
  target,
  columnMessages,
}) => {
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

interface Place {
  left: number;
  top?: number;
  bottom?: number;
}

const CARD_W = 340;
const CARD_H_GUESS = 240;

function placeFor(rect: DOMRect): Place {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_W - 8));
  if (rect.bottom + 6 + CARD_H_GUESS > window.innerHeight && rect.top > CARD_H_GUESS)
    return { left, bottom: window.innerHeight - rect.top + 6 };
  return { left, top: rect.bottom + 6 };
}

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
  as?: 'span' | 'div';
  className?: string;
  children: React.ReactNode;
}> = ({
  target,
  onOpen,
  columnMessages = EMPTY,
  fallback,
  disabled,
  as = 'span',
  className,
  children,
}) => {
  const [place, setPlace] = useState<Place | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
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
    setPlace(null);
  }, []);
  const scheduleOpen = () => {
    if (!target || disabled || dragging) return;
    clear();
    openTimer.current = window.setTimeout(() => {
      const el = anchor.current;
      if (!el || dragging) return;
      setPlace(placeFor(el.getBoundingClientRect()));
    }, HOVER_OPEN_DELAY);
  };
  const scheduleClose = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPlace(null), HOVER_CLOSE_DELAY);
  };
  useEffect(() => () => clear(), []);
  const open = !!place && !!target;
  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = () => close();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);
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
            id={id}
            role="tooltip"
            className={styles.card}
            data-testid="agent-hover-card"
            style={{ left: place.left, top: place.top, bottom: place.bottom, width: CARD_W }}
            onPointerEnter={() => window.clearTimeout(closeTimer.current)}
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
              <div className={styles.hint}>{t('ui.session-workspace.agent-card-open')}</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
};
