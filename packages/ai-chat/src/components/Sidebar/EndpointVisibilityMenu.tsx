/**
 * 侧栏端点的显示设置：每个编程助手端点选 自动 / 显示 / 隐藏，并可拖拽（或 Alt+↑/↓）调整顺序。
 * 自动（默认）= 有对话、标签或磁盘历史时才显示，为 0 时不占位置。Nomi 总是显示且固定在最前，不在这里列出。
 * 没有自定义顺序时按对话数从多到少排列；「按对话数排序」恢复自动。
 */
import { Icon, t } from '@nomi-ai/ui';
import { GripVertical, SlidersHorizontal } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { EndpointVisibility, EndpointVisibilityMap } from '../../services/chatPrefs';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

const OPTIONS: Array<{ value: EndpointVisibility; label: () => string }> = [
  { value: 'auto', label: () => t('ui.foundation.auto') },
  { value: 'show', label: () => t('ui.chat-settings.show') },
  { value: 'hide', label: () => t('ui.chat-settings.hide') },
];

export const EndpointVisibilityMenu: React.FC<{
  backends: readonly ConversationBackend[];
  visibility: EndpointVisibilityMap;
  activity: Partial<Record<ConversationBackend, number>>;
  onChange: (b: ConversationBackend, v: EndpointVisibility) => void;
  /** 当前是否为自定义顺序（否则按对话数） */
  customOrder?: boolean;
  /** 新的编程助手端点顺序；null = 恢复按对话数排序 */
  onReorder?: (order: ConversationBackend[] | null) => void;
}> = ({ backends, visibility, activity, onChange, customOrder = false, onReorder }) => {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<ConversationBackend | null>(null);
  const [live, setLive] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  const cli: ConversationBackend[] = backends.filter((b) => b !== 'nomi');
  const move = (from: number, to: number) => {
    if (!onReorder || to < 0 || to >= cli.length || from === to) return;
    const next = [...cli];
    const [b] = next.splice(from, 1);
    next.splice(to, 0, b!);
    onReorder(next);
    setLive(t('ui.chat-settings.moved-to-position', ENDPOINT_FULL[b!](), to + 1));
  };

  return (
    <div className={styles.epVisWrap} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={styles.epChip}
        aria-label={t('ui.chat-settings.choose-which-endpoints-show-in-the-sidebar')}
        title={t('ui.chat-settings.choose-which-endpoints-show-in-the-sidebar')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="endpoint-visibility"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={SlidersHorizontal} size={14} />
      </button>
      {open && (
        <div
          className={styles.epVisMenu}
          role="dialog"
          aria-label={t('ui.chat-settings.endpoints-shown-in-the-sidebar')}
          data-testid="endpoint-visibility-menu"
        >
          <p className={styles.epVisHint}>
            {t('ui.chat-settings.auto-shown-only-when-it-has-conversations-drag')}
          </p>
          {onReorder && (
            <div className={styles.epVisOrder}>
              <span>
                {customOrder
                  ? t('ui.chat-settings.custom-order')
                  : t('ui.chat-settings.sorted-by-conversation-count')}
              </span>
              {customOrder && (
                <button
                  type="button"
                  className={styles.epVisReset}
                  data-testid="endpoint-order-reset"
                  onClick={() => {
                    onReorder(null);
                    setLive(t('ui.chat-settings.sorted-by-conversation-count-again'));
                  }}
                >
                  {t('ui.chat-settings.sort-by-conversation-count')}
                </button>
              )}
            </div>
          )}
          {cli.map((b, i) => {
            const cur: EndpointVisibility = visibility[b] ?? 'auto';
            const name = ENDPOINT_FULL[b]();
            return (
              <div
                key={b}
                className={styles.epVisRow}
                data-dragging={dragging === b || undefined}
                data-testid={`endpoint-order-${b}`}
                draggable={Boolean(onReorder)}
                onDragStart={(e) => {
                  setDragging(b);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', b);
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) move(cli.indexOf(dragging), i);
                  setDragging(null);
                }}
              >
                {onReorder && (
                  <button
                    type="button"
                    className={styles.epVisGrip}
                    aria-label={t('ui.chat-settings.position-alt-to-reorder', name, i + 1)}
                    title={t('ui.chat-settings.drag-to-reorder')}
                    data-testid={`endpoint-order-grip-${b}`}
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                      e.preventDefault();
                      move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
                    }}
                  >
                    <Icon icon={GripVertical} size={14} />
                  </button>
                )}
                <span className={styles.epVisName} title={name}>
                  <EndpointIcon backend={b} size={14} decorative />
                  <span className={styles.epVisLabel}>{name}</span>
                  <span className={styles.epCount}>{activity[b] ?? 0}</span>
                </span>
                <div
                  className={styles.seg}
                  role="radiogroup"
                  aria-label={t('ui.chat-settings.how-is-shown', name)}
                >
                  {OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={cur === o.value}
                      className={styles.segBtn}
                      data-testid={`endpoint-visibility-${b}-${o.value}`}
                      onClick={() => onChange(b, o.value)}
                    >
                      {o.label()}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <span className={styles.srOnly} aria-live="polite">
            {live}
          </span>
        </div>
      )}
    </div>
  );
};
