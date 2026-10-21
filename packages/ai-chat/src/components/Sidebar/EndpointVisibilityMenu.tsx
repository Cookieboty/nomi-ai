/**
 * 侧栏「按端」的端点显示设置：每个编程助手端点选 自动 / 显示 / 隐藏。
 * 自动（默认）= 有对话、标签或磁盘历史时才显示，为 0 时不占位置。Nomi 总是显示，不在这里列出。
 */
import { Icon, t } from '@nomi-ai/ui';
import { SlidersHorizontal } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { EndpointVisibility, EndpointVisibilityMap } from '../../services/chatPrefs';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

const OPTIONS: Array<{ value: EndpointVisibility; label: () => string }> = [
  { value: 'auto', label: () => t('自动') },
  { value: 'show', label: () => t('显示') },
  { value: 'hide', label: () => t('隐藏') },
];

export const EndpointVisibilityMenu: React.FC<{
  backends: readonly ConversationBackend[];
  visibility: EndpointVisibilityMap;
  activity: Partial<Record<ConversationBackend, number>>;
  onChange: (b: ConversationBackend, v: EndpointVisibility) => void;
}> = ({ backends, visibility, activity, onChange }) => {
  const [open, setOpen] = useState(false);
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

  const cli = backends.filter((b) => b !== 'nomi');

  return (
    <div className={styles.epVisWrap} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={styles.epChip}
        aria-label={t('选择侧栏显示的端点')}
        title={t('选择侧栏显示的端点')}
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
          aria-label={t('侧栏显示的端点')}
          data-testid="endpoint-visibility-menu"
        >
          <p className={styles.epVisHint}>{t('自动：有对话时才显示，没有对话就不占位置。')}</p>
          {cli.map((b) => {
            const cur: EndpointVisibility = visibility[b] ?? 'auto';
            return (
              <div key={b} className={styles.epVisRow}>
                <span className={styles.epVisName}>
                  <EndpointIcon backend={b} size={14} decorative />
                  {ENDPOINT_FULL[b]()}
                  <span className={styles.epCount}>{activity[b] ?? 0}</span>
                </span>
                <div
                  className={styles.seg}
                  role="radiogroup"
                  aria-label={t('{0} 的显示方式', ENDPOINT_FULL[b]())}
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
        </div>
      )}
    </div>
  );
};
