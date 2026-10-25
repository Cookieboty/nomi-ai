/** Composer 附近「N 个文件已更改 +x −y」pill；点击打开并排 Diff 工作台 */
import { t } from '@nomi-ai/ui';
import { FileDiff } from 'lucide-react';
import React, { useMemo } from 'react';

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

  if (!summary.files) return null;

  return (
    <div className={styles.composerChangesWrap}>
      <button
        type="button"
        className={styles.composerChangesPill}
        data-testid="composer-changes-pill"
        title={t('ui.session-workspace.view-changes')}
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
      <div
        className={styles.composerChangesPopover}
        role="tooltip"
        data-testid="composer-changes-popover"
        aria-label={t('ui.session-workspace.view-changes')}
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
      </div>
    </div>
  );
};
