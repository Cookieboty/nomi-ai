import { Icon, t, useLocale } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  PanelTopClose,
  PanelTopOpen,
  GitFork,
  Grip,
  MessagesSquare,
  Minimize2,
  Search,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import type { ResourceScope } from '../../contexts/ResourceContext';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { isImeComposing } from '../../utils/keyboard';
import { NomiMark } from '../SettingsView/NomiMark';

import { PREVIEW_CHAT_DISMISS } from './dismiss';
import styles from './index.module.css';
import { usePreviewChatSessions } from './usePreviewChatSessions';

type Sessions = ReturnType<typeof usePreviewChatSessions>;
export function PreviewChatHeader({
  expanded,
  onToggle,
  onMinimize,
  onDrag,
  onMoveKey,
  onExpand,
  sessions,
}: {
  expanded: boolean;
  onToggle: () => void;
  onMinimize: () => void;
  onDrag: React.PointerEventHandler<HTMLButtonElement>;
  onMoveKey: React.KeyboardEventHandler<HTMLButtonElement>;
  onExpand: () => void;
  sessions: Sessions;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const headerRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const button = trigger.current.getBoundingClientRect();
    const { height, width } = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(button.left, window.innerWidth - width - 8)),
      top: Math.max(8, button.top - height - 8),
    });
    search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    const header = headerRef.current;
    const dismiss = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    header?.addEventListener(PREVIEW_CHAT_DISMISS, dismiss);
    window.addEventListener('pointerdown', down);
    window.addEventListener('resize', resize);
    return () => {
      header?.removeEventListener(PREVIEW_CHAT_DISMISS, dismiss);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const shown = sessions.sessions.filter((item) =>
    `${item.name} ${ENDPOINT_NAME[item.backend]}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const choose = async (operation: () => Promise<boolean>) => {
    close(true);
    if (await operation()) onExpand();
  };
  return (
    <div
      ref={headerRef}
      className={styles.header}
      data-testid="preview-chat-header"
      data-preview-chat-header
    >
      <button
        type="button"
        className={`${styles.icon} ${styles.toggle}`}
        data-testid="preview-chat-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={t(
          expanded
            ? 'ui.session-workspace.preview-chat-collapse'
            : 'ui.session-workspace.preview-chat-expand',
        )}
      >
        <Icon icon={expanded ? PanelTopClose : PanelTopOpen} size={16} />
        <span>
          {t(
            expanded
              ? 'ui.session-workspace.preview-chat-collapse'
              : 'ui.session-workspace.preview-chat-expand',
          )}
        </span>
      </button>
      <button
        type="button"
        ref={trigger}
        className={styles.select}
        disabled={sessions.busy}
        data-testid="preview-chat-select"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('ui.session-workspace.preview-chat-select')}
        title={sessions.title}
        onClick={() => {
          setQuery('');
          setOpen(!open);
        }}
      >
        <Icon icon={MessagesSquare} size={14} />
        <span>{sessions.title}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      <button
        type="button"
        className={styles.icon}
        data-testid="preview-chat-minimize"
        onClick={onMinimize}
        aria-label={t('ui.session-workspace.preview-chat-minimize')}
        title={t('ui.session-workspace.preview-chat-minimize')}
      >
        <Icon icon={Minimize2} size={16} />
      </button>
      <button
        type="button"
        className={`${styles.icon} ${styles.grip}`}
        onPointerDown={onDrag}
        data-testid="preview-chat-drag"
        aria-label={t('ui.session-workspace.preview-chat-move')}
        title={t('ui.session-workspace.preview-chat-move')}
        onKeyDown={onMoveKey}
      >
        <Icon icon={Grip} size={16} />
      </button>
      {sessions.error && (
        <div className={styles.error} role="alert">
          {sessions.error}
        </div>
      )}
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className={styles.menu}
            style={position}
            aria-label={t('ui.session-workspace.preview-chat-select')}
            data-testid="preview-chat-menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (isImeComposing(event.nativeEvent)) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.repeat) return;
                close(true);
                return;
              }
              if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              const options = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>(
                  'button[role="menuitemradio"], button[role="menuitem"]',
                ) ?? [],
              ).filter((button) => !button.disabled);
              if (!options.length) return;
              event.preventDefault();
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? options.length - 1
                    : index < 0
                      ? event.key === 'ArrowUp'
                        ? options.length - 1
                        : 0
                      : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) %
                        options.length;
              options[next]?.focus();
            }}
          >
            <label className={styles.search}>
              <Icon icon={Search} size={14} />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('ui.cli-monitor.search-conversations-ellipsis')}
                aria-label={t('ui.cli-monitor.search-conversations-ellipsis')}
              />
            </label>
            <div className={styles.list}>
              {shown.map((item) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === sessions.currentId}
                  className={styles.item}
                  key={item.id}
                  data-conversation-id={item.id}
                  disabled={sessions.busy}
                  onClick={() => void choose(() => sessions.choose(item))}
                >
                  <Icon icon={MessagesSquare} size={14} />
                  <span>
                    {item.name}
                    <small>{ENDPOINT_NAME[item.backend]}</small>
                  </span>
                  {item.id === sessions.currentId && <Icon icon={Check} size={14} />}
                </button>
              ))}
              {!shown.length && (
                <p className={styles.empty}>{t('ui.cli-monitor.no-matching-conversations')}</p>
              )}
            </div>
            <button
              type="button"
              role="menuitem"
              data-testid="preview-chat-fork"
              className={`${styles.item} ${styles.fork}`}
              disabled={sessions.busy || !sessions.canFork}
              onClick={() => void choose(sessions.fork)}
            >
              <Icon icon={GitFork} size={14} />
              <span>{t('ui.session-workspace.preview-chat-fork')}</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Keep list subscriptions local: background tabs never rerender the main chat tree. */
export function PreviewChat(
  props: Omit<React.ComponentProps<typeof PreviewChatHeader>, 'sessions'> & {
    onSelected: (scope: ResourceScope) => void;
    onBusy: (busy: boolean) => void;
    workspaceCwd: string | null | undefined;
    /** 收成右下角的按钮（输入框与会话照样挂着，只是藏起来） */
    minimized: boolean;
    onOpen: () => void;
  },
) {
  const { onSelected, onBusy, workspaceCwd, minimized, onOpen, ...header } = props;
  const sessions = usePreviewChatSessions(true, onSelected, workspaceCwd);
  useEffect(() => {
    onBusy(sessions.busy);
  }, [sessions.busy, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  if (minimized)
    return (
      <button
        type="button"
        className={styles.pill}
        data-preview-chat-pill
        data-testid="preview-chat-pill"
        onClick={onOpen}
        aria-label={t('ui.chat-settings.chats')}
        title={sessions.title || t('ui.chat-settings.chats')}
      >
        <NomiMark size={26} />
      </button>
    );
  return <PreviewChatHeader {...header} sessions={sessions} />;
}
