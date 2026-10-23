/** Codex 右栏：文件树（搜索、+/−、蓝点）；中栏 Diff 见 CenterChangesHost；外层与 chat 分割见 App */
import { t } from '@nomi-ai/ui';
import { Expand, FolderTree, GitBranch, RefreshCw, Search, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  harnessClient,
  type GitDiffResult,
  type WorkspaceTreeNode,
} from '../../services/harnessClient';
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
  locateChangeMessage,
  mergeWorkspaceAndChanges,
  projectNameFromCwd,
  summarizeChanges,
} from '../../utils/sessionChanges';
import type { FileDiff as ToolFileDiff } from '../../utils/toolTrace';

import { ChangeFileTree } from './ChangeFileTree';
import { useChangesUi } from './ChangesUiContext';
import { FilePreview, type PreviewFile } from './FilePreview';
import styles from './SessionWorkspace.module.css';

type Tab = 'files' | 'git';

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
  const [tab, setTab] = useState<Tab>('files');
  const [git, setGit] = useState<GitDiffResult | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [badgePulse, setBadgePulse] = useState(false);
  const [diskTree, setDiskTree] = useState<WorkspaceTreeNode[]>([]);
  const [diskBusy, setDiskBusy] = useState(false);
  const [diskErr, setDiskErr] = useState<string | null>(null);
  const [openDiskPaths, setOpenDiskPaths] = useState<string[]>([]);
  const prevCount = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const { workbench, closeWorkbench, openDetail, openWorkbench } = useChangesUi();

  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const summary = useMemo(() => summarizeChanges(changes), [changes]);
  const changeByFile = useMemo(() => new Map(changes.map((c) => [c.file, c])), [changes]);
  const tree = useMemo(() => mergeWorkspaceAndChanges(diskTree, changes), [diskTree, changes]);
  const project = projectNameFromCwd(cwd);

  const refreshDisk = useCallback(async () => {
    if (!cwd) {
      setDiskTree([]);
      setDiskErr(null);
      return;
    }
    setDiskBusy(true);
    try {
      const r = await harnessClient.workspaceList(cwd);
      if (!r.ok) {
        setDiskTree([]);
        setDiskErr(r.error || t('读取失败'));
        return;
      }
      setDiskTree(r.entries ?? []);
      setDiskErr(null);
    } catch (e) {
      setDiskTree([]);
      setDiskErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiskBusy(false);
    }
  }, [cwd]);

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
    void refreshDisk();
  }, [refreshDisk]);

  useEffect(() => {
    if (changes.length > prevCount.current) {
      setTab('files');
      setBadgePulse(true);
      const tmr = window.setTimeout(() => setBadgePulse(false), 1200);
      prevCount.current = changes.length;
      return () => clearTimeout(tmr);
    }
    prevCount.current = changes.length;
  }, [changes.length]);

  /** 摘要卡「查看变更」→ 中栏 Diff + 右栏高亮文件 */
  useEffect(() => {
    if (!workbench) return;
    setTab('files');
    setFilter('');
    const file = workbench.file ?? workbench.entries?.[0]?.file ?? changes[0]?.file ?? null;
    if (file) {
      setSelectedFile(file);
      setPreviewKey(`c:${file}`);
    }
    panelRef.current?.focus({ preventScroll: true });
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
    if (tab === 'git') {
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
    }
    const fromChanges = changes.map((c) => ({
      key: `c:${c.file}`,
      path: c.file,
      letter: c.letter,
      added: c.added,
      removed: c.removed,
      change: c,
    }));
    const extra = openDiskPaths
      .filter((p) => !changeByFile.has(p))
      .map((p) => ({ key: `d:${p}`, path: p }));
    return [...fromChanges, ...extra];
  }, [tab, changes, gitFiles, gitDiffByPath, openDiskPaths, changeByFile]);

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
        } else if (workbench) {
          closeWorkbench();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewKey, workbench, closeWorkbench]);

  if (!changes.length && !cwd) return null;

  const gitErrorFriendly = (() => {
    if (!git || git.ok) return null;
    if (isNotGitRepoError(git.error)) return t('当前目录不是 Git 仓库');
    return git.error || t('无法读取 git 状态');
  })();

  const pickFile = (file: string) => {
    setSelectedFile(file);
    const c = changeByFile.get(file);
    if (c) {
      setPreviewKey(`c:${file}`);
      openWorkbench({
        file,
        messageId: c.messageId,
        entries: changes,
        sourceLabel: t('上一轮'),
      });
    } else {
      setPreviewKey(`d:${file}`);
      setOpenDiskPaths((prev) => (prev.includes(file) ? prev : [...prev, file]));
      // 无 diff 的磁盘文件：仍打开中栏范围（会话全部），便于对照
      if (changes.length) {
        openWorkbench({ file, entries: changes, sourceLabel: t('全部') });
      }
    }
  };

  const openFullscreen = () =>
    openDetail({
      entries: changes,
      file: selectedFile ?? changes[0]?.file,
      sourceLabel: t('全部'),
      messageId: changes[0]?.messageId,
    });

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      data-testid="session-changes-panel"
      data-rail={rail || undefined}
      data-focused={workbench ? 'true' : undefined}
      data-layout="tree"
      tabIndex={-1}
    >
      <header className={styles.panelHead}>
        <div className={styles.railTitleRow}>
          <span className={styles.railTitle} title={cwd || undefined}>
            {rail ? project : t('工作区')}
          </span>
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
          <span className={styles.wbSpacer} />
          {rail ? (
            <button
              type="button"
              className={styles.fullscreenBtn}
              data-testid="rail-open-fullscreen"
              title={t('全屏审查')}
              aria-label={t('全屏审查')}
              onClick={openFullscreen}
            >
              <Expand size={14} />
              <span>{t('全屏审查')}</span>
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
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'files'}
            className={styles.tab}
            data-active={tab === 'files' || undefined}
            data-testid="rail-tab-files"
            onClick={() => setTab('files')}
          >
            <FolderTree size={12} />
            {t('文件')}
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
            {t('变更')}
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
          ) : (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => void refreshDisk()}
              disabled={diskBusy}
              aria-label={t('刷新')}
              title={t('刷新')}
              data-testid="files-rail-refresh"
            >
              <RefreshCw size={12} className={diskBusy ? styles.spin : undefined} />
            </button>
          )}
        </div>
      </header>

      {tab === 'files' && (
        <div className={styles.railBody} data-testid="changes-list" data-layout="tree">
          <div
            className={styles.railTreePane}
            data-testid="rail-tree-pane"
            style={{ flex: '1 1 auto', minWidth: 0 }}
          >
            <label className={styles.wbFilter}>
              <Search size={12} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('筛选文件…')}
                data-testid="files-rail-filter"
              />
            </label>
            <div className={styles.wbTreeHead}>
              {t('已更改的文件')}
              {diskBusy ? ` · ${t('读取中…')}` : null}
            </div>
            {diskErr ? (
              <p className={styles.empty} data-testid="files-rail-disk-error">
                {diskErr}
              </p>
            ) : !diskTree.length && !changes.length && !diskBusy ? (
              <p className={styles.empty}>{cwd ? t('工作区为空') : t('当前会话没有工作目录')}</p>
            ) : (
              <div className={styles.railTree} data-testid="files-rail-tree">
                <ChangeFileTree
                  nodes={tree}
                  active={selectedFile}
                  onPick={pickFile}
                  filter={filter}
                  testIdPrefix="rail"
                  messageIdByFile={Object.fromEntries(changes.map((c) => [c.file, c.messageId]))}
                  onLocate={(_file, messageId) => {
                    if (messageId) locateChangeMessage(messageId);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'git' && (
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
              {previewKey && previewFiles.length > 0 ? (
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
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
};
