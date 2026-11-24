/** Composer 附近「N 个文件已更改 +x −y」pill；点击打开并排 Diff 工作台。
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

  // 以 pill 为锚点向上展开；水平居中后夹进视口，上方放不下时翻到下方
  const place = useCallback(() => {
    const anchor = wrap.current;
    const panel = popover.current;
    if (!anchor || !panel) return;
    const margin = 12;
    const gap = 8;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - margin * 2);
    const height = panel.offsetHeight;
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - width / 2),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const above = rect.top - gap - height;
    const top =
      above >= margin ? above : Math.min(rect.bottom + gap, window.innerHeight - height - margin);
    setPosition({ left, top, width });
  }, []);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place, changes.length]);
  // 点击弹层与 pill 之外的任意位置时收起（触屏没有 hover）
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (wrap.current?.contains(target) || popover.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [open]);

  if (!summary.files) return null;

  const inside = (target: EventTarget | null) =>
    target instanceof Node &&
    (!!wrap.current?.contains(target) || !!popover.current?.contains(target));

  return (
    <div
      ref={wrap}
      className={styles.composerChangesWrap}
      onMouseOver={() => setOpen(true)}
      onMouseOut={(event) => {
        if (!inside(event.relatedTarget)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!inside(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.composerChangesPill}
        data-testid="composer-changes-pill"
        onClick={() =>
          openWorkbench({
            entries: changes,
            file: changes[0]?.file,
            sourceLabel: t('ui.providers-schedule.all'),
          })
        }
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
            role="tooltip"
            data-testid="composer-changes-popover"
            aria-label={t('ui.session-workspace.view-changes')}
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
                <div
                  key={change.file}
                  className={styles.composerChangeFile}
                  data-testid="composer-change-file"
                  data-file={change.file}
                  title={change.file}
                >
                  <span className={styles.composerChangePath}>
                    <span className={styles.composerChangeName}>{name}</span>
                    {dir ? <span className={styles.composerChangeDir}>{dir}</span> : null}
                  </span>
                  <span className={styles.composerChangeStats}>
                    <span className={styles.add}>+{change.added}</span>
                    <span className={styles.del}>−{change.removed}</span>
                  </span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
};
