/**
 * 会话详情小卡片：悬停 / 键盘聚焦侧栏里的会话时在右侧弹出。
 * 第一行标题 + 端点图标 + 多久前，第二行状态，第三行工作区（目录名，完整路径在 title 里）。
 * 挂到 body 上用 fixed 定位，不会被侧栏裁掉；不接收鼠标事件，不挡操作。
 */
import { brand } from '@nomi-ai/types';
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { IconFolder as Folder } from '@tabler/icons-react';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { ConvoOutcome } from '../../contexts/aiChatState';
import type { HarnessTabMeta } from '../../services/harnessClient';
import { sessionPlace } from '../../services/projects';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { isImeComposing } from '../../utils/keyboard';
import { EndpointIcon } from '../EndpointIcon';

import rail from './SessionPeek.module.css';
import { rel, rowLive } from './SidebarRows';
import type { Meta } from './types';

/** 状态点对应的文字；没有特别状态时不显示 */
const LIVE_LABEL: Record<string, string> = {
  running: 'ui.chat-settings.in-progress',
  queued: 'ui.mascot-theme.queued',
  done: 'ui.foundation.done',
  unread: 'ui.mascot-theme.new-result',
  error: 'ui.chat-settings.error',
  stopped: 'ui.chat-settings.stopped',
  background: 'ui.chat-settings.running-in-background',
  dormant: 'ui.cli-monitor.dormant',
};

export const sessionName = (c: Meta) => (c.name ? t(c.name) : t('ui.chat-settings.new-chat'));

export const sessionStatus = (
  tab: HarnessTabMeta | undefined,
  running?: boolean,
  done?: boolean,
  outcome?: ConvoOutcome,
): string => {
  const key = LIVE_LABEL[rowLive(tab, running, done, outcome)];
  return key ? t(key) : '';
};

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

const HIDE_DELAY = 180;

export interface SessionPeekPos {
  id: string;
  top: number;
  left: number;
}

export interface SessionPeekController {
  getSnapshot: () => SessionPeekPos | null;
  subscribe: (listener: () => void) => () => void;
  onPeek: (id: string, el: HTMLElement | null) => void;
  hide: () => void;
  hold: () => void;
  release: () => void;
}

function createSessionPeekController(initialDelay: number): SessionPeekController & {
  setDelay: (next: number) => void;
  dispose: () => void;
} {
  let delay = initialDelay;
  let value: SessionPeekPos | null = null;
  let timer: number | undefined;
  const listeners = new Set<() => void>();
  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const setValue = (next: SessionPeekPos | null) => {
    if (
      value === next ||
      (value && next && value.id === next.id && value.top === next.top && value.left === next.left)
    ) {
      return;
    }
    value = next;
    emit();
  };
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPeek: (id, el) => {
      clear();
      if (!el) {
        // 稍等再收：鼠标从行移到右边的卡片上（中间隔着一点缝）时卡片不消失，可以在卡片里改标题
        timer = window.setTimeout(() => setValue(null), HIDE_DELAY);
        return;
      }
      const show = () => {
        const r = el.getBoundingClientRect();
        setValue({ id, top: r.top + r.height / 2, left: r.right + 8 });
      };
      if (delay <= 0) show();
      else timer = window.setTimeout(show, delay);
    },
    hide: () => {
      clear();
      setValue(null);
    },
    hold: () => clear(),
    release: () => {
      clear();
      timer = window.setTimeout(() => setValue(null), HIDE_DELAY);
    },
    setDelay: (next) => {
      delay = next;
    },
    dispose: () => clear(),
  };
}

/** 外部订阅版会话悬停控制器：悬停变化不触发 Sidebar 顶层重渲染 */
export function useSessionPeekController(delay: number): SessionPeekController {
  const [ctrl] = useState(() => createSessionPeekController(delay));
  useEffect(() => {
    ctrl.setDelay(delay);
  }, [ctrl, delay]);
  useEffect(() => () => ctrl.dispose(), [ctrl]);
  return ctrl;
}

