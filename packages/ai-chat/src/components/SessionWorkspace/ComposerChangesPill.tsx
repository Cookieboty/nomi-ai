/** Composer 附近「N 个文件已更改 +x −y」pill；悬停延迟防抖 + body portal 浮层，点击文件或 pill 打开并排 Diff 工作台。
 * 文件清单弹层 portal 到 body：留在会话卡片里会被卡片的 overflow: clip 裁掉，
 * 也跳不出卡片的层叠上下文（卡片 z-index: 1，低于左侧会话栏的 3）。 */
import { t } from '@nomi-ai/ui';
import { IconFileDiff as FileDiff } from '@tabler/icons-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ConvMessage } from '../../types/conversation';
import {
  aggregateSessionChanges,
  splitPathDisplay,
  summarizeChanges,
} from '../../utils/sessionChanges';

import { useChangesUi } from './ChangesUiContext';
import styles from './SessionWorkspace.module.css';

const POPOVER_CLOSE_DELAY_MS = 180;

export const ComposerChangesPill: React.FC<{
  messages: readonly ConvMessage[];
}> = ({ messages }) => {
  const { openWorkbench } = useChangesUi();
  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const summary = useMemo(() => summarizeChanges(changes), [changes]);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );
  const wrap = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const handleOpen = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const handleCloseImmediate = useCallback(() => {
    cancelClose();
    setOpen(false);
    setPosition(null);
  }, [cancelClose]);

  const handleScheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setPosition(null);
    }, POPOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  const handleSelectFile = useCallback(
    (file?: string) => {
      handleCloseImmediate();
      openWorkbench({
        entries: changes,
        file,
        sourceLabel: t('ui.providers-schedule.all'),
      });
    },
    [changes, handleCloseImmediate, openWorkbench],
  );

  // 以 pill 为锚点向上展开；水平居中后夹进视口，上方放不下时翻到下方且夹紧上下边界
  const place = useCallback(() => {
    const anchor = wrap.current;
    const panel = popover.current;
    if (!anchor || !panel) return;
    const margin = 12;
    const gap = 8;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(0, Math.min(560, window.innerWidth - margin * 2));
    const height = panel.offsetHeight;
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - width / 2),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const above = rect.top - gap - height;
    const below = rect.bottom + gap;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const top = above >= margin ? above : Math.max(margin, Math.min(below, maxTop));
    setPosition({ left, top, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(place);
      if (wrap.current) observer.observe(wrap.current);
      if (popover.current) observer.observe(popover.current);
    }
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer?.disconnect();
    };
  }, [open, place, changes.length]);

  // 弹层展开后：点击外部收起（触屏无 hover），以及全局 Esc 收起（悬停打开时焦点未必在 wrap 内）
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (wrap.current?.contains(target) || popover.current?.contains(target)) return;
      handleCloseImmediate();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      handleCloseImmediate();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, handleCloseImmediate]);

  if (!summary.files) return null;

  const inside = (target: EventTarget | null) =>
    target instanceof Node &&
    (!!wrap.current?.contains(target) || !!popover.current?.contains(target));

  return (
    <div
      ref={wrap}
      className={styles.composerChangesWrap}
      data-open={open ? 'true' : undefined}
      onMouseEnter={handleOpen}
      onMouseLeave={handleScheduleClose}
      onFocus={handleOpen}
      onBlur={(event) => {
        if (!inside(event.relatedTarget)) handleCloseImmediate();
      }}
    >
      <button
        type="button"
        className={styles.composerChangesPill}
        data-testid="composer-changes-pill"
        onClick={() => handleSelectFile(changes[0]?.file)}
      >
        <FileDiff size={12} aria-hidden />
        <span>
          {t('ui.session-workspace.files-changed-count', summary.files)}{' '}
          <span className={styles.add}>+{summary.added}</span>{' '}
          <span className={styles.del}>−{summary.removed}</span>
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popover}
            className={styles.composerChangesPopover}
            role="region"
            data-testid="composer-changes-popover"
            aria-label={t('ui.session-workspace.view-changes')}
            onMouseEnter={handleOpen}
            onMouseLeave={handleScheduleClose}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              width: position?.width,
              visibility: position ? 'visible' : 'hidden',
            }}
          >
            {changes.map((change) => {
              const { dir, name } = splitPathDisplay(change.file);
              return (
                <button
                  type="button"
                  key={change.file}
                  className={styles.composerChangeFile}
                  data-testid="composer-change-file"
                  data-file={change.file}
                  onClick={() => handleSelectFile(change.file)}
                >
                  <span className={styles.composerChangePath} title={change.file}>
                    <span className={styles.composerChangeName}>{name}</span>
                    {dir ? <span className={styles.composerChangeDir}>{dir}</span> : null}
                  </span>
                  <span className={styles.composerChangeStats}>
                    <span className={styles.add}>+{change.added}</span>
                    <span className={styles.del}>−{change.removed}</span>
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
};
