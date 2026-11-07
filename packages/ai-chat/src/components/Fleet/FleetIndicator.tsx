import { Button, Icon, t } from '@nomi-ai/ui';
import { Activity } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatBytes, formatCpu, summarize, type FleetState } from '../../services/fleetClient';

import { agentTitle, UsageLine } from './AgentCard';
import styles from './Fleet.module.css';

/** 浮层里最多列几个正在跑的 */
const POPOVER_MAX = 6;
const GAP = 6;
const EDGE = 8;

/**
 * 标题栏右侧的负载指示：「在跑的数量 · 占用」，负载高时变色；点开是小浮层，列出正在跑的与要你处理的，
 * 底部进完整看板。浮层挂到 body 上（标题栏整条可拖动，放在原地点不到），贴在按钮下方右对齐。
 */
export const FleetIndicator: React.FC<{
  state: FleetState | null;
  onOpenBoard: () => void;
  /** 浮层开关（开着时宿主加快刷新） */
  onOpenChange: (open: boolean) => void;
  chatName?: (conversationId: string) => string;
}> = ({ state, onOpenBoard, onOpenChange, chatName }) => {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const sum = summarize(state);

  const setOpenBoth = (v: boolean) => {
    setOpen(v);
    onOpenChange(v);
  };

  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const a = btn.current.getBoundingClientRect();
    const w = pop.current.offsetWidth;
    const left = Math.max(EDGE, Math.min(a.right - w, window.innerWidth - EDGE - w));
    setPos({ left, top: a.bottom + GAP });
  }, [open, state]);

  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      onOpenChange(false);
      btn.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (pop.current?.contains(n) || btn.current?.contains(n)) return;
      setOpen(false);
      onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, onOpenChange]);

  if (!state) return null;
  const total = sum.managedBytes + sum.externalBytes;
  const cpu = formatCpu(state.system.cpuPercent);
  const label = t('ui.cli-monitor.fleet-indicator', sum.running, formatBytes(total), cpu);
  const running = state.agents
    .filter((a) => a.column === 'running' || a.needsYou)
    .sort((a, b) => (b.usage?.rssBytes ?? 0) - (a.usage?.rssBytes ?? 0));

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={styles.indicator}
        data-level={sum.level}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpenBoth(!open)}
        data-testid="fleet-indicator"
      >
        <Icon icon={Activity} size={14} />
        <span className={styles.indicatorText}>
          {sum.running} · {formatBytes(total)} · {t('ui.cli-monitor.fleet-cpu', cpu)}
        </span>
        {sum.needsYou > 0 && <span className={styles.indicatorDot} aria-hidden />}
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label={t('ui.cli-monitor.fleet-board')}
            className={styles.popover}
            style={{ position: 'fixed', ...pos }}
            data-testid="fleet-popover"
          >
            <p className={styles.popoverHead}>{t('ui.chat-settings.in-progress')}</p>
            {running.length ? (
              <ul className={styles.popoverList}>
                {running.slice(0, POPOVER_MAX).map((a) => (
                  <li key={a.id} className={styles.popoverItem}>
                    <span className={styles.popoverTitle}>{agentTitle(a, chatName)}</span>
                    <UsageLine a={a} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>{t('ui.cli-monitor.fleet-none-running')}</p>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpenBoth(false);
                onOpenBoard();
              }}
              data-testid="fleet-popover-open-board"
            >
              {t('ui.cli-monitor.fleet-open-board')}
            </Button>
          </div>,
          document.body,
        )}
    </>
  );
};
