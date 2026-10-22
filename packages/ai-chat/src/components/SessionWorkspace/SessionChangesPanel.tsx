/** Codex 风格右侧工作区：横排「Diff/预览 | 文件树」；外层与 chat 分割见 App */
import { t } from '@nomi-ai/ui';
import {
  Columns2,
  Expand,
  FileCode2,
  FileDiff,
  FolderTree,
  GitBranch,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
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
/** 右栏内：仅预览 | 仅文件树 | 左右双栏（Diff | 文件） */
type RailLayout = 'preview' | 'workspace' | 'both';

const RAIL_LAYOUT_KEY = 'nomi.filesRailLayout';
const INNER_TREE_W_KEY = 'nomi.filesRailTreeWidth';
const INNER_TREE_DEFAULT = 168;
const INNER_TREE_MIN = 120;
const INNER_TREE_MAX = 280;

function readLayout(): RailLayout {
  try {
    const v = localStorage.getItem(RAIL_LAYOUT_KEY);
    if (v === 'preview' || v === 'workspace' || v === 'both') return v;
  } catch {
    /* ignore */
  }
  return 'both';
}

function readTreeWidth(): number {
  try {
    const n = Number(localStorage.getItem(INNER_TREE_W_KEY));
    if (Number.isFinite(n))
      return Math.min(INNER_TREE_MAX, Math.max(INNER_TREE_MIN, Math.round(n)));
  } catch {
    /* ignore */
  }
  return INNER_TREE_DEFAULT;
}

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
  const [railLayout, setRailLayout] = useState<RailLayout>(readLayout);
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
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
  const { workbench, closeWorkbench, openDetail } = useChangesUi();

  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const summary = useMemo(() => summarizeChanges(changes), [changes]);
  const changeByFile = useMemo(() => new Map(changes.map((c) => [c.file, c])), [changes]);
  const tree = useMemo(() => mergeWorkspaceAndChanges(diskTree, changes), [diskTree, changes]);
  const project = projectNameFromCwd(cwd);

  const setLayoutPersist = useCallback((next: RailLayout) => {
    setRailLayout(next);
    try {
      localStorage.setItem(RAIL_LAYOUT_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

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

  /** 摘要卡「查看变更」→ 聚焦本右栏，不另开全屏三栏 */
  useEffect(() => {
    if (!workbench) return;
    setTab('files');
    setFilter('');
    if (railLayout === 'workspace') setLayoutPersist('both');
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

  const onInnerSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      // 树在右侧：向左拖 → 树变宽
      const next = Math.min(
        INNER_TREE_MAX,
        Math.max(INNER_TREE_MIN, startW + (startX - ev.clientX)),
      );
      setTreeWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setTreeWidth((w) => {
        try {
          localStorage.setItem(INNER_TREE_W_KEY, String(w));
        } catch {
          /* ignore */
        }
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
    } else {
      setPreviewKey(`d:${file}`);
      setOpenDiskPaths((prev) => (prev.includes(file) ? prev : [...prev, file]));
    }
    if (railLayout === 'workspace') setLayoutPersist('both');
  };

  const openFullscreen = () =>
    openDetail({
      entries: changes,
      file: selectedFile ?? changes[0]?.file,
      sourceLabel: t('全部'),
      messageId: changes[0]?.messageId,
    });

  const showPreviewPane = tab === 'files' && (railLayout === 'preview' || railLayout === 'both');
  const showTreePane = tab === 'files' && (railLayout === 'workspace' || railLayout === 'both');

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      data-testid="session-changes-panel"
      data-rail={rail || undefined}
      data-focused={workbench ? 'true' : undefined}
      data-layout={tab === 'files' ? railLayout : undefined}
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
            {t('工作区')}
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
        {tab === 'files' ? (
          <div className={styles.seg} role="group" aria-label={t('工作区布局')}>
            <button
              type="button"
              className={styles.segBtn}
              data-active={railLayout === 'preview' || undefined}
              data-testid="rail-layout-preview"
              title={t('预览区')}
              onClick={() => setLayoutPersist('preview')}
            >
              <FileDiff size={12} />
              {t('预览区')}
            </button>
            <button
              type="button"
              className={styles.segBtn}
              data-active={railLayout === 'workspace' || undefined}
              data-testid="rail-layout-workspace"
              title={t('工作区')}
              onClick={() => setLayoutPersist('workspace')}
            >
              <FileCode2 size={12} />
              {t('文件树')}
            </button>
            <button
              type="button"
              className={styles.segBtn}
              data-active={railLayout === 'both' || undefined}
              data-testid="rail-layout-both"
              title={t('左右分栏')}
              onClick={() => setLayoutPersist('both')}
            >
              <Columns2 size={12} />
              {t('左右分栏')}
            </button>
          </div>
        ) : null}
      </header>

      {tab === 'files' && (
        <div className={styles.railBody} data-testid="changes-list" data-layout={railLayout}>
          {showPreviewPane ? (
            <div
              className={styles.railPreviewPane}
              data-testid="rail-preview-pane"
              style={
                railLayout === 'both'
                  ? { flex: '1 1 auto', minWidth: 0 }
                  : { flex: '1 1 auto', minWidth: 0 }
              }
            >
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
                    void refreshDisk();
                  }}
                />
              ) : (
                <p className={styles.empty}>{t('选择文件以预览 Diff 或内容')}</p>
              )}
            </div>
          ) : null}

          {railLayout === 'both' ? (
            <div
              className={styles.railInnerSplitter}
              data-testid="files-rail-inner-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={treeWidth}
              onPointerDown={onInnerSplitterDown}
              onDoubleClick={() => {
                setTreeWidth(INNER_TREE_DEFAULT);
                try {
                  localStorage.setItem(INNER_TREE_W_KEY, String(INNER_TREE_DEFAULT));
                } catch {
                  /* ignore */
                }
              }}
              title={t('拖动调整预览与文件树宽度；双击恢复默认')}
            />
          ) : null}

          {showTreePane ? (
            <div
              className={styles.railTreePane}
              data-testid="rail-tree-pane"
              style={
                railLayout === 'both'
                  ? { width: treeWidth, flex: `0 0 ${treeWidth}px` }
                  : { flex: '1 1 auto', minWidth: 0 }
              }
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
                {t('工作区文件')}
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
          ) : null}
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
