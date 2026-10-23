/**
 * 变更区里的单个文件 Diff：滚到附近（root 的上下各约一屏）才挂载 DiffView，之前用按行数估高的占位撑住滚动条。
 * 一次会话改几十个文件时，打开变更区不再同步渲染全部 Diff。当前文件总是立即挂载（点文件树要能滚到它）；
 * 挂载过的不再卸载，避免来回滚动时内容跳动。
 */
import React, { useEffect, useRef, useState } from 'react';

import type { FileDiff } from '../../utils/toolTrace';
import { DiffView } from '../Conversation/DiffView';

import styles from './SessionWorkspace.module.css';

/** 与 DiffView 的截断上限一致：占位不会比真实 Diff 高太多 */
const MAX_EST_ROWS = 400;

export const LazyDiffBlock: React.FC<{
  diff: FileDiff;
  active: boolean;
  cwd?: string | null;
  testId: string;
  /** 滚动容器：在它的可视范围附近才挂载 */
  root: React.RefObject<HTMLElement | null>;
}> = ({ diff, active, cwd, testId, root }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  // 成为当前文件即挂载并保留（渲染期比对，不在 effect 里 setState）
  if (active && !near) setNear(true);
  const mounted = near || active;

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (list) => {
        if (list.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: root.current, rootMargin: '100% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mounted, root]);

  return (
    <div
      ref={ref}
      className={styles.centerDiffBlock}
      data-active={active || undefined}
      data-testid={testId}
      data-file={diff.file}
      data-mounted={mounted || undefined}
    >
      {mounted ? (
        <DiffView diff={diff} cwd={cwd} fill split="auto" />
      ) : (
        <div
          className={styles.diffPlaceholder}
          style={
            {
              '--diff-rows': Math.min(diff.diff.lines.length, MAX_EST_ROWS),
            } as React.CSSProperties
          }
          aria-hidden
        />
      )}
    </div>
  );
};
