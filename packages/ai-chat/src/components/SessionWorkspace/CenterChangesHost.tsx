/**
 * Codex 中栏：与对话水平并排、全高，是唯一的查看区。
 * - workbench：本会话「变更」Diff，多文件块、顶栏 +/−
 * - 否则右栏在预览未提交 / 磁盘文件时，这里只给出挂载点，FilePreview 由右栏 portal 进来
 * 全屏审查仍走 ChangesWorkbenchHost（openDetail）。
 */
import { t } from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

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
import pane from './WorkspacePane.module.css';

export const CenterChangesHost: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
}> = ({ messages, cwd }) => {
  const { workbench, closeWorkbench, previewOpen, setPreviewSlot } = useChangesUi();
  const [scopeAll, setScopeAll] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!activeFile || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(
      `[data-testid="center-diff-block"][data-file="${CSS.escape(activeFile)}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeFile, ordered.length]);

  if (!workbench) {
    if (!previewOpen) return null;
    return (
      <section
        ref={setPreviewSlot}
        className={`${styles.centerChanges} ${pane.codeScale}`}
        data-testid="center-preview-pane"
        aria-label={t('文件预览')}
      />
    );
  }

  return (
    <section
      className={`${styles.centerChanges} ${pane.codeScale}`}
      data-testid="center-changes-pane"
      aria-label={t('变更')}
    >
      <header className={pane.centerHead}>
        <span className={pane.centerTitle}>{t('变更')}</span>
        <span className={styles.stat} data-testid="center-changes-stat">
          <span className={styles.add}>+{summary.added}</span>
          <span className={styles.del}>−{summary.removed}</span>
        </span>
        {/* 只有聚焦某一轮时才有「这一轮 / 全部」可切 */}
        {workbench.messageId ? (
          <span className={pane.seg} role="group" data-testid="center-changes-scope">
            <button
              type="button"
              className={pane.segBtn}
              aria-pressed={!scopeAll}
              data-active={!scopeAll || undefined}
              onClick={() => setScopeAll(false)}
            >
              {workbench.sourceLabel || t('上一轮')}
            </button>
            <button
              type="button"
              className={pane.segBtn}
              aria-pressed={scopeAll}
              data-testid="center-changes-view-all"
              data-active={scopeAll || undefined}
              onClick={() => setScopeAll(true)}
            >
              {t('全部')}
            </button>
          </span>
        ) : null}
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
      <div className={styles.centerChangesBody} ref={bodyRef}>
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
                <DiffView diff={e.diff} cwd={cwd} fill split="auto" />
              </div>
            ) : null,
          )
        )}
      </div>
    </section>
  );
};
