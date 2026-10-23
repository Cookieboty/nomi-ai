/** Codex 右栏：「变更 · 未提交 · 文件」三视图，默认本会话变更树（筛选、+/−、蓝点）；中栏 Diff 见 CenterChangesHost */
import { t } from '@nomi-ai/ui';
import { Expand, FolderTree, GitBranch, PanelRightClose, RefreshCw, Search } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  buildChangeFileTree,
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
import pane from './WorkspacePane.module.css';

type Tab = 'files' | 'git';
/** 文件 Tab 内：默认已更改列表；工作区全树为次要 */
type FilesMode = 'changed' | 'workspace';

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
      <span className={pane.gitName} title={entry.path}>
        {entry.path.split('/').pop()}
      </span>
      <span className={pane.gitDir} aria-hidden>
        {entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''}
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
  /** 收起右栏（与顶栏开关同一状态） */
  onClose?: () => void;
}> = ({ messages, cwd, rail = false, onClose }) => {
  const [tab, setTab] = useState<Tab>('files');
  const [filesMode, setFilesMode] = useState<FilesMode>('changed');
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
  const { workbench, closeWorkbench, openDetail, openWorkbench, setPreviewOpen, previewSlot } =
    useChangesUi();

  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const summary = useMemo(() => summarizeChanges(changes), [changes]);
  const changeByFile = useMemo(() => new Map(changes.map((c) => [c.file, c])), [changes]);
  const changedTree = useMemo(
    () => buildChangeFileTree(changes, { cwd, compact: true }),
    [changes, cwd],
  );
  const workspaceTree = useMemo(
    () => mergeWorkspaceAndChanges(diskTree, changes, cwd),
    [diskTree, changes, cwd],
  );
  const tree = filesMode === 'changed' ? changedTree : workspaceTree;
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
    if (filesMode === 'workspace') void refreshDisk();
  }, [refreshDisk, filesMode]);

  useEffect(() => {
    if (changes.length > prevCount.current) {
      setTab('files');
      setFilesMode('changed');
      setBadgePulse(true);
      const tmr = window.setTimeout(() => setBadgePulse(false), 1200);
      prevCount.current = changes.length;
      return () => clearTimeout(tmr);
    }
    prevCount.current = changes.length;
  }, [changes.length]);

  // 未提交 / 磁盘文件的预览显示在中栏（右栏只导航）；本会话变更走 workbench
  const previewing =
    !!previewKey && (tab === 'git' ? previewKey.startsWith('g:') : previewKey.startsWith('d:'));
  useEffect(() => {
    setPreviewOpen(previewing);
  }, [previewing, setPreviewOpen]);
  useEffect(() => () => setPreviewOpen(false), [setPreviewOpen]);

  /** 摘要卡「查看变更」→ 中栏 Diff + 右栏高亮文件；右栏保持「已更改」模式 */
  useEffect(() => {
    if (!workbench) return;
    setTab('files');
    setFilesMode('changed');
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
      // 没改过的文件：在中栏看内容（与本会话 Diff 互斥）
      setPreviewKey(`d:${file}`);
      setOpenDiskPaths((prev) => (prev.includes(file) ? prev : [...prev, file]));
      closeWorkbench();
    }
  };

  const openFullscreen = () =>
    openDetail({
      entries: changes,
      file: selectedFile ?? changes[0]?.file,
      sourceLabel: t('全部'),
      messageId: changes[0]?.messageId,
    });

  // 中栏预览只在同一来源（未提交 g: / 磁盘 d:）的文件间前后切换
  const portalFiles = previewKey
    ? previewFiles.filter((f) => f.key[0] === previewKey[0])
    : previewFiles;
  const changedActive = tab === 'files' && filesMode === 'changed';
  const workspaceActive = tab === 'files' && filesMode === 'workspace';
  const openWorkspace = () => {
    setTab('files');
    setFilesMode('workspace');
    void refreshDisk();
  };
  // 只有真有树可筛时才显示筛选框
  const showFilter = changedActive
    ? changes.length > 0
    : !diskErr && (diskTree.length > 0 || changes.length > 0);

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      data-testid="session-changes-panel"
      data-rail={rail || undefined}
      data-focused={workbench ? 'true' : undefined}
      data-layout="tree"
      data-files-mode={tab === 'files' ? filesMode : undefined}
      tabIndex={-1}
    >
      {/* 一行：左侧「变更 · 未提交 · 文件」分段，右侧统计与操作；与 ChatHeader 同高 */}
      <header className={styles.panelHead}>
        <div className={pane.seg} role="tablist" aria-label={t('变更栏视图')}>
          <button
            type="button"
            role="tab"
            aria-selected={changedActive}
            className={pane.segBtn}
            data-active={changedActive || undefined}
            data-testid="rail-tab-files"
            title={t('本会话里助手改过的文件')}
            onClick={() => {
              setTab('files');
              setFilesMode('changed');
            }}
          >
            {t('变更')}
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
            className={pane.segBtn}
            data-active={tab === 'git' || undefined}
            data-testid="rail-tab-git"
            title={t('相对 HEAD · 工作区变更（含未跟踪）')}
            onClick={openGit}
          >
            {t('未提交')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceActive}
            className={pane.segBtn}
            data-active={workspaceActive || undefined}
            data-testid="rail-tab-workspace"
            title={cwd ? `${project} · ${cwd}` : undefined}
            onClick={openWorkspace}
          >
            {t('文件')}
          </button>
        </div>
        <span className={styles.wbSpacer} />
        {summary.files > 0 && changedActive ? (
          <span
            className={`${styles.summary} ${pane.railSummary}`}
            data-pulse={badgePulse || undefined}
            data-testid="changes-summary"
          >
            <span className={styles.add}>+{summary.added}</span>{' '}
            <span className={styles.del}>−{summary.removed}</span>
          </span>
        ) : null}
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
            <RefreshCw size={14} className={gitBusy ? styles.spin : undefined} />
          </button>
        ) : workspaceActive ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => void refreshDisk()}
            disabled={diskBusy}
            aria-label={t('刷新')}
            title={t('刷新')}
            data-testid="files-rail-refresh"
          >
            <RefreshCw size={14} className={diskBusy ? styles.spin : undefined} />
          </button>
        ) : null}
        {rail && changes.length > 0 ? (
          <button
            type="button"
            className={styles.iconBtn}
            data-testid="rail-open-fullscreen"
            title={t('全屏审查')}
            aria-label={t('全屏审查')}
            onClick={openFullscreen}
          >
            <Expand size={14} />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('收起变更栏')}
            title={t('收起变更栏')}
            data-testid="files-rail-close"
            onClick={onClose}
          >
            <PanelRightClose size={14} />
          </button>
        ) : null}
      </header>

      {tab === 'files' && (
        <div className={styles.railBody} data-testid="changes-list" data-layout="tree">
          <div
            className={styles.railTreePane}
            data-testid="rail-tree-pane"
            style={{ flex: '1 1 auto', minWidth: 0, borderLeft: 'none' }}
          >
            {showFilter ? (
              <label className={styles.wbFilter}>
                <Search size={12} />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('筛选文件…')}
                  aria-label={t('筛选文件…')}
                  data-testid="files-rail-filter"
                />
              </label>
            ) : null}
            {filesMode === 'workspace' && diskErr ? (
              <p className={styles.empty} data-testid="files-rail-disk-error">
                {diskErr}
              </p>
            ) : filesMode === 'changed' && !changes.length ? (
              <div className={pane.empty} data-testid="files-rail-no-changes">
                <p>{t('本会话尚无文件变更')}</p>
                {cwd ? (
                  <div className={pane.emptyActions}>
                    <button type="button" className={pane.link} onClick={openGit}>
                      <GitBranch size={12} />
                      {t('查看未提交的改动')}
                    </button>
                    <button type="button" className={pane.link} onClick={openWorkspace}>
                      <FolderTree size={12} />
                      {t('浏览工作区文件')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : filesMode === 'workspace' && !diskTree.length && !changes.length && !diskBusy ? (
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
                        closeWorkbench();
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
      {previewing && previewSlot && portalFiles.length > 0
        ? createPortal(
            <FilePreview
              hideFileTabs
              files={portalFiles}
              activeKey={previewKey!}
              cwd={cwd}
              onActiveKey={setPreviewKey}
              onClose={() => setPreviewKey(null)}
              onSaved={() => {
                if (tab === 'git') void refreshGit();
              }}
            />,
            previewSlot,
          )
        : null}
    </section>
  );
};
