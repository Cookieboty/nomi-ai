/** 变更标签：左侧本会话 / git Diff，右侧改动文件树。与「打开文件」互不耦合。 */
import { t, usePresence } from '@nomi-ai/ui';
import React, { useMemo } from 'react';

import type { SplitWidth } from '../../app/useSplitWidths';
import type { EmbeddedPreviewProps } from '../../hooks/useResourcePreview';
import { FILES_RAIL_W_MAX, FILES_RAIL_W_MIN } from '../../services/filesRailPrefs';
import type { ConvMessage } from '../../types/conversation';
import { aggregateSessionChanges } from '../../utils/sessionChanges';
import type { PreviewTabsControl } from '../ResourcePreview/ResourcePreview';
import { SessionChangesPanel } from '../SessionWorkspace';
import work from '../SessionWorkspace/SessionWorkspace.module.css';
import pane from '../SessionWorkspace/WorkspacePane.module.css';

import styles from './WorkspacePages.module.css';

export const ChangesTab: React.FC<{
  hidden?: boolean;
  messages: readonly ConvMessage[];
  cwd?: string | null;
  roots?: readonly string[] | null;
  busy?: boolean;
  renderPreview: (props: EmbeddedPreviewProps) => React.ReactNode;
  expanded: boolean;
  onExpanded: (expanded: boolean) => void;
  controlRef: React.MutableRefObject<PreviewTabsControl | null>;
  railSplit: SplitWidth;
  treeOpen?: boolean;
  onToggleTree?: () => void;
}> = ({
  hidden,
  messages,
  cwd,
  roots,
  busy,
  renderPreview,
  expanded,
  onExpanded,
  controlRef,
  railSplit,
  treeOpen = true,
  onToggleTree,
}) => {
  const entries = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const preview = renderPreview({
    inactive: !!hidden,
    expanded,
    onExpanded,
    controlRef,
    showTabs: true,
    mode: 'diffs',
    treeOpen,
    onToggleTree,
  });
  const showTree = treeOpen || !preview;
  const treeP = usePresence(showTree, 190);
  const treeRendered = !!treeP.value;
  const [wasTreeHidden, setWasTreeHidden] = React.useState(!showTree);
  if (!showTree && !wasTreeHidden) setWasTreeHidden(true);
  return (
    <div className={styles.page} hidden={hidden} data-testid="changes-tab">
      <div className={`${styles.diffMain} ${work.centerChanges} ${pane.codeScale}`}>
        <div className={styles.previewHost} data-testid="changes-tab-preview">
          {preview ??
            (!entries.length ? (
              <div className={styles.empty}>
                <p className={work.empty} data-testid="changes-tab-empty">
                  {t('ui.session-workspace.no-file-changes-in-this-session-yet')}
                </p>
              </div>
            ) : null)}
        </div>
      </div>
      <div
        className={styles.pageSplitter}
        data-testid="changes-page-splitter"
        hidden={!showTree}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={railSplit.width}
        aria-valuemin={FILES_RAIL_W_MIN}
        aria-valuemax={FILES_RAIL_W_MAX}
        onPointerDown={railSplit.onPointerDown}
        onDoubleClick={railSplit.onDoubleClick}
        title={t('ui.session-workspace.drag-to-resize-chat-vs-workspace-double-click')}
      />
      <aside
        className={styles.side}
        data-testid="changes-tab-tree"
        data-opening={(showTree && wasTreeHidden) || undefined}
        data-closing={treeP.closing || undefined}
        hidden={!treeRendered}
        style={
          {
            width: railSplit.width,
            flexBasis: railSplit.width,
            '--tree-rail-w': `${railSplit.width}px`,
          } as React.CSSProperties
        }
      >
        <SessionChangesPanel
          messages={messages}
          cwd={cwd}
          roots={roots}
          rail
          busy={busy}
          lockedView="changes"
        />
      </aside>
    </div>
  );
};
