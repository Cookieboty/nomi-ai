/** 变更标签：左侧本会话 / git Diff，右侧改动文件树。与「打开文件」互不耦合。 */
import { t } from '@nomi-ai/ui';
import React, { useMemo, useRef } from 'react';

import type { ConvMessage } from '../../types/conversation';
import { aggregateSessionChanges, summarizeChanges } from '../../utils/sessionChanges';
import { rootOf } from '../../utils/workspacePath';
import { SessionChangesPanel } from '../SessionWorkspace';
import { LazyDiffBlock } from '../SessionWorkspace/LazyDiffBlock';
import work from '../SessionWorkspace/SessionWorkspace.module.css';
import pane from '../SessionWorkspace/WorkspacePane.module.css';

import styles from './WorkspacePages.module.css';

export const ChangesTab: React.FC<{
  hidden?: boolean;
  messages: readonly ConvMessage[];
  cwd?: string | null;
  roots?: readonly string[] | null;
  busy?: boolean;
}> = ({ hidden, messages, cwd, roots, busy }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const summary = useMemo(() => summarizeChanges(entries), [entries]);
  const cwdOf = (file: string) => (roots?.length ? (rootOf(roots, file) ?? cwd) : cwd);
  return (
    <div className={styles.page} hidden={hidden} data-testid="changes-tab">
      <div className={`${styles.diffMain} ${work.centerChanges} ${pane.codeScale}`}>
        <header className={pane.centerHead}>
          <span className={pane.centerTitle}>{t('ui.session-workspace.changed')}</span>
          <span className={work.stat} data-testid="changes-tab-stat">
            <span className={work.add}>+{summary.added}</span>
            <span className={work.del}>−{summary.removed}</span>
          </span>
        </header>
        <div className={work.centerChangesBody} ref={bodyRef}>
          {!entries.length ? (
            <p className={work.empty} data-testid="changes-tab-empty">
              {t('ui.session-workspace.no-file-changes-in-this-session-yet')}
            </p>
          ) : (
            entries.map((e, i) =>
              e.diff ? (
                <LazyDiffBlock
                  key={e.file}
                  diff={e.diff}
                  active={i === 0}
                  cwd={cwdOf(e.file)}
                  testId="changes-tab-diff"
                  root={bodyRef}
                />
              ) : null,
            )
          )}
        </div>
      </div>
      <aside className={styles.side} data-testid="changes-tab-tree">
        <SessionChangesPanel
          messages={messages}
          cwd={cwd}
          roots={roots}
          busy={busy}
          lockedView="changes"
        />
      </aside>
    </div>
  );
};
