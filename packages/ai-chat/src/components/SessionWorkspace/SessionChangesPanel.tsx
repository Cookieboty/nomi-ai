/**
 * Codex 右栏：「改动 · 文件」两视图。
 * 改动：git 仓库里以 `git status` / `git diff` 为准，本会话助手改过的文件带标记；
 * 不是 git 仓库（或读不到）时退回本会话变更树。中栏 Diff 见 CenterChangesHost。
 */
import { Select, t } from '@nomi-ai/ui';
import {
  Bot,
  Expand,
  FolderGit2,
  FolderTree,
  GitBranch,
  LocateFixed,
  Minus,
  PanelRightClose,
  Plus,
  RotateCcw,
  RefreshCw,
  Search,
} from 'lucide-react';
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useGitBranch } from '../../hooks/useGitBranch';
import { useGitSync, useGitWorktrees } from '../../hooks/useGitSync';
import {
  harnessClient,
  type GitDiffResult,
  type WorkspaceTreeNode,
} from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { buildCommitPrompt } from '../../utils/commitPrompt';
import {
  isNotGitRepoError,
  parseGitStatus,
  splitUnifiedDiff,
  type GitFileEntry,
  type ParsedDiffFile,
} from '../../utils/gitStatusParse';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import { parsePatch } from '../../utils/lineDiff';
import {
  aggregateSessionChanges,
  buildChangeFileTree,
  locateChangeMessage,
  mergeWorkspaceAndChanges,
  projectNameFromCwd,
  summarizeChanges,
  type ChangeEntry,
} from '../../utils/sessionChanges';
import type { FileDiff as ToolFileDiff } from '../../utils/toolTrace';
import { workspaceRelPath } from '../../utils/workspacePath';
import { editsElsewhere, samePath, worktreeLabel } from '../../utils/worktrees';

import { ChangeFileTree } from './ChangeFileTree';
import { useChangesUi } from './ChangesUiContext';
import { FilePreview, type PreviewFile } from './FilePreview';
import { GitCommitBox, GitSyncButtons, useGitOps } from './GitCommitBox';
import styles from './SessionWorkspace.module.css';
import pane from './WorkspacePane.module.css';

/** 自动触发的 git diff 刷新合并窗口 */
const GIT_REFRESH_DEBOUNCE_MS = 300;

type View = 'changes' | 'workspace';