export function useSessionPeekValue(ctrl: SessionPeekController): SessionPeekPos | null {
  return useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot, () => null);
}

/**
 * 卡片的显示状态。delay：悬停多久才弹出（毫秒）；收起态的方块立刻弹，列表行稍等一下，
 * 免得鼠标划过整列时卡片一路闪。
 */
export function useSessionPeek(delay: number) {
  const ctrl = useSessionPeekController(delay);
  const peek = useSessionPeekValue(ctrl);
  return { peek, onPeek: ctrl.onPeek, hide: ctrl.hide, hold: ctrl.hold, release: ctrl.release };
}

export const SessionPeek: React.FC<{
  c: Meta;
  tab: HarnessTabMeta | undefined;
  /** Nomi 对话正在回复（没有标签，状态从 AiChat 的 busyConvos 来） */
  running?: boolean;
  /** 刚跑完一轮、还没点进去看 */
  done?: boolean;
  /** 最近一轮结束的结果（done / error / stopped） */
  outcome?: ConvoOutcome;
  top: number;
  left: number;
  testId?: string;
  /** 给了就可以在卡片里点标题改名（Enter 保存、Esc 取消、点别处保存） */
  onRename?: (id: string, name: string | null) => void;
  onHold?: () => void;
  onRelease?: () => void;
}> = ({
  c,
  tab,
  running,
  done,
  outcome,
  top,
  left,
  testId = 'session-peek',
  onRename,
  onHold,
  onRelease,
}) => {
  useLocale();
  const [editing, setEditing] = useState(false);
  const status = sessionStatus(tab, running, done, outcome);
  const place = sessionPlace(c, tab);
  const name = sessionName(c);
  const commit = (v: string | null) => {
    setEditing(false);
    onRename?.(c.id, v?.trim() || null);
    onRelease?.();
  };
  return createPortal(
    <div
      className={rail.peek}
      style={{ top, left }}
      role={onRename ? 'dialog' : 'tooltip'}
      aria-label={onRename ? name : undefined}
      data-interactive={onRename ? true : undefined}
      data-testid={testId}
      data-conversation-id={c.id}
      onMouseEnter={onHold}
      onMouseLeave={editing ? undefined : onRelease}
    >
      <span className={rail.peekHead}>
        {editing ? (
          <input
            className={rail.peekInput}
            defaultValue={name}
            maxLength={60}
            autoFocus
            aria-label={t('ui.cli-monitor.rename')}
            data-testid="session-peek-rename-input"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (isImeComposing(e.nativeEvent)) return;
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') {
                setEditing(false);
                onRelease?.();
              }
            }}
          />
        ) : onRename ? (
          <button
            type="button"
            className={`${rail.peekTitle} ${rail.peekTitleBtn}`}
            onClick={() => setEditing(true)}
            data-testid="session-peek-title"
          >
            {name}
          </button>
        ) : (
          <span className={rail.peekTitle}>{name}</span>
        )}
        <span className={rail.peekIcon} role="img" aria-label={t(ENDPOINT_NAME[c.backend])}>
          <EndpointIcon backend={c.backend} size={14} variant="color" decorative />
        </span>
        <span className={rail.peekTime}>{rel(c.updatedAt)}</span>
      </span>
      {status && <span className={rail.peekMeta}>{status}</span>}
      {tab?.delegation?.by === 'nomi' && (
        <span className={rail.peekMeta} data-testid="session-peek-delegated">
          {t('ui.cli-monitor.delegated-by-nomi', brand.appName, t(ENDPOINT_NAME[c.backend]))}
        </span>
      )}
      {place.label && (
        <span className={rail.peekCwd} title={place.title} data-testid="session-peek-cwd">
          <Icon icon={Folder} size={14} />
          <span className={rail.peekCwdName}>{place.label}</span>
        </span>
      )}
    </div>,
    document.body,
  );
};
