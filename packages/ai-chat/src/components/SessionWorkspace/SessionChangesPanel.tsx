/** Codex 风格：本轮变更 + 工作区 Git（只读） */
import { t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, FileDiff, GitBranch } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { harnessClient, type GitDiffResult } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { aggregateSessionChanges, type ChangeEntry } from '../../utils/sessionChanges';
import { DiffView } from '../Conversation/DiffView';

import styles from './SessionWorkspace.module.css';

type Tab = 'changes' | 'git';

function parseUnifiedDiff(
  raw: string,
): Array<{ file: string; body: string; added: number; removed: number }> {
  if (!raw.trim()) return [];
  const chunks = raw.split(/^diff --git /m).filter(Boolean);
  return chunks.map((c) => {
    const body = c.startsWith('a/') ? `diff --git ${c}` : c;
    const file =
      /^diff --git a\/(.+?) b\//m.exec(body)?.[1] ??
      /^\+\+\+ b\/(.+)$/m.exec(body)?.[1] ??
      t('（未命名文件）');
    let added = 0;
    let removed = 0;
    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { file, body, added, removed };
  });
}

const ChangeRow: React.FC<{
  entry: ChangeEntry;
  open: boolean;
  onToggle: () => void;
}> = ({ entry, open, onToggle }) => (
  <div className={styles.row} data-testid="change-row">
    <button type="button" className={styles.rowHead} onClick={onToggle}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span className={styles.file} title={entry.file}>
        {entry.file}
      </span>
      <span className={styles.stat}>
        <span className={styles.add}>+{entry.added}</span>
        <span className={styles.del}>−{entry.removed}</span>
      </span>
      <span className={styles.badge} data-status={entry.status}>
        {entry.status === 'added'
          ? t('新增')
          : entry.status === 'deleted'
            ? t('删除')
            : entry.status === 'modified'
              ? t('修改')
              : t('变更')}
      </span>
    </button>
    {open && entry.diff && (
      <div className={styles.detail}>
        <DiffView diff={entry.diff} />
      </div>
    )}
  </div>
);

export const SessionChangesPanel: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
}> = ({ messages, cwd }) => {
  const [tab, setTab] = useState<Tab>('changes');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [git, setGit] = useState<GitDiffResult | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);

  const refreshGit = useCallback(async () => {
    if (!cwd) {
      setGit(null);
      return;
    }
    setGitBusy(true);
    try {
      const r = await harnessClient.gitDiff(cwd);
      setGit(r);
    } catch (e) {
      setGit({
        ok: false,
        status: '',
        stat: '',
        diff: '',
        truncated: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setGitBusy(false);
    }
  }, [cwd]);

  const openGit = useCallback(() => {
    setTab('git');
    void refreshGit();
  }, [refreshGit]);

  const gitFiles = useMemo(() => parseUnifiedDiff(git?.diff ?? ''), [git?.diff]);

  if (!changes.length && !cwd) return null;

  return (
    <section className={styles.panel} data-testid="session-changes-panel">
      <header className={styles.panelHead}>
        <button
          type="button"
          className={styles.collapse}
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {t('工作区')}
        </button>
        {!collapsed && (
          <div className={styles.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'changes'}
              className={styles.tab}
              data-active={tab === 'changes' || undefined}
              onClick={() => setTab('changes')}
            >
              <FileDiff size={12} />
              {t('本轮变更')}
              {changes.length ? <span className={styles.count}>{changes.length}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'git'}
              className={styles.tab}
              data-active={tab === 'git' || undefined}
              onClick={openGit}
            >
              <GitBranch size={12} />
              {t('工作区 Git')}
            </button>
          </div>
        )}
      </header>
      {!collapsed && tab === 'changes' && (
        <div className={styles.body} data-testid="changes-list">
          {!changes.length ? (
            <p className={styles.empty}>{t('本会话尚无文件变更')}</p>
          ) : (
            changes.map((c) => (
              <ChangeRow
                key={c.file}
                entry={c}
                open={openFile === c.file}
                onToggle={() => setOpenFile((f) => (f === c.file ? null : c.file))}
              />
            ))
          )}
        </div>
      )}
      {!collapsed && tab === 'git' && (
        <div className={styles.body} data-testid="git-list">
          {!cwd ? (
            <p className={styles.empty}>{t('当前会话没有工作目录')}</p>
          ) : gitBusy && !git ? (
            <p className={styles.empty}>{t('读取 git…')}</p>
          ) : git && !git.ok ? (
            <p className={styles.empty}>{git.error || t('无法读取 git 状态')}</p>
          ) : (
            <>
              {git?.status ? (
                <pre className={styles.status} data-testid="git-status">
                  {git.status}
                </pre>
              ) : (
                <p className={styles.empty}>{t('工作区干净')}</p>
              )}
              {git?.stat ? <pre className={styles.statBlock}>{git.stat}</pre> : null}
              {gitFiles.map((f) => (
                <div key={f.file} className={styles.row}>
                  <div className={styles.rowHead}>
                    <span className={styles.file} title={f.file}>
                      {f.file}
                    </span>
                    <span className={styles.stat}>
                      <span className={styles.add}>+{f.added}</span>
                      <span className={styles.del}>−{f.removed}</span>
                    </span>
                  </div>
                  <pre className={styles.gitDiff}>{f.body}</pre>
                </div>
              ))}
              {git?.truncated ? <p className={styles.empty}>{t('diff 已截断')}</p> : null}
              <button type="button" className={styles.refresh} onClick={() => void refreshGit()}>
                {t('刷新')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
};
