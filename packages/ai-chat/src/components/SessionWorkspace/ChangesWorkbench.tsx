/** Codex 风格完整变更工作台：左来源 / 中 Diff / 右文件树 */
import { t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, FileCode2, Filter, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ConvMessage } from '../../types/conversation';
import {
  aggregateSessionChanges,
  aggregateTurnChanges,
  buildChangeFileTree,
  projectNameFromCwd,
  summarizeChanges,
  type ChangeEntry,
  type ChangeTreeNode,
} from '../../utils/sessionChanges';
import { DiffView } from '../Conversation/DiffView';

import { useChangesUi } from './ChangesUiContext';
import styles from './SessionWorkspace.module.css';

function TreeNodes({
  nodes,
  depth,
  active,
  onPick,
  filter,
}: {
  nodes: ChangeTreeNode[];
  depth: number;
  active: string | null;
  onPick: (file: string) => void;
  filter: string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = filter.trim().toLowerCase();

  const match = (path: string) => !q || path.toLowerCase().includes(q);

  return (
    <>
      {nodes.map((n) => {
        if (n.kind === 'dir') {
          const any =
            !q ||
            n.children.some(function walk(c): boolean {
              return c.kind === 'file' ? match(c.path) : c.children.some(walk);
            });
          if (!any) return null;
          const isOpen = open[n.path] ?? true;
          return (
            <div key={n.path || n.name} className={styles.wbTreeDir}>
              <button
                type="button"
                className={styles.wbTreeDirHead}
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => setOpen((o) => ({ ...o, [n.path]: !isOpen }))}
              >
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{n.name || '/'}</span>
              </button>
              {isOpen ? (
                <TreeNodes
                  nodes={n.children}
                  depth={depth + 1}
                  active={active}
                  onPick={onPick}
                  filter={filter}
                />
              ) : null}
            </div>
          );
        }
        if (!match(n.path)) return null;
        const e = n.entry;
        return (
          <button
            key={n.path}
            type="button"
            className={styles.wbTreeFile}
            style={{ paddingLeft: 8 + depth * 12 }}
            data-active={active === n.path || undefined}
            data-testid="wb-file"
            data-file={n.path}
            onClick={() => onPick(n.path)}
          >
            <FileCode2 size={12} className={styles.wbFileIcon} />
            <span className={styles.wbFileName} title={n.path}>
              {n.name}
            </span>
            <span className={styles.wbDot} aria-hidden />
            <span className={styles.stat}>
              <span className={styles.add}>+{e.added}</span>
              <span className={styles.del}>−{e.removed}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}

export const ChangesWorkbenchHost: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
}> = ({ messages, cwd }) => {
  const { workbench, closeWorkbench } = useChangesUi();
  const [scopeAll, setScopeAll] = useState(false);
  const [filter, setFilter] = useState('');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [collapsedOthers, setCollapsedOthers] = useState(false);

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
  const tree = useMemo(() => buildChangeFileTree(entries), [entries]);
  const project = projectNameFromCwd(cwd);

  useEffect(() => {
    if (!workbench) return;
    setScopeAll(!workbench.messageId);
    setActiveFile(workbench.file ?? entries[0]?.file ?? null);
    setFilter('');
    setCollapsedOthers(false);
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

  if (!workbench || typeof document === 'undefined') return null;

  const active = entries.find((e) => e.file === activeFile) ?? entries[0];
  const others = entries.filter((e) => e.file !== active?.file);

  return createPortal(
    <div
      className={styles.wbOverlay}
      data-testid="changes-workbench"
      role="dialog"
      aria-modal="true"
    >
      <div className={styles.wbFrame}>
        <aside className={styles.wbLeft}>
          <div className={styles.wbProject}>
            <div className={styles.wbProjectName}>{project}</div>
            <div className={styles.wbProjectMeta}>
              <span>{t('变更')}</span>
              <span className={styles.stat}>
                <span className={styles.add}>+{summary.added.toLocaleString()}</span>
                <span className={styles.del}>−{summary.removed.toLocaleString()}</span>
              </span>
            </div>
          </div>
          <div className={styles.wbSources}>
            <div className={styles.wbSourcesHead}>{t('来源')}</div>
            <button
              type="button"
              className={styles.wbSourceItem}
              data-active={!scopeAll || undefined}
              onClick={() => setScopeAll(false)}
            >
              {workbench.sourceLabel || workbench.messageId?.slice(0, 18) || t('上一轮')}
            </button>
            <button
              type="button"
              className={styles.wbViewAll}
              data-testid="wb-view-all"
              onClick={() => setScopeAll(true)}
            >
              {t('查看全部')}
            </button>
          </div>
        </aside>

        <main className={styles.wbCenter}>
          <header className={styles.wbCenterHead}>
            <span className={styles.wbCenterTab}>{t('变更')}</span>
            <span className={styles.wbCenterScope}>{scopeAll ? t('全部') : t('上一轮')}</span>
            <span className={styles.stat}>
              <span className={styles.add}>+{summary.added}</span>
              <span className={styles.del}>−{summary.removed}</span>
            </span>
            <span className={styles.wbSpacer} />
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={t('关闭')}
              data-testid="wb-close"
              onClick={closeWorkbench}
            >
              <X size={16} />
            </button>
          </header>
          <div className={styles.wbDiffScroll}>
            {!entries.length ? (
              <p className={styles.empty}>{t('本会话尚无文件变更')}</p>
            ) : active?.diff ? (
              <>
                <DiffView diff={active.diff} />
                {others.length > 0 ? (
                  <div className={styles.wbOtherFiles}>
                    <button
                      type="button"
                      className={styles.wbOtherToggle}
                      onClick={() => setCollapsedOthers((c) => !c)}
                    >
                      {collapsedOthers ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      {t('其它 {0} 个文件', others.length)}
                    </button>
                    {!collapsedOthers
                      ? others.map((e) =>
                          e.diff ? (
                            <button
                              key={e.file}
                              type="button"
                              className={styles.wbOtherHead}
                              onClick={() => setActiveFile(e.file)}
                            >
                              <span className={styles.turnPath} title={e.file}>
                                {e.file}
                              </span>
                              <span className={styles.stat}>
                                <span className={styles.add}>+{e.added}</span>
                                <span className={styles.del}>−{e.removed}</span>
                              </span>
                            </button>
                          ) : null,
                        )
                      : null}
                    {!collapsedOthers
                      ? others.map((e) =>
                          e.diff && e.file === others[0]?.file ? (
                            <DiffView key={`d-${e.file}`} diff={e.diff} />
                          ) : null,
                        )
                      : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className={styles.empty}>{t('无 diff，可切换到「文件」查看磁盘内容')}</p>
            )}
          </div>
        </main>

        <aside className={styles.wbRight}>
          <div className={styles.wbRightTools}>
            <Filter size={14} />
            <Search size={14} />
          </div>
          <label className={styles.wbFilter}>
            <Search size={12} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('筛选文件…')}
              data-testid="wb-filter"
            />
          </label>
          <div className={styles.wbTreeHead}>{t('已更改的文件')}</div>
          <div className={styles.wbTree} data-testid="wb-file-tree">
            <TreeNodes
              nodes={tree}
              depth={0}
              active={active?.file ?? null}
              onPick={setActiveFile}
              filter={filter}
            />
          </div>
        </aside>
      </div>
    </div>,
    document.body,
  );
};
