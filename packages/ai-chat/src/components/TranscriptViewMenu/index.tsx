/**
 * 会话的 Transcript view 菜单：Normal / Thinking / Verbose。
 * 选择只作用于当前会话（sessionKey），由 useTranscriptView 持久化；不改变其它会话。
 */
import { Icon, t, useLocale, usePresence } from '@nomi-ai/ui';
import { Check, Eye } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranscriptView } from '../../hooks/useTranscriptView';
import { TRANSCRIPT_VIEWS, type TranscriptView } from '../../services/transcriptView';
import { titlebarMenuTop } from '../../utils/titlebarMenu';

import styles from './index.module.css';
import { TRANSCRIPT_VIEW_DESC_KEY, TRANSCRIPT_VIEW_LABEL_KEY } from './labels';

const MENU_WIDTH = 300;
const MENU_EST_HEIGHT = 54 + (TRANSCRIPT_VIEWS.length + 1) * 58;

export const TranscriptViewButton: React.FC<{ sessionKey: string }> = ({ sessionKey }) => {
  // 语言切换时重渲染：标题栏是 memo 的，这里自己订阅
  useLocale();
  const { view, globalView, hasOverride, setView, followGlobal } = useTranscriptView(sessionKey);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // 菜单收起时先放完淡出动画再卸载
  const atP = usePresence(at);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setAt(null), []);

  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(4, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 4));
    const below = titlebarMenuTop(r);
    const top =
      below + MENU_EST_HEIGHT > window.innerHeight
        ? Math.max(4, r.top - MENU_EST_HEIGHT - 4)
        : below;
    setAt({ left, top });
  };

  useEffect(() => {
    if (!at) return;
    menu.current
      ?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
      ?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !btn.current?.contains(target)) close();
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [at, close]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i + items.length - 1) % items.length;
    items[to]?.focus();
    e.preventDefault();
  };

  /** 选完关菜单。键盘操作（Enter / 空格，detail 为 0）才把焦点还给按钮；鼠标点选不留焦点框 */
  const done = (e: React.MouseEvent) => {
    close();
    if (e.detail === 0) btn.current?.focus();
  };
  const pick = (next: TranscriptView, e: React.MouseEvent) => {
    setView(next);
    done(e);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="app-titlebar-btn"
        aria-label={t('ui.chat-settings.transcript-view')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        data-testid="titlebar-transcript-view"
        data-override={hasOverride || undefined}
        onClick={() => (at ? close() : open())}
      >
        <Icon icon={Eye} size={16} />
      </button>
      {atP.value && (
        <div
          ref={menu}
          role="menu"
          aria-label={t('ui.chat-settings.transcript-view')}
          className={`${styles.menu} cd-motion-pop`}
          data-closing={atP.closing || undefined}
          style={{ left: atP.value.left, top: atP.value.top, width: MENU_WIDTH }}
          data-testid="transcript-view-menu"
          onKeyDown={onMenuKey}
        >
          <div className={styles.title}>{t('ui.chat-settings.transcript-view')}</div>
          {TRANSCRIPT_VIEWS.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={view === id}
              className={styles.item}
              data-testid={`transcript-view-${id}`}
              onClick={(e) => pick(id, e)}
            >
              <span className={styles.check} aria-hidden="true">
                {view === id && <Icon icon={Check} size={14} />}
              </span>
              <span className={styles.copy}>
                <span className={styles.label}>{t(TRANSCRIPT_VIEW_LABEL_KEY[id])}</span>
                <span className={styles.desc}>{t(TRANSCRIPT_VIEW_DESC_KEY[id])}</span>
              </span>
            </button>
          ))}
          <div className={styles.sep} role="separator" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!hasOverride}
            className={styles.item}
            data-testid="transcript-view-global"
            onClick={(e) => {
              followGlobal();
              done(e);
            }}
          >
            <span className={styles.check} aria-hidden="true">
              {!hasOverride && <Icon icon={Check} size={14} />}
            </span>
            <span className={styles.copy}>
              <span className={styles.label}>
                {t('ui.chat-settings.transcript-view-use-global')}
              </span>
              <span className={styles.desc}>
                {t(
                  'ui.chat-settings.transcript-view-use-global-desc',
                  t(TRANSCRIPT_VIEW_LABEL_KEY[globalView]),
                )}
              </span>
            </span>
          </button>
        </div>
      )}
    </>
  );
};
