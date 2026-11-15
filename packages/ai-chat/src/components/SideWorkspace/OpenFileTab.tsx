/** 打开文件标签：左侧空状态，右侧工作区目录树，点文件后打开文件预览标签。 */
import { Icon, t } from '@nomi-ai/ui';
import { FolderOpen } from 'lucide-react';
import React from 'react';

import type { ConvMessage } from '../../types/conversation';
import { SessionChangesPanel } from '../SessionWorkspace';

import styles from './WorkspacePages.module.css';

export const OpenFileTab: React.FC<{
  hidden?: boolean;
  messages: readonly ConvMessage[];
  cwd?: string | null;
  roots?: readonly string[] | null;
  busy?: boolean;
}> = ({ hidden, messages, cwd, roots, busy }) => (
  <div className={styles.page} hidden={hidden} data-testid="open-file-tab">
    <div className={styles.empty}>
      <Icon icon={FolderOpen} size={36} />
      <p className={styles.emptyTitle}>{t('ui.providers-schedule.open-file')}</p>
      <p className={styles.emptyHint}>{t('ui.session-workspace.open-file-empty')}</p>
    </div>
    <aside className={styles.side} data-testid="open-file-tree">
      <SessionChangesPanel
        messages={messages}
        cwd={cwd}
        roots={roots}
        busy={busy}
        lockedView="workspace"
      />
    </aside>
  </div>
);
