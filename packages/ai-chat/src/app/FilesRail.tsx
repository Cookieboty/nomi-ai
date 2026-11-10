/**
 * 右栏（改动 · 文件）：左边一条可拖动的分割线 + 右栏本体（改动 / 文件面板，全屏审查挂在这里）。
 * 展开时自右滑入、收起时滑出（closing：放退出动画，放完由 App 卸载；分割线先拿掉）。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import { ChangesWorkbenchHost, SessionChangesPanel } from '../components/SessionWorkspace';
import { FILES_RAIL_W_MAX, FILES_RAIL_W_MIN } from '../services/filesRailPrefs';

import type { RailState } from './useRail';
import type { SplitWidth } from './useSplitWidths';

export const FilesRail: React.FC<{ rail: RailState; split: SplitWidth; closing?: boolean }> = ({
  rail,
  split,
  closing,
}) => (
  <>
    {!closing && (
      <div
        className="files-rail-splitter"
        data-testid="files-rail-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={split.width}
        aria-valuemin={FILES_RAIL_W_MIN}
        aria-valuemax={FILES_RAIL_W_MAX}
        onPointerDown={split.onPointerDown}
        onDoubleClick={split.onDoubleClick}
        title={t('ui.session-workspace.drag-to-resize-chat-vs-workspace-double-click')}
      />
    )}
    <aside
      className="files-rail"
      data-testid="files-rail"
      data-closing={closing || undefined}
      aria-hidden={closing || undefined}
      style={{
        ['--files-rail-w' as string]: `${split.width}px`,
        width: split.width,
        minWidth: 'var(--cd-files-rail-min)',
        maxWidth: FILES_RAIL_W_MAX,
        flexShrink: 1,
      }}
    >
      <SessionChangesPanel
        rail
        messages={rail.messages}
        cwd={rail.cwd}
        roots={rail.roots}
        busy={rail.busy}
        onClose={rail.close}
      />
      <ChangesWorkbenchHost messages={rail.messages} cwd={rail.cwd} roots={rail.roots} />
    </aside>
  </>
);
