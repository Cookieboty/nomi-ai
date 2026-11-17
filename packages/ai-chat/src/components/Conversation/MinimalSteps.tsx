/** 极简模式下的过程步骤折叠区：运行中与完成后均呈现圆角横条，展开后在限高区域内局部滚动查看步骤与过程 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { IconChevronRight as ChevronRight } from '@tabler/icons-react';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { StatusInfo } from '../../utils/convStatus';
import { formatWorkedDuration, type MinimalCollapsedSegment } from '../../utils/minimalTurn';

import styles from './index.module.css';
import { Markdown } from './Markdown';
import { isWarnStatus, StatusLineContent } from './StatusLine';
import { ToolTimeline } from './ToolTimeline';
import { TranscriptViewProvider } from './transcriptViewContext';

/** 局部滚到底容差 */
const STICK_PX = 24;

interface MinimalOpenStore {
  get: (key: string) => boolean | undefined;
  toggle: (key: string, fallback: boolean) => boolean;
  subscribe: (fn: () => void) => () => void;
}

function createMinimalOpenStore(): MinimalOpenStore {
  const map = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  return {
    get: (key) => map.get(key),
    toggle: (key, fallback) => {
      const next = !(map.get(key) ?? fallback);
      map.set(key, next);
      for (const fn of listeners) fn();
      return next;
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

const MinimalOpenContext = createContext<MinimalOpenStore | null>(null);

/** 会话级极简展开状态存储：让运行中（live）切到定稿（AssistantMessage）时保持用户展开态，不跨会话污染 */
export const MinimalOpenProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [store] = useState(createMinimalOpenStore);
  return <MinimalOpenContext.Provider value={store}>{children}</MinimalOpenContext.Provider>;
};

export interface MinimalLiveStatus {
  status: StatusInfo;
  startedAt?: number;
}

export const MinimalSteps: React.FC<{
  segments: readonly MinimalCollapsedSegment[];
  stepCount: number;
  workedMs?: number;
  liveStatus?: MinimalLiveStatus;
  stateKey?: string;
}> = ({ segments, stepCount, workedMs, liveStatus, stateKey }) => {
  useLocale();
  const store = useContext(MinimalOpenContext);
  const [localOpen, setLocalOpen] = useState(false);
  const subscribe = useCallback(
    (fn: () => void) => (store && stateKey ? store.subscribe(fn) : () => undefined),
    [store, stateKey],
  );
  const storedOpen = useSyncExternalStore(
    subscribe,
    () => (store && stateKey ? (store.get(stateKey) ?? false) : false),
    () => false,
  );
  const open = store && stateKey ? storedOpen : localOpen;
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const wasLiveOpenRef = useRef(false);

  const toggleOpen = () => {
    const next = store && stateKey ? store.toggle(stateKey, open) : !open;
    if (!store || !stateKey) setLocalOpen(next);
    if (next && liveStatus) stickRef.current = true;
  };

  useLayoutEffect(() => {
    const isLiveOpen = open && !!liveStatus;
    if (!isLiveOpen) {
      wasLiveOpenRef.current = false;
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    if (!wasLiveOpenRef.current) {
      wasLiveOpenRef.current = true;
      stickRef.current = true;
    }
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, liveStatus, segments, stepCount]);

  useEffect(() => {
    if (!open || !liveStatus || typeof ResizeObserver === 'undefined') return;
    const body = bodyRef.current;
    const inner = innerRef.current;
    if (!body || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) body.scrollTop = body.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [open, liveStatus]);

  const label =
    workedMs !== undefined
      ? t('ui.usage-tools.worked-for-steps', formatWorkedDuration(workedMs), stepCount)
      : t('ui.usage-tools.completed-steps', stepCount);

  let lastTextIdx = -1;
  segments.forEach((seg, i) => {
    if (seg.type === 'text') lastTextIdx = i;
  });

  return (
    <div
      className={styles.minimalSteps}
      data-testid="minimal-steps"
      data-open={open}
      data-no-selection-toolbar=""
    >
      <button
        type="button"
        className={styles.minimalToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="minimal-steps-toggle"
        onClick={toggleOpen}
      >
        {liveStatus ? (
          <span
            className={`${styles.minimalLiveStatus} ${isWarnStatus(liveStatus.status.kind) ? styles.statusWarn : ''}`}
            data-testid="conv-status"
            data-kind={liveStatus.status.kind}
            role="status"
          >
            <StatusLineContent
              status={liveStatus.status}
              startedAt={liveStatus.startedAt}
              stepCount={stepCount}
              minimal
            />
          </span>
        ) : (
          <span className={styles.minimalLabel}>{label}</span>
        )}
        <Icon icon={ChevronRight} size={13} className={styles.minimalChevron} />
      </button>
      {open && (
        <TranscriptViewProvider value="thinking">
          <div
            id={bodyId}
            ref={bodyRef}
            tabIndex={0}
            className={styles.minimalBody}
            data-testid="minimal-steps-body"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
            }}
            onWheel={(e) => {
              const el = e.currentTarget;
              if (el.scrollHeight > el.clientHeight) e.stopPropagation();
            }}
          >
            <div ref={innerRef} className={styles.minimalBodyInner}>
              {segments.map((seg, i) =>
                seg.type === 'text' ? (
                  <div
                    key={`mt-${i}`}
                    className={styles.minimalText}
                    data-testid="minimal-step-text"
                  >
                    <Markdown
                      text={seg.text}
                      settled={!liveStatus || i !== lastTextIdx}
                      streaming={!!liveStatus && i === lastTextIdx}
                    />
                  </div>
                ) : (
                  <ToolTimeline key={`ma-${i}`} items={seg.items} rawOrder hideGeneratedImage />
                ),
              )}
            </div>
          </div>
        </TranscriptViewProvider>
      )}
    </div>
  );
};
