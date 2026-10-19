/**
 * 标签栏右侧的并发控件：平时只是一个小芯片「0/3」（排队时加「· 排队 N」），
 * 点开是应用自己的弹层：一句说明 + 1–8 的按钮选上限。不用原生 <select>：
 * 系统下拉的样式跟不上应用主题（深色主题下是一块浅灰菜单）。
 */
import { Icon, t } from '@nomi-ai/ui';
import { Gauge } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './index.module.css';

const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8];

export const ConcurrencyControl: React.FC<{
  running: number;
  queued: number;
  max: number;
  onChange: (n: number) => void;
}> = ({ running, queued, max, onChange }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({});

  // 弹层挂到 body、fixed 定位、与按钮右缘对齐：标签栏贴着窗口右边，挂在里面会被裁掉
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        setOpen(false);
        btnRef.current?.focus();
        return;
      }
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.load}
        data-testid="chat-tabs-load"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('同时运行 {0} 个，最多 {1} 个', running, max)}
        title={t('同时运行 / 最多同时运行的编程助手标签数')}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={Gauge} size={13} />
        <span>
          {running}/{max}
        </span>
        {queued ? <span className={styles.loadQueued}>{t('· 排队 {0}', queued)}</span> : null}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={styles.loadPop}
            style={pos}
            role="dialog"
            aria-label={t('同时运行的标签数')}
            data-testid="chat-tabs-load-pop"
          >
            <div className={styles.loadTitle}>{t('最多同时运行')}</div>
            <div
              className={styles.loadGrid}
              role="radiogroup"
              aria-label={t('最多同时运行的编程助手标签数')}
            >
              {LIMITS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={n === max}
                  className={styles.loadOpt}
                  data-testid={`chat-tabs-max-${n}`}
                  onClick={() => {
                    onChange(n);
                    setOpen(false);
                    btnRef.current?.focus();
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className={styles.loadHint}>{t('超出的消息会排队，前面的跑完后自动开始。')}</p>
            <p className={styles.loadNow}>
              {queued
                ? t('现在：运行 {0} 个，排队 {1} 个', running, queued)
                : t('现在：运行 {0} 个', running)}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
};
