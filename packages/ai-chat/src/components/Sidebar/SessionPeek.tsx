/**
 * 会话详情小卡片：悬停 / 键盘聚焦侧栏里的会话时在右侧弹出。
 * 第一行标题 + 端点图标 + 多久前，第二行状态，第三行工作区（目录名，完整路径在 title 里）。
 * 挂到 body 上用 fixed 定位，不会被侧栏裁掉；不接收鼠标事件，不挡操作。
 */
import { brand } from '@nomi-ai/types';
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Folder } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  unread: 'ui.mascot-theme.new-result',
  error: 'ui.chat-settings.error',
  background: 'ui.chat-settings.running-in-background',
  dormant: 'ui.cli-monitor.dormant',
};

export const sessionName = (c: Meta) => (c.name ? t(c.name) : t('ui.chat-settings.new-chat'));

export const sessionStatus = (tab: HarnessTabMeta | undefined, running?: boolean): string => {
  const key = LIVE_LABEL[rowLive(tab, running)];
  return key ? t(key) : '';
};

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

const HIDE_DELAY = 180;

interface PeekPos {
  id: string;
  top: number;
  left: number;
}

/**
 * 卡片的显示状态。delay：悬停多久才弹出（毫秒）；收起态的方块立刻弹，列表行稍等一下，
 * 免得鼠标划过整列时卡片一路闪。
 */
export function useSessionPeek(delay: number) {
  const [peek, setPeek] = useState<PeekPos | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const onPeek = useCallback(
    (id: string, el: HTMLElement | null) => {
      clear();
      if (!el) {
        // 稍等再收：鼠标从行移到右边的卡片上（中间隔着一点缝）时卡片不消失，可以在卡片里改标题
        timer.current = window.setTimeout(() => setPeek(null), HIDE_DELAY);
        return;
      }
      const show = () => {
        const r = el.getBoundingClientRect();
        setPeek({ id, top: r.top + r.height / 2, left: r.right + 8 });
      };
      if (delay <= 0) show();
      else timer.current = window.setTimeout(show, delay);
    },
    [delay],
  );
  const hide = useCallback(() => {
    clear();
    setPeek(null);
  }, []);
  /** 鼠标进了卡片：别收 */
  const hold = useCallback(() => clear(), []);
  /** 鼠标离开卡片：稍等再收 */
  const release = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setPeek(null), HIDE_DELAY);
  }, []);
  useEffect(() => clear, []);
  return { peek, onPeek, hide, hold, release };
}

export const SessionPeek: React.FC<{
  c: Meta;
  tab: HarnessTabMeta | undefined;
  /** Nomi 对话正在回复（没有标签，状态从 AiChat 的 busyConvos 来） */
  running?: boolean;
  top: number;
  left: number;
  testId?: string;
  /** 给了就可以在卡片里点标题改名（Enter 保存、Esc 取消、点别处保存） */
  onRename?: (id: string, name: string | null) => void;
  onHold?: () => void;
  onRelease?: () => void;
}> = ({ c, tab, running, top, left, testId = 'session-peek', onRename, onHold, onRelease }) => {
  useLocale();
  const [editing, setEditing] = useState(false);
  const status = sessionStatus(tab, running);
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
          <EndpointIcon backend={c.backend} size={14} decorative />
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
