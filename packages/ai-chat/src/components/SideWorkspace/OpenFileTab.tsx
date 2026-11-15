/** 打开文件页：文件预览 tabs 在页面主体，右侧保留工作区目录树。 */
import { Icon, t } from '@nomi-ai/ui';
import { IconFolderOpen as FolderOpen } from '@tabler/icons-react';
import React from 'react';

import type { SplitWidth } from '../../app/useSplitWidths';
import type { EmbeddedPreviewProps } from '../../hooks/useResourcePreview';
import { FILES_RAIL_W_MAX, FILES_RAIL_W_MIN } from '../../services/filesRailPrefs';
import type { ConvMessage } from '../../types/conversation';
import type { PreviewTabsControl } from '../ResourcePreview/ResourcePreview';
import { SessionChangesPanel } from '../SessionWorkspace';

import styles from './WorkspacePages.module.css';

export const OpenFileTab: React.FC<{
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
}) => (
  <div className={styles.page} hidden={hidden} data-testid="open-file-tab">
    <main className={styles.diffMain} data-testid="open-file-preview">
      {renderPreview({
        inactive: !!hidden,
        expanded,
        onExpanded,
        controlRef,
        showTabs: true,
        mode: 'files',
      }) ?? (
        <div className={styles.empty}>
          <Icon icon={FolderOpen} size={36} />
          <p className={styles.emptyTitle}>{t('ui.providers-schedule.open-file')}</p>
          <p className={styles.emptyHint}>{t('ui.session-workspace.open-file-empty')}</p>
        </div>
      )}
    </main>
    <div
      className={styles.pageSplitter}
      data-testid="open-file-page-splitter"
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
      data-testid="open-file-tree"
      style={{ width: railSplit.width, flexBasis: railSplit.width }}
    >
      <SessionChangesPanel
        messages={messages}
        cwd={cwd}
        roots={roots}
        rail
        busy={busy}
        lockedView="workspace"
      />
    </aside>
  </div>
);
