/** Codex 风格右侧文件栏：已更改文件树 + Diff/本地预览（整页左会话|中 chat|右本栏） */
import { t } from '@nomi-ai/ui';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileDiff,
  GitBranch,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { harnessClient, type GitDiffResult } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import {
  isNotGitRepoError,
  parseGitStatus,
  splitUnifiedDiff,
  type GitFileEntry,
} from '../../utils/gitStatusParse';
import { parsePatch } from '../../utils/lineDiff';
import {
  aggregateSessionChanges,
  buildChangeFileTree,
  locateChangeMessage,
  summarizeChanges,
} from '../../utils/sessionChanges';
import type { FileDiff as ToolFileDiff } from '../../utils/toolTrace';

import { ChangeFileTree } from './ChangeFileTree';
import { useChangesUi } from './ChangesUiContext';
import { FilePreview, type PreviewFile } from './FilePreview';
import styles from './SessionWorkspace.module.css';

type Tab = 'changes' | 'git';

const GitRow: React.FC<{
  entry: GitFileEntry;
  added?: number;
  removed?: number;
  selected: boolean;
  onSelect: () => void;
}> = ({ entry, added, removed, selected, onSelect }) => (
  <div
    className={styles.row}
    data-testid="git-row"
    data-selected={selected || undefined}
    data-file={entry.path}
  >
    <button type="button" className={styles.rowHead} onClick={onSelect}>
      <span
        className={styles.letter}
        data-letter={entry.letter}
        title={`${entry.index}${entry.work}`}
      >
        {entry.letter}
      </span>
      <span className={styles.file} title={entry.path}>
        {entry.path}
      </span>
      {entry.staged ? <span className={styles.badge}>{t('已暂存')}</span> : null}
      {entry.untracked ? <span className={styles.badge}>{t('未跟踪')}</span> : null}
      {(added != null || removed != null) && (
        <span className={styles.stat}>
          {added != null ? <span className={styles.add}>+{added}</span> : null}
          {removed != null ? <span className={styles.del}>−{removed}</span> : null}
        </span>
      )}
    </button>
  </div>
);

