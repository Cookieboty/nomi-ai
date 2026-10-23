/**
 * 侧栏端点筛选行的「更多」：一次只直接显示前几个端点，其余放在这里（名称 + 对话数），点一下即切换。
 * 弹层以整行为锚（与端点显示设置相同），侧栏 overflow: hidden 时不会被裁掉右侧。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useRef, useState } from 'react';

import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './index.module.css';

export const EndpointMoreMenu: React.FC<{
  backends: readonly ConversationBackend[];
  activity: Partial<Record<ConversationBackend, number>>;
  isDisabled: (b: ConversationBackend) => boolean;
  onPick: (b: ConversationBackend) => void;
}> = ({ backends, activity, isDisabled, onPick }) => {
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

  const label = t('更多端点（{0}）', backends.length);
  return (
    <div className={styles.epMoreWrap} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.epChip} ${styles.epMoreBtn}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="endpoint-filter-more"
        onClick={() => setOpen((o) => !o)}
      >
        +{backends.length}
      </button>
      {open && (
        <div className={styles.epMoreMenu} role="menu" data-testid="endpoint-more-menu">
          {backends.map((b) => (
            <button
              key={b}
              type="button"
              role="menuitem"
              className={styles.epMoreItem}
              disabled={isDisabled(b)}
              data-testid={`endpoint-more-${b}`}
              onClick={() => {
                setOpen(false);
                onPick(b);
              }}
            >
              <EndpointIcon backend={b} size={14} decorative />
              <span className={styles.epVisLabel}>{ENDPOINT_FULL[b]()}</span>
              <span className={styles.epCount}>{activity[b] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