const relOf = (cwd: string | null | undefined, file: string) =>
  workspaceRelPath(cwd, file).replace(/\\/g, '/').replace(/^\.\//, '');

type GitArea = 'staged' | 'unstaged';

/** 一个文件在某个区（已暂存 / 未暂存）里的一行；部分暂存的文件两区各一行 */
interface GitItem {
  entry: GitFileEntry;
  area: GitArea;
  letter: GitFileEntry['letter'];
  diff?: ParsedDiffFile;
  /** 增删行数：numstat 优先（diff 文本过大被截断时也完整），没有时取解析出的 diff */
  added?: number;
  removed?: number;
  key: string;
}

const GitRow: React.FC<{
  entry: GitFileEntry;
  letter: GitFileEntry['letter'];
  area: GitArea;
  added?: number;
  removed?: number;
  /** 本会话助手改过这个文件 */
  session?: ChangeEntry;
  selected: boolean;
  onSelect: () => void;
  /** 暂存（未暂存区）/ 取消暂存（已暂存区）；没有时不显示按钮 */
  onStage?: () => void;
  stageDisabled?: boolean;
  /** 放弃未暂存的改动（只在未暂存区） */
  onDiscard?: () => void;
}> = ({
  entry,
  letter,
  area,
  added,
  removed,
  session,
  selected,
  onSelect,
  onStage,
  stageDisabled,
  onDiscard,
}) => (
  <div
    className={styles.row}
    data-testid="git-row"
    data-area={area}
    data-selected={selected || undefined}
    data-session={session ? true : undefined}
    data-file={entry.path}
  >
    <button type="button" className={styles.rowHead} onClick={onSelect}>
      <span className={styles.letter} data-letter={letter} title={`${entry.index}${entry.work}`}>
        {letter}
      </span>
      <span className={pane.gitName} title={entry.path}>
        {entry.path.split('/').pop()}
      </span>
      <span className={pane.gitDir} aria-hidden>
        {entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''}
      </span>
      {session ? (
        <span
          className={pane.sessionMark}
          title={t('ui.session-workspace.edited-by-the-assistant-in-this-session')}
          aria-label={t('ui.session-workspace.edited-by-the-assistant-in-this-session')}
          data-testid="git-row-session"
        >
          <Bot size={12} />
        </span>
      ) : null}
      {entry.untracked ? (
        <span className={styles.badge}>{t('ui.session-workspace.untracked')}</span>
      ) : null}
      {(added != null || removed != null) && (
        <span className={styles.stat}>
          {added != null ? <span className={styles.add}>+{added}</span> : null}
          {removed != null ? <span className={styles.del}>−{removed}</span> : null}
        </span>
      )}
    </button>
    {session?.messageId ? (
      <button
        type="button"
        className={styles.iconBtn}
        data-testid="change-locate"
        title={t('ui.session-workspace.show-in-conversation')}
        aria-label={t('ui.session-workspace.show-in-conversation')}
        onClick={() => locateChangeMessage(session.messageId)}
      >
        <LocateFixed size={12} />
      </button>
    ) : null}
    {onDiscard ? (
      <button
        type="button"
        className={`${styles.iconBtn} ${pane.stageBtn}`}
        data-testid="git-row-discard"
        disabled={stageDisabled}
        title={t('ui.session-workspace.discard-changes')}
        aria-label={`${t('ui.session-workspace.discard-changes')} ${entry.path}`}
        onClick={onDiscard}
      >
        <RotateCcw size={12} />
      </button>
    ) : null}
    {onStage ? (
      <button
        type="button"
        className={`${styles.iconBtn} ${pane.stageBtn}`}
        data-testid={area === 'staged' ? 'git-row-unstage' : 'git-row-stage'}
        disabled={stageDisabled}
        title={
          area === 'staged' ? t('ui.session-workspace.unstage') : t('ui.session-workspace.stage')
        }
        aria-label={`${
          area === 'staged' ? t('ui.session-workspace.unstage') : t('ui.session-workspace.stage')
        } ${entry.path}`}
        onClick={onStage}
      >
        {area === 'staged' ? <Minus size={12} /> : <Plus size={12} />}
      </button>
    ) : null}
  </div>
);

/** 取消暂存时改名的旧路径也要一起，否则旧路径的删除还留在暂存区 */
const stagePaths = (rows: readonly GitItem[], area: GitArea) => [
  ...new Set(
    rows.flatMap((r) =>
      area === 'staged' && r.entry.from ? [r.entry.path, r.entry.from] : [r.entry.path],
    ),
  ),
];

export const SessionChangesPanel: React.FC<{
  messages: readonly ConvMessage[];
  cwd?: string | null;
  /** 整页右栏全高模式 */
  rail?: boolean;
  /** 当前标签正在跑：跑完后自动刷新 git 状态 */
  busy?: boolean;
  /** 收起右栏（与顶栏开关同一状态） */
  onClose?: () => void;
}> = ({ messages, cwd, rail = false, busy = false, onClose }) => {
  const [view, setView] = useState<View>('changes');
  const [git, setGit] = useState<GitDiffResult | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [onlySession, setOnlySession] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** 全树可能有上万个文件：过滤用延迟值，输入框不被整树重渲染卡住 */
  const treeFilter = useDeferredValue(filter);
  const [badgePulse, setBadgePulse] = useState(false);
  const [diskTree, setDiskTree] = useState<WorkspaceTreeNode[]>([]);
  const [diskBusy, setDiskBusy] = useState(false);
  const [diskErr, setDiskErr] = useState<string | null>(null);
  const [openDiskPaths, setOpenDiskPaths] = useState<string[]>([]);
  /** 手动刷新时连同分支一起重读 */
  const [branchNonce, setBranchNonce] = useState(0);
  /** 切到同一仓库的另一个 worktree 看改动（null = 标签自己的目录）；换目录时回到标签目录 */
  const [wtCwd, setWtCwd] = useState<string | null>(null);
  const [wtFor, setWtFor] = useState(cwd);
  if (wtFor !== cwd) {
    setWtFor(cwd);
    setWtCwd(null);
  }
  /** 改动 / 提交 / 同步针对的目录 */
  const gitCwd = wtCwd ?? cwd;
  const worktreeList = useGitWorktrees(cwd, busy, branchNonce);
  const worktrees = useMemo(() => worktreeList?.worktrees ?? [], [worktreeList]);
  const branch = useGitBranch(gitCwd, busy, branchNonce);
  const sync = useGitSync(gitCwd, busy, branchNonce);
  const prevCount = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const {
    workbench,
    closeWorkbench,
    openDetail,
    openWorkbench,
    setPreviewOpen,
    previewSlot,
    fillComposer,
  } = useChangesUi();

  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const changeByFile = useMemo(() => new Map(changes.map((c) => [c.file, c])), [changes]);
  /** git 给的是相对 cwd 的路径，工具调用里多是绝对路径：统一换成相对路径再对 */
  const changeByRel = useMemo(
    () => new Map(changes.map((c) => [relOf(gitCwd, c.file), c])),
    [changes, gitCwd],
  );
  const changedTree = useMemo(
    () => buildChangeFileTree(changes, { cwd, compact: true }),
    [changes, cwd],
  );
  const workspaceTree = useMemo(
    () => mergeWorkspaceAndChanges(diskTree, changes, cwd),
    [diskTree, changes, cwd],
  );
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
        setDiskErr(r.error || t('ui.slash-commands.failed-to-read'));
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

  // 只认最后一次请求的结果（换目录时旧请求晚到不覆盖）
  const gitReq = useRef(0);
  const refreshGit = useCallback(async () => {
    const id = ++gitReq.current;
    if (!gitCwd) {
      setGit(null);
      return;
    }
    setGitBusy(true);
    let next: GitDiffResult;
    try {
      next = await harnessClient.gitDiff(gitCwd);
    } catch (e) {
      next = {
        ok: false,
        status: '',
        stat: '',
        diff: '',
        truncated: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (id !== gitReq.current) return;
    setGit(next);
    setGitBusy(false);
  }, [gitCwd]);

  const refreshAll = useCallback(() => {
    setBranchNonce((n) => n + 1);
    void refreshGit();
  }, [refreshGit]);
  const ops = useGitOps(gitCwd, refreshAll);

  // 换目录：立即刷新。助手又改了文件、一轮跑完、窗口重新拿到焦点：常在同一刻接连发生
  // （一轮结束时新消息落地 + busy 下降沿），合并成一次 git diff
  useEffect(() => setGit(null), [gitCwd]);
  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);
  const gitTimer = useRef(0);
  const scheduleGit = useCallback(() => {
    window.clearTimeout(gitTimer.current);
    gitTimer.current = window.setTimeout(() => void refreshGit(), GIT_REFRESH_DEBOUNCE_MS);
  }, [refreshGit]);
  useEffect(() => () => window.clearTimeout(gitTimer.current), []);
  const prevChangeCount = useRef(changes.length);
  useEffect(() => {
    if (prevChangeCount.current === changes.length) return;
    prevChangeCount.current = changes.length;
    scheduleGit();
  }, [changes.length, scheduleGit]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) scheduleGit();
    wasBusy.current = busy;
  }, [busy, scheduleGit]);
  useEffect(() => {
    window.addEventListener('focus', scheduleGit);
    return () => window.removeEventListener('focus', scheduleGit);
  }, [scheduleGit]);

  useEffect(() => {
    if (view === 'workspace') void refreshDisk();
  }, [refreshDisk, view]);

  useEffect(() => {
    if (changes.length > prevCount.current) {
      setView('changes');
      setBadgePulse(true);
      const tmr = window.setTimeout(() => setBadgePulse(false), 1200);
      prevCount.current = changes.length;
      return () => clearTimeout(tmr);
    }
    prevCount.current = changes.length;
  }, [changes.length]);

  const gitReady = git?.ok === true;
  /** 改动视图的数据源：git 仓库用 git，否则退回本会话变更 */
  const source: 'git' | 'session' | 'loading' = gitReady
    ? 'git'
    : cwd && !git
      ? 'loading'
      : 'session';

  const gitFiles = useMemo(() => parseGitStatus(git?.status ?? ''), [git?.status]);
  const gitDiffs = useMemo(() => splitUnifiedDiff(git?.diff ?? ''), [git?.diff]);
  /** 每个区各自的 diff；老版本主进程没有分开给时退回相对 HEAD 的整份 */
  const gitItems = useMemo(() => {
    const byPath = (raw: string | undefined) => {
      const m = new Map<string, ParsedDiffFile>();
      for (const d of raw == null ? gitDiffs : splitUnifiedDiff(raw)) m.set(d.file, d);
      return m;
    };
    const staged = byPath(git?.staged);
    const unstaged = byPath(git?.unstaged);
    const ns = git?.numstat;
    const counts = (n: { added: number; removed: number } | undefined, d?: ParsedDiffFile) =>
      n ? { added: n.added, removed: n.removed } : { added: d?.added, removed: d?.removed };
    const out: GitItem[] = [];
    for (const g of gitFiles) {
      if (g.staged) {
        const diff = staged.get(g.path);
        out.push({
          entry: g,
          area: 'staged',
          letter: g.index,
          diff,
          ...counts(ns?.staged[g.path], diff),
          key: `g:s:${g.path}`,
        });
      }
      if (g.unstaged) {
        const letter = g.untracked ? '?' : g.work;
        const diff = unstaged.get(g.path);
        out.push({
          entry: g,
          area: 'unstaged',
          letter,
          diff,
          ...counts(ns?.unstaged[g.path], diff),
          key: `g:u:${g.path}`,
        });
      }
    }
    return out;
  }, [gitFiles, gitDiffs, git?.staged, git?.unstaged, git?.numstat]);
  const sessionInGit = useMemo(
    () => gitFiles.filter((g) => changeByRel.has(g.path)).length,
    [gitFiles, changeByRel],
  );
  const q = filter.trim().toLowerCase();
  const gitRows = useMemo(
    () =>
      gitItems.filter(
        ({ entry: g }) =>
          (!onlySession || changeByRel.has(g.path)) && (!q || g.path.toLowerCase().includes(q)),
      ),
    [gitItems, onlySession, changeByRel, q],
  );
  const stagedRows = gitRows.filter((r) => r.area === 'staged');
  const unstagedRows = gitRows.filter((r) => r.area === 'unstaged');

  const summary = useMemo(() => {
    if (source !== 'git') return summarizeChanges(changes);
    let added = 0;
    let removed = 0;
    // 合计也用 numstat（diff 文本被截断时只能算出前半截）
    for (const d of git?.numstat ? Object.values(git.numstat.head) : gitDiffs) {
      added += d.added;
      removed += d.removed;
    }
    return { files: gitFiles.length, added, removed };
  }, [source, changes, gitDiffs, gitFiles.length, git?.numstat]);

  // 未提交 / 磁盘文件的预览显示在中栏（右栏只导航）；本会话变更走 workbench
  const previewing =
    !!previewKey &&
    (view === 'changes'
      ? source === 'git' && previewKey.startsWith('g:')
      : previewKey.startsWith('d:'));
  useEffect(() => {
    setPreviewOpen(previewing);
  }, [previewing, setPreviewOpen]);
  useEffect(() => () => setPreviewOpen(false), [setPreviewOpen]);

  /** 摘要卡「查看变更」→ 中栏 Diff + 右栏高亮文件 */
  useEffect(() => {
    if (!workbench) return;
    setView('changes');
    setFilter('');
    const file = workbench.file ?? workbench.entries?.[0]?.file ?? changes[0]?.file ?? null;
    if (file) {
      setSelectedFile(file);
      setPreviewKey(`c:${file}`);
    }
    panelRef.current?.focus({ preventScroll: true });
  }, [workbench]); // eslint-disable-line react-hooks/exhaustive-deps -- focus on open only

  const previewFiles: PreviewFile[] = useMemo(() => {
    if (view === 'changes' && source === 'git') {
      return gitItems.map(({ entry: g, letter, diff: d, added, removed, key }) => {
        const gitDiff: ToolFileDiff | undefined = d
          ? { file: d.file, diff: parsePatch(d.body) }
          : undefined;
        return { key, path: g.path, letter, added, removed, gitDiff };
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
  }, [view, source, changes, gitItems, openDiskPaths, changeByFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        !panelRef.current?.contains(document.activeElement) &&
        document.activeElement !== panelRef.current
      ) {
        if (!previewKey && !workbench) return;
      }
      if (e.key === 'Escape') {
        // 聊天输入框等面板外的输入控件里按 Esc 不关预览 / 中栏 Diff；预览里的编辑框仍算自己人
        if (
          shouldIgnoreEscape(
            e,
            (tg) =>
              !!panelRef.current?.contains(tg as Node) ||
              !!(tg as Element | null)?.closest?.('[data-testid="file-preview"]'),
          )
        )
          return;
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

  const gitNote = (() => {
    if (!git || git.ok || isNotGitRepoError(git.error)) return null;
    return git.error || t('ui.session-workspace.could-not-read-git-status');
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
        sourceLabel: t('ui.session-workspace.last-turn'),
      });
    } else {
      // 没改过的文件：在中栏看内容（与本会话 Diff 互斥）
      setPreviewKey(`d:${file}`);
      setOpenDiskPaths((prev) => (prev.includes(file) ? prev : [...prev, file]));
      closeWorkbench();
    }
  };

  const pickGit = (item: GitItem) => {
    setSelectedFile(item.entry.path);
    setPreviewKey(item.key);
    closeWorkbench();
  };

  const openFullscreen = () =>
    openDetail({
      entries: changes,
      file: selectedFile ?? changes[0]?.file,
      sourceLabel: t('ui.providers-schedule.all'),
      messageId: changes[0]?.messageId,
    });

  /** 「提交」与「让助手提交」针对的文件：有过滤 / 只看本会话时是过滤后的 */
  const pickedRows = onlySession || q ? gitRows : gitItems;
  const stagedCount = gitFiles.filter((g) => g.staged).length;
  const commitPaths = [...new Set(pickedRows.map((r) => r.entry.path))];

  /** 交给当前助手提交：只填进输入框，用户看过再发 */
  const askCommit = (push: boolean) => {
    const paths = new Set(commitPaths);
    const files = gitFiles
      .filter((g) => paths.has(g.path))
      .map((g) => ({ path: g.path, staged: g.staged, unstaged: g.unstaged }));
    if (files.length) fillComposer(buildCommitPrompt(files, push, wtCwd ?? undefined));
  };

  // worktree：正在看的那个（标签目录所在的，或切过去的）；助手改的文件落在别的 worktree 时提示
  const liveWorktrees = worktrees.filter((w) => !w.prunable);
  const viewing =
    (wtCwd
      ? liveWorktrees.find((w) => samePath(w.path, wtCwd))
      : liveWorktrees.find((w) => w.current)) ?? null;
  const elsewhere = viewing
    ? editsElsewhere(
        changes.map((c) => c.file),
        liveWorktrees,
        viewing.path,
      ).sort((a, b) => b.count - a.count)[0]
    : undefined;
  const pickWorktree = (p: string) => {
    const home = liveWorktrees.find((w) => w.current);
    setWtCwd(home && samePath(home.path, p) ? null : p);
    setPreviewKey(null);
    setSelectedFile(null);
    setOnlySession(false);
  };

  const selectedRel = selectedFile ? relOf(gitCwd, selectedFile) : null;
  // 中栏预览只在同一来源（未提交 g: / 磁盘 d:）的文件间前后切换
  const portalFiles = previewKey
    ? previewFiles.filter((f) => f.key[0] === previewKey[0])
    : previewFiles;
  const changesActive = view === 'changes';
  const workspaceActive = view === 'workspace';
  const changesCount = source === 'git' ? gitFiles.length : changes.length;
  const openWorkspace = () => {
    setView('workspace');
    void refreshDisk();
  };
  const refresh = workspaceActive ? refreshDisk : refreshGit;
  const refreshing = workspaceActive ? diskBusy : gitBusy;
  // 只有真有内容可筛时才显示筛选框
  const showFilter = changesActive
    ? source === 'git'
      ? gitFiles.length > 0
      : changes.length > 0
    : !diskErr && (diskTree.length > 0 || changes.length > 0);

  const filterBox = showFilter ? (
    <div className={pane.toolRow}>
      <label className={styles.wbFilter}>
        <Search size={12} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('ui.session-workspace.filter-files')}
          aria-label={t('ui.session-workspace.filter-files')}
          data-testid="files-rail-filter"
        />
      </label>
      {changesActive && source === 'git' && sessionInGit > 0 ? (
        <button
          type="button"
          className={pane.chip}
          aria-pressed={onlySession}
          data-active={onlySession || undefined}
          data-testid="changes-only-session"
          title={t('ui.session-workspace.only-files-the-assistant-edited-in-this-session')}
          onClick={() => setOnlySession((v) => !v)}
        >
          <Bot size={12} />
          {t('ui.slash-commands.this-session')}
          <span className={styles.count}>{sessionInGit}</span>
        </button>
      ) : null}
    </div>
  ) : null;

  const sessionTree = (
    <div className={styles.railTree} data-testid="files-rail-tree">
      <ChangeFileTree
        nodes={changesActive ? changedTree : workspaceTree}
        active={selectedFile}
        onPick={pickFile}
        filter={treeFilter}
        testIdPrefix="rail"
        defaultOpen={changesActive}
        messageIdByFile={Object.fromEntries(changes.map((c) => [c.file, c.messageId]))}
        onLocate={(_file, messageId) => {
          if (messageId) locateChangeMessage(messageId);
        }}
      />
    </div>
  );

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      data-testid="session-changes-panel"
      data-rail={rail || undefined}
      data-focused={workbench ? 'true' : undefined}
      data-layout="tree"
      data-view={view}
      data-source={changesActive ? source : undefined}
      tabIndex={-1}
    >
      {/* 一行：左侧「改动 · 文件」分段，右侧统计与操作；与 ChatHeader 同高 */}
      <header className={styles.panelHead}>
        <div
          className={pane.seg}
          role="tablist"
          aria-label={t('ui.session-workspace.changes-panel-view')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={changesActive}
            className={pane.segBtn}
            data-active={changesActive || undefined}
            data-testid="rail-tab-changes"
            title={
              source === 'git'
                ? t('ui.session-workspace.uncommitted-changes-in-the-workspace-vs-head-incl')
                : t('ui.session-workspace.files-the-assistant-changed-in-this-session')
            }
            onClick={() => setView('changes')}
          >
            {t('ui.session-workspace.changes')}
            {changesCount ? (
              <span className={styles.count} data-pulse={badgePulse || undefined}>
                {changesCount}
              </span>
            ) : null}
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
            {t('ui.knowledge-local.files')}
          </button>
        </div>
        <span className={styles.wbSpacer} />
        {summary.files > 0 && changesActive ? (
          <span
            className={`${styles.summary} ${pane.railSummary}`}
            data-pulse={badgePulse || undefined}
            data-testid="changes-summary"
          >
            <span className={styles.add}>+{summary.added}</span>{' '}
            <span className={styles.del}>−{summary.removed}</span>
          </span>
        ) : null}
        {cwd ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => {
              setBranchNonce((n) => n + 1);
              void refresh();
            }}
            disabled={refreshing}
            aria-label={t('ui.knowledge-local.refresh')}
            title={t('ui.knowledge-local.refresh')}
            data-testid={workspaceActive ? 'files-rail-refresh' : 'git-refresh'}
          >
            <RefreshCw size={14} className={refreshing ? styles.spin : undefined} />
          </button>
        ) : null}
        {rail && changes.length > 0 ? (
          <button
            type="button"
            className={styles.iconBtn}
            data-testid="rail-open-fullscreen"
            title={t('ui.session-workspace.full-screen-review')}
            aria-label={t('ui.session-workspace.full-screen-review')}
            onClick={openFullscreen}
          >
            <Expand size={14} />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('ui.session-workspace.hide-changes-panel')}
            title={t('ui.session-workspace.hide-changes-panel')}
            data-testid="files-rail-close"
            onClick={onClose}
          >
            <PanelRightClose size={14} />
          </button>
        ) : null}
      </header>
      {/* 当前分支：改动和文件说的都是这个分支上的工作区 */}
      {branch ? (
        <div
          className={styles.branchBar}
          title={t('ui.session-workspace.current-branch', branch)}
          data-testid="rail-git-branch"
        >
          <GitBranch size={13} aria-hidden />
          <span className={styles.branchName}>{branch}</span>
          <GitSyncButtons sync={sync} ops={ops} />
        </div>
      ) : null}
      {/* 同一仓库有多个 worktree（委派任务、编程助手的 --worktree、自己 git worktree add 的）：可以切过去看 */}
      {liveWorktrees.length > 1 && viewing ? (
        <div className={styles.branchBar} data-testid="rail-worktree">
          <FolderGit2 size={13} aria-hidden />
          <Select
            size="sm"
            variant="ghost"
            value={viewing.path}
            options={liveWorktrees.map((w) => ({
              value: w.path,
              label: w.main
                ? `${worktreeLabel(w)} · ${t('ui.session-workspace.main-worktree')}`
                : w.delegate
                  ? `${worktreeLabel(w)} · ${t('ui.session-workspace.delegated-task')}`
                  : worktreeLabel(w),
            }))}
            menuMinWidth={220}
            title={viewing.path}
            aria-label={t('ui.session-workspace.switch-worktree')}
            data-testid="rail-worktree-select"
            onChange={(e) => pickWorktree(e.target.value)}
          />
        </div>
      ) : null}
      {changesActive && elsewhere ? (
        <p className={pane.worktreeHint} data-testid="rail-worktree-hint">
          {t(
            'ui.session-workspace.assistant-changed-n-files-in-worktree',
            worktreeLabel(elsewhere.worktree),
            String(elsewhere.count),
          )}
          <button
            type="button"
            className={pane.link}
            data-testid="rail-worktree-hint-switch"
            onClick={() => pickWorktree(elsewhere.worktree.path)}
          >
            {t('ui.session-workspace.switch-to-it')}
          </button>
        </p>
      ) : null}

      {changesActive && source === 'git' ? (
        <>
          {filterBox}
          <div className={styles.body} data-testid="git-list">
            {!gitFiles.length ? (
              <p className={styles.empty} data-testid="git-clean">
                {t('ui.session-workspace.working-tree-clean-nothing-to-commit')}
              </p>
            ) : !gitRows.length ? (
              <p className={styles.empty}>{t('ui.foundation.no-matching-files')}</p>
            ) : (
              (
                [
                  ['staged', t('ui.session-workspace.staged'), stagedRows],
                  ['unstaged', t('ui.session-workspace.unstaged'), unstagedRows],
                ] as const
              ).map(([area, label, list]) =>
                // 没有暂存内容时不分组，和普通列表一样
                !list.length ? null : (
                  <div key={area} className={pane.gitGroup} data-testid={`git-group-${area}`}>
                    {stagedRows.length ? (
                      <div className={pane.gitGroupHead}>
                        <span>{label}</span>
                        <span className={styles.count}>{list.length}</span>
                        <span className={styles.wbSpacer} />
                        {area === 'unstaged' ? (
                          <button
                            type="button"
                            className={styles.iconBtn}
                            disabled={ops.op !== null}
                            data-testid="git-group-unstaged-discard"
                            title={t('ui.session-workspace.discard-all-unstaged-changes')}
                            aria-label={t('ui.session-workspace.discard-all-unstaged-changes')}
                            onClick={() => void ops.discard(stagePaths(list, area))}
                          >
                            <RotateCcw size={12} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={styles.iconBtn}
                          disabled={ops.op !== null}
                          data-testid={`git-group-${area}-toggle`}
                          title={
                            area === 'staged'
                              ? t('ui.session-workspace.unstage-all')
                              : t('ui.session-workspace.stage-all')
                          }
                          aria-label={
                            area === 'staged'
                              ? t('ui.session-workspace.unstage-all')
                              : t('ui.session-workspace.stage-all')
                          }
                          onClick={() => void ops.stage(stagePaths(list, area), area !== 'staged')}
                        >
                          {area === 'staged' ? <Minus size={12} /> : <Plus size={12} />}
                        </button>
                      </div>
                    ) : null}
                    {list.map((r) => (
                      <GitRow
                        key={r.key}
                        entry={r.entry}
                        letter={r.letter}
                        area={r.area}
                        added={r.added}
                        removed={r.removed}
                        session={changeByRel.get(r.entry.path)}
                        selected={
                          previewKey?.startsWith('g:')
                            ? previewKey === r.key
                            : selectedRel === r.entry.path
                        }
                        onSelect={() => pickGit(r)}
                        onStage={() => void ops.stage(stagePaths([r], r.area), r.area !== 'staged')}
                        stageDisabled={ops.op !== null}
                        onDiscard={
                          r.area === 'unstaged'
                            ? () => void ops.discard(stagePaths([r], r.area))
                            : undefined
                        }
                      />
                    ))}
                  </div>
                ),
              )
            )}
            {git?.truncated ? (
              <p className={styles.empty}>{t('ui.session-workspace.diff-truncated')}</p>
            ) : null}
          </div>
          <GitCommitBox
            ops={ops}
            sync={sync}
            hasChanges={gitRows.length > 0}
            stagedCount={stagedCount}
            paths={commitPaths}
            onAskAssistant={askCommit}
          />
        </>
      ) : changesActive ? (
        <div className={styles.railBody} data-testid="changes-list" data-layout="tree">
          <div
            className={styles.railTreePane}
            data-testid="rail-tree-pane"
            style={{ flex: '1 1 auto', minWidth: 0, borderLeft: 'none' }}
          >
            {source === 'loading' ? (
              <p className={styles.empty}>{t('ui.session-workspace.reading-git')}</p>
            ) : (
              <>
                {gitNote ? (
                  <p className={styles.hint} data-testid="git-friendly-error">
                    {gitNote}
                  </p>
                ) : null}
                {filterBox}
                {!changes.length ? (
                  <div className={pane.empty} data-testid="files-rail-no-changes">
                    <p>{t('ui.session-workspace.no-file-changes-in-this-session-yet')}</p>
                    {cwd ? (
                      <div className={pane.emptyActions}>
                        <button type="button" className={pane.link} onClick={openWorkspace}>
                          <FolderTree size={12} />
                          {t('ui.session-workspace.browse-workspace-files')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  sessionTree
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.railBody} data-testid="changes-list" data-layout="tree">
          <div
            className={styles.railTreePane}
            data-testid="rail-tree-pane"
            style={{ flex: '1 1 auto', minWidth: 0, borderLeft: 'none' }}
          >
            {filterBox}
            {diskErr ? (
              <p className={styles.empty} data-testid="files-rail-disk-error">
                {diskErr}
              </p>
            ) : !diskTree.length && !changes.length && !diskBusy ? (
              <p className={styles.empty}>
                {cwd
                  ? t('ui.session-workspace.workspace-is-empty')
                  : t('ui.session-workspace.this-session-has-no-working-directory')}
              </p>
            ) : (
              sessionTree
            )}
          </div>
        </div>
      )}
      {previewing && previewSlot && portalFiles.length > 0
        ? createPortal(
            <FilePreview
              hideFileTabs
              files={portalFiles}
              activeKey={previewKey!}
              cwd={previewKey?.startsWith('g:') ? gitCwd : cwd}
              onActiveKey={setPreviewKey}
              onClose={() => setPreviewKey(null)}
              onSaved={() => void refreshGit()}
            />,
            previewSlot,
          )
        : null}
    </section>
  );
};
