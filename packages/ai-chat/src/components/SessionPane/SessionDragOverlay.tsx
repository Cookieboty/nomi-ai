/**
 * 从侧栏拖会话进主区分屏时的视觉反馈层：
 * - `SessionDragGhost`：跟随光标的会话标题卡片；
 * - `SessionDropZoneOverlay`：主区左半 / 右半整高高亮落区。
 * 均只订阅 `useSessionPaneDrag()`，未拖动时返回 null，不产生额外渲染。
 */
import React from 'react';

import { useSessionPaneDrag } from '../../utils/sessionPaneDrag';

import styles from './SessionDragOverlay.module.css';

export const SessionDragGhost: React.FC = () => {
  const drag = useSessionPaneDrag();
  if (!drag) return null;
  return (
    <div
      className={styles.ghost}
      data-testid="session-drag-ghost"
      aria-hidden
      style={{
        transform: `translate3d(${drag.x + 12}px, ${drag.y - 16}px, 0)`,
      }}
    >
      <span className={styles.ghostTitle}>{drag.title}</span>
    </div>
  );
};

export const SessionDropZoneOverlay: React.FC = () => {
  const drag = useSessionPaneDrag();
  if (!drag?.side) return null;
  return (
    <div
      className={styles.dropZone}
      data-testid="session-drop-zone"
      data-side={drag.side}
      aria-hidden
    />
  );
};
