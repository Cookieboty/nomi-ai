/**
 * Codex 中栏「变更」Diff：与对话可分割；多文件块、顶栏 +/−。
 * 全屏审查仍走 ChangesWorkbenchHost（openDetail）。
 */
import { t } from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import type { ConvMessage } from '../../types/conversation';
import {
  aggregateSessionChanges,
  aggregateTurnChanges,
  summarizeChanges,
  type ChangeEntry,
} from '../../utils/sessionChanges';
import { DiffView } from '../Conversation/DiffView';

import { useChangesUi } from './ChangesUiContext';
import styles from './SessionWorkspace.module.css';

export const CenterChangesHost: React.FC<{
  messages: readonly ConvMessage[];
}> = ({ messages }) => {
  const { workbench, closeWorkbench } = useChangesUi();
  const [scopeAll, setScopeAll] = useState(false);

  const sessionEntries = useMemo(() => aggregateSessionChanges(messages), [messages]);

  const turnEntries = useMemo(() => {
    if (!workbench?.messageId) return null;
    if (workbench.entries?.length) return workbench.entries;
    const m = messages.find((x) => x.id === workbench.messageId);
    return m ? aggregateTurnChanges(m) : [];
  }, [workbench, messages]);

  const entries: ChangeEntry[] = useMemo(() => {
    if (!workbench) return [];
    if (scopeAll || !workbench.messageId) return sessionEntries;
    return turnEntries ?? sessionEntries;
  }, [workbench, scopeAll, sessionEntries, turnEntries]);

  const summary = useMemo(() => summarizeChanges(entries), [entries]);
  const activeFile = workbench?.file ?? entries[0]?.file ?? null;
  const ordered = useMemo(() => {
    if (!activeFile) return entries;
    const head = entries.filter((e) => e.file === activeFile);
    const rest = entries.filter((e) => e.file !== activeFile);
    return [...head, ...rest];
  }, [entries, activeFile]);

  useEffect(() => {
    if (!workbench) return;
    setScopeAll(!workbench.messageId);
  }, [workbench]);

  useEffect(() => {
    if (!workbench) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeWorkbench();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workbench, closeWorkbench]);

  if (!workbench) return null;

  return (
    <section
      className={styles.centerChanges}
      data-testid="center-changes-pane"
      aria-label={t('变更')}
    >
      <header className={styles.centerChangesHead}>
        <span className={styles.wbCenterTab}>{t('变更')}</span>
        <button
          type="button"
          className={styles.wbCenterScope}
          data-active={!scopeAll || undefined}
          onClick={() => setScopeAll(false)}
        >
          {workbench.sourceLabel || t('上一轮')}
        </button>
        <button
          type="button"
          className={styles.wbViewAll}
          data-testid="center-changes-view-all"
          data-active={scopeAll || undefined}
          onClick={() => setScopeAll(true)}
        >
          {t('全部')}
        </button>
        <span className={styles.stat}>
          <span className={styles.add}>+{summary.added}</span>
          <span className={styles.del}>−{summary.removed}</span>
        </span>
        <span className={styles.wbSpacer} />
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={t('关闭')}
          data-testid="center-changes-close"
          onClick={closeWorkbench}
        >
          <X size={14} />
        </button>
      </header>
      <div className={styles.centerChangesBody}>
        {!ordered.length ? (
          <p className={styles.empty}>{t('本会话尚无文件变更')}</p>
        ) : (
          ordered.map((e) =>
            e.diff ? (
              <div
                key={e.file}
                className={styles.centerDiffBlock}
                data-active={e.file === activeFile || undefined}
                data-testid="center-diff-block"
                data-file={e.file}
              >
                <DiffView diff={e.diff} />
              </div>
            ) : null,
          )
        )}
      </div>
    </section>
  );
};