export const SessionChangesPanel: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
  /** 整页右栏全高模式 */
  rail?: boolean;
}> = ({ messages, cwd, rail = false }) => {
  const [tab, setTab] = useState<Tab>('changes');
  const [collapsed, setCollapsed] = useState(false);
  const [git, setGit] = useState<GitDiffResult | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [badgePulse, setBadgePulse] = useState(false);
  const prevCount = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const { workbench, closeWorkbench, openDetail } = useChangesUi();

  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const summary = useMemo(() => summarizeChanges(changes), [changes]);
  const tree = useMemo(() => buildChangeFileTree(changes), [changes]);

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

  useEffect(() => {
    if (changes.length > prevCount.current) {
      setCollapsed(false);
      setTab('changes');
      setBadgePulse(true);
      const tmr = window.setTimeout(() => setBadgePulse(false), 1200);
      prevCount.current = changes.length;
      return () => clearTimeout(tmr);
    }
    prevCount.current = changes.length;
  }, [changes.length]);

  /** 摘要卡「查看变更」→ 聚焦本右栏，不另开全屏三栏 */
  useEffect(() => {
    if (!workbench) return;
    setCollapsed(false);
    setTab('changes');
    setFilter('');
    const file = workbench.file ?? workbench.entries?.[0]?.file ?? changes[0]?.file ?? null;
    if (file) {
      setSelectedFile(file);
      setPreviewKey(`c:${file}`);
    }
    panelRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [workbench]); // eslint-disable-line react-hooks/exhaustive-deps -- focus on open only

  const openGit = useCallback(() => {
    setTab('git');
    void refreshGit();
  }, [refreshGit]);

  const gitFiles = useMemo(() => parseGitStatus(git?.status ?? ''), [git?.status]);
  const gitDiffs = useMemo(() => splitUnifiedDiff(git?.diff ?? ''), [git?.diff]);
  const gitDiffByPath = useMemo(() => {
    const m = new Map<string, (typeof gitDiffs)[0]>();
    for (const d of gitDiffs) m.set(d.file, d);
    return m;
  }, [gitDiffs]);

  const previewFiles: PreviewFile[] = useMemo(() => {
    if (tab === 'changes') {
      return changes.map((c) => ({
        key: `c:${c.file}`,
        path: c.file,
        letter: c.letter,
        added: c.added,
        removed: c.removed,
        change: c,
      }));
    }
    return gitFiles.map((g) => {
      const d = gitDiffByPath.get(g.path);
      const gitDiff: ToolFileDiff | undefined = d
        ? { file: d.file, diff: parsePatch(d.body) }
        : undefined;
      return {
        key: `g:${g.path}`,
        path: g.path,
        letter: g.letter,
        added: d?.added,
        removed: d?.removed,
        gitDiff,
      };
    });
  }, [tab, changes, gitFiles, gitDiffByPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        !panelRef.current?.contains(document.activeElement) &&
        document.activeElement !== panelRef.current
      ) {
        if (!previewKey && !workbench) return;
      }
      if (e.key === 'Escape') {
        if (previewKey) {
          e.preventDefault();
          setPreviewKey(null);
          closeWorkbench();
        } else if (!collapsed && !rail) {
          e.preventDefault();
          setCollapsed(true);
        } else if (workbench) {
          closeWorkbench();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewKey, collapsed, rail, workbench, closeWorkbench]);

  if (!changes.length && !cwd) return null;

  const gitErrorFriendly = (() => {
    if (!git || git.ok) return null;
    if (isNotGitRepoError(git.error)) return t('当前目录不是 Git 仓库');
    return git.error || t('无法读取 git 状态');
  })();

  const pickChange = (file: string) => {
    setSelectedFile(file);
    setPreviewKey(`c:${file}`);
  };

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      data-testid="session-changes-panel"
      data-rail={rail || undefined}
      data-focused={workbench ? 'true' : undefined}
      tabIndex={-1}
    >
      <header className={styles.panelHead}>
        <button
          type="button"
          className={styles.collapse}
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {rail ? t('已更改的文件') : t('工作区')}
          {summary.files > 0 ? (
            <span
              className={styles.summary}
              data-pulse={badgePulse || undefined}
              data-testid="changes-summary"
            >
              {t('{0} 个文件', summary.files)} ·{' '}
              <span className={styles.add}>+{summary.added}</span>{' '}
              <span className={styles.del}>−{summary.removed}</span>
            </span>
          ) : null}
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
              {changes.length ? (
                <span className={styles.count} data-pulse={badgePulse || undefined}>
                  {changes.length}
                </span>
              ) : null}
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
            {tab === 'git' ? (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => void refreshGit()}
                disabled={gitBusy}
                aria-label={t('刷新')}
                title={t('刷新')}
                data-testid="git-refresh"
              >
                <RefreshCw size={12} className={gitBusy ? styles.spin : undefined} />
              </button>
            ) : null}
            {rail && workbench ? (
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={t('关闭')}
                title={t('关闭预览聚焦')}
                data-testid="files-rail-clear-focus"
                onClick={() => {
                  setPreviewKey(null);
                  closeWorkbench();
                }}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        )}
      </header>

      {!collapsed && tab === 'changes' && (
        <div className={styles.body} data-testid="changes-list">
          {!changes.length ? (
            <p className={styles.empty}>{t('本会话尚无文件变更')}</p>
          ) : (
            <>
              <label className={styles.wbFilter}>
                <Search size={12} />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('筛选文件…')}
                  data-testid="files-rail-filter"
                />
              </label>
              <div className={styles.wbTreeHead}>{t('已更改的文件')}</div>
              <div className={styles.railTree} data-testid="files-rail-tree">
                <ChangeFileTree
                  nodes={tree}
                  active={selectedFile}
                  onPick={pickChange}
                  filter={filter}
                  testIdPrefix="rail"
                  messageIdByFile={Object.fromEntries(changes.map((c) => [c.file, c.messageId]))}
                  onLocate={(_file, messageId) => {
                    if (messageId) locateChangeMessage(messageId);
                  }}
                />
              </div>
              <button
                type="button"
                className={styles.detailLink}
                data-testid="panel-open-workbench"
                onClick={() =>
                  openDetail({
                    entries: changes,
                    file: selectedFile ?? changes[0]?.file,
                    sourceLabel: t('全部'),
                  })
                }
              >
                <ExternalLink size={12} />
                {t('打开完整变更工作台')}
              </button>
            </>
          )}
        </div>
      )}

      {!collapsed && tab === 'git' && (
        <div className={styles.body} data-testid="git-list">
          {!cwd ? (
            <p className={styles.empty}>{t('当前会话没有工作目录')}</p>
          ) : gitBusy && !git ? (
            <p className={styles.empty}>{t('读取 git…')}</p>
          ) : gitErrorFriendly ? (
            <p className={styles.empty} data-testid="git-friendly-error">
              {gitErrorFriendly}
            </p>
          ) : (
            <>
              <p className={styles.hint} data-testid="git-scope">
                {t('相对 HEAD · 工作区变更（含未跟踪）')}
              </p>
              {!gitFiles.length ? (
                <p className={styles.empty}>{t('工作区干净')}</p>
              ) : (
                gitFiles.map((g) => {
                  const d = gitDiffByPath.get(g.path);
                  return (
                    <GitRow
                      key={g.path}
                      entry={g}
                      added={d?.added}
                      removed={d?.removed}
                      selected={selectedFile === g.path || previewKey === `g:${g.path}`}
                      onSelect={() => {
                        setSelectedFile(g.path);
                        setPreviewKey(`g:${g.path}`);
                      }}
                    />
                  );
                })
              )}
              {git?.truncated ? <p className={styles.empty}>{t('diff 已截断')}</p> : null}
            </>
          )}
        </div>
      )}

      {!collapsed && previewKey && previewFiles.length > 0 && (
        <FilePreview
          files={previewFiles}
          activeKey={previewKey}
          cwd={cwd}
          onActiveKey={setPreviewKey}
          onClose={() => {
            setPreviewKey(null);
            closeWorkbench();
          }}
          onSaved={() => {
            void refreshGit();
          }}
        />
      )}
    </section>
  );
};
