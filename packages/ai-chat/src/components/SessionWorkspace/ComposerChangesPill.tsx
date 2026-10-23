/** Composer 附近「N 个文件已更改 +x −y」pill；点击打开并排 Diff 工作台 */
import { t } from '@nomi-ai/ui';
import { FileDiff } from 'lucide-react';
import React, { useMemo } from 'react';

import type { ConvMessage } from '../../types/conversation';
import { aggregateSessionChanges, summarizeChanges } from '../../utils/sessionChanges';

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
    <button
      type="button"
      className={styles.composerChangesPill}
      data-testid="composer-changes-pill"
      title={t('查看变更')}
      onClick={() =>
        openWorkbench({
          entries: changes,
          file: changes[0]?.file,
          sourceLabel: t('全部'),
        })
      }
    >
      <FileDiff size={12} aria-hidden />
      <span>
        {t('{0} 个文件已更改', summary.files)} <span className={styles.add}>+{summary.added}</span>{' '}
        <span className={styles.del}>−{summary.removed}</span>
      </span>
    </button>
  );
};
