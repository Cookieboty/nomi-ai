/**
 * 全屏审查（次要详情页）：头部一行 + 左侧全部文件 Diff 依次排开 | 右侧相对路径文件树。
 * 默认「查看变更」走中栏 Diff，不走此 portal。
 */
import { t } from '@nomi-ai/ui';
import { Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ConvMessage } from '../../types/conversation';
import {
  aggregateSessionChanges,
  aggregateTurnChanges,
  buildChangeFileTree,
  projectNameFromCwd,
  summarizeChanges,
  type ChangeEntry,
} from '../../utils/sessionChanges';
import { DiffView } from '../Conversation/DiffView';

import { ChangeFileTree } from './ChangeFileTree';
import { useChangesUi } from './ChangesUiContext';
import styles from './SessionWorkspace.module.css';
import pane from './WorkspacePane.module.css';

export const ChangesWorkbenchHost: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
}> = ({ messages, cwd }) => {
  const { detail: workbench, closeDetail: closeWorkbench } = useChangesUi();
  const [scopeAll, setScopeAll] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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
  const tree = useMemo(() => buildChangeFileTree(entries, { cwd, compact: true }), [entries, cwd]);
  const project = projectNameFromCwd(cwd);

  useEffect(() => {
    if (!workbench) return;
    setScopeAll(!workbench.messageId);
    setActiveFile(workbench.file ?? entries[0]?.file ?? null);
    setFilter('');
    closeRef.current?.focus({ preventScroll: true });
  }, [workbench]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on open only

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

  // 点文件树：滚到对应文件的 Diff（全部文件依次排开，不再只显示一个 + 折叠其余）
  useEffect(() => {
    if (!activeFile || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(
      `[data-testid="wb-diff-block"][data-file="${CSS.escape(activeFile)}"]`,
    );
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [activeFile]);

  if (!workbench || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={styles.wbOverlay}
      data-testid="changes-workbench"
      role="dialog"
      aria-modal="true"
      aria-label={t('全屏审查')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeWorkbench();
      }}
    >
      <div className={`${styles.wbFrame} ${pane.codeScale}`}>
        <header className={pane.centerHead}>
          <span className={pane.crumb} title={cwd || undefined}>
            {project}
          </span>
          <span className={pane.crumbSep} aria-hidden>
            /
          </span>
          <span className={pane.centerTitle}>{t('变更')}</span>
          <span className={styles.stat}>
            <span className={styles.add}>+{summary.added.toLocaleString()}</span>
            <span className={styles.del}>−{summary.removed.toLocaleString()}</span>
          </span>
          {workbench.messageId ? (
            <span className={pane.seg} role="group">
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
                data-active={scopeAll || undefined}
                data-testid="wb-view-all"
                onClick={() => setScopeAll(true)}
              >
                {t('全部')}
              </button>
            </span>
          ) : null}
          <span className={styles.wbSpacer} />
          <span className={pane.meta}>{t('{0} 个文件', String(summary.files))}</span>
          <button
            ref={closeRef}
            type="button"
            className={pane.iconBtn}
            aria-label={t('关闭')}
            title={t('关闭（Esc）')}
            data-testid="wb-close"
            onClick={closeWorkbench}
          >
            <X size={16} />
          </button>
        </header>

        <div className={pane.wbBody}>
          <main className={pane.wbDiffs} ref={bodyRef}>
            {!entries.length ? (
              <p className={pane.empty}>{t('本会话尚无文件变更')}</p>
            ) : (
              entries.map((e) =>
                e.diff ? (
                  <div
                    key={e.file}
                    className={styles.centerDiffBlock}
                    data-active={e.file === activeFile || undefined}
                    data-testid="wb-diff-block"
                    data-file={e.file}
                  >
                    <DiffView diff={e.diff} cwd={cwd} fill split="auto" />
                  </div>
                ) : null,
              )
            )}
          </main>

          <aside className={pane.wbTreePane}>
            <label className={styles.wbFilter}>
              <Search size={14} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('筛选文件…')}
                aria-label={t('筛选文件…')}
                data-testid="wb-filter"
              />
            </label>
            <div className={styles.wbTree} data-testid="wb-file-tree">
              <ChangeFileTree
                nodes={tree}
                active={activeFile}
                onPick={setActiveFile}
                filter={filter}
              />
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
};
