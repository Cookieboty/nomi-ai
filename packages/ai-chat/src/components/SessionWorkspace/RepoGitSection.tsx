/**
 * 右栏「改动」里的一个 git 仓库：分支 · 同步、worktree 切换、已暂存 / 未暂存列表、提交框，以及它的文件在中栏的预览。
 * 项目有多个文件夹时每个仓库一段（同一个仓库的多个文件夹按 gitRoot 合成一段，由右栏决定隐藏哪段）；
 * 只有一个文件夹时就是整个「改动」视图，没有段头。
 * 不是 git 仓库 / 读不到时不画，只把状态报给右栏（全都不是 git 仓库时右栏退回本会话变更树）。
 */
import { Select, t } from '@nomi-ai/ui';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useGitBranch } from '../../hooks/useGitBranch';
import { useGitSync, useGitWorktrees } from '../../hooks/useGitSync';
import { harnessClient, type GitDiffResult } from '../../services/harnessClient';
import { buildCommitPrompt } from '../../utils/commitPrompt';
import { onWindowFocus } from '../../utils/focusRefresh';
import {
  isNotGitRepoError,
  parseGitStatus,
  splitUnifiedDiff,
  type GitFileEntry,
  type ParsedDiffFile,
} from '../../utils/gitStatusParse';
import { parsePatch } from '../../utils/lineDiff';
import { locateChangeMessage, type ChangeEntry } from '../../utils/sessionChanges';
import type { FileDiff as ToolFileDiff } from '../../utils/toolTrace';
import { workspaceRelPath } from '../../utils/workspacePath';
import { editsElsewhere, samePath, worktreeLabel } from '../../utils/worktrees';
import { BranchPicker } from '../BranchPicker';

import { useChangesUi } from './ChangesUiContext';
import { FilePreview, type PreviewFile } from './FilePreview';
import { GitCommitBox, GitSyncButtons, useGitOps } from './GitCommitBox';
import styles from './SessionWorkspace.module.css';
import pane from './WorkspacePane.module.css';

/** 自动触发的 git diff 刷新合并窗口 */
const GIT_REFRESH_DEBOUNCE_MS = 300;

export const relOf = (cwd: string | null | undefined, file: string) =>
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

/** 一段报给右栏的状态：右栏据此决定数据源、合计与哪段重复 */
export interface RepoReport {
  state: 'loading' | 'git' | 'not-git' | 'error';
  error?: string;
  gitRoot?: string;
  files: number;
  added: number;
  removed: number;
  /** 本会话助手改过、且在这个仓库的未提交改动里的文件数 */
  sessionInGit: number;
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

export const RepoGitSection: React.FC<{
  /** 这一段对应的项目文件夹 */
  cwd: string;
  /** 预览 key 的前缀（单个文件夹时 'g:'，多个时每段不同） */
  keyPrefix: string;
  /** 多个文件夹时的段头：文件夹名；不给 = 只有一个文件夹，没有段头 */
  label?: string;
  /** 主文件夹（段头带星标） */
  primary?: boolean;
  /** all：整段；branch：只画分支栏（只有一个文件夹、在看「文件」时）；none：不画（仍挂着报告状态） */
  show: 'all' | 'branch' | 'none';
  /** 当前标签正在跑：跑完后自动刷新 git 状态 */
  busy: boolean;
  /** 本会话助手改过的文件（全部，按路径对到这个仓库） */
  changes: readonly ChangeEntry[];
  /** 筛选（已转小写）与「只看本会话」 */
  query: string;
  onlySession: boolean;
  setOnlySession: (v: boolean) => void;
  previewKey: string | null;
  setPreviewKey: (k: string | null) => void;
  selectedFile: string | null;
  setSelectedFile: (f: string | null) => void;
  /** 右栏标题的「刷新」：每次加一就重读 git 与分支 */
  nonce: number;
  onReport: (cwd: string, r: RepoReport) => void;
}> = ({
  cwd,
  keyPrefix,
  label,
  primary,
  show,
  busy,
  changes,
  query: q,
  onlySession,
  setOnlySession,
  previewKey,
  setPreviewKey,
  selectedFile,
  setSelectedFile,
  nonce,
  onReport,
}) => {
  const { closeWorkbench, previewSlot, fillComposer } = useChangesUi();
  const [git, setGit] = useState<GitDiffResult | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  /** 手动刷新 / 切分支后连同分支一起重读 */
  const [branchNonce, setBranchNonce] = useState(0);
  /** 切到同一仓库的另一个 worktree 看改动（null = 这个文件夹自己）；换文件夹时回到它 */
  const [wtCwd, setWtCwd] = useState<string | null>(null);
  const [wtFor, setWtFor] = useState(cwd);
  if (wtFor !== cwd) {
    setWtFor(cwd);
    setWtCwd(null);
  }
  /** 改动 / 提交 / 同步针对的目录 */
  const gitCwd = wtCwd ?? cwd;
  const worktreeList = useGitWorktrees(cwd, busy, branchNonce + nonce);
  const worktrees = useMemo(() => worktreeList?.worktrees ?? [], [worktreeList]);
  const branch = useGitBranch(gitCwd, busy, branchNonce + nonce);
  const sync = useGitSync(gitCwd, busy, branchNonce + nonce);

  /** git 给的是相对仓库的路径，工具调用里多是绝对路径：统一换成相对路径再对 */
  const changeByRel = useMemo(
    () => new Map(changes.map((c) => [relOf(gitCwd, c.file), c])),
    [changes, gitCwd],
  );

  // 只认最后一次请求的结果（换目录时旧请求晚到不覆盖）
  const gitReq = useRef(0);
  const refreshGit = useCallback(async () => {
    const id = ++gitReq.current;
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
  }, [gitCwd]);
  const refreshAll = useCallback(() => {
    setBranchNonce((n) => n + 1);
    void refreshGit();
  }, [refreshGit]);
  const ops = useGitOps(gitCwd, refreshAll);

  // 换目录：立即刷新。助手又改了文件、一轮跑完、窗口重新拿到焦点：常在同一刻接连发生，合并成一次 git diff
  useEffect(() => setGit(null), [gitCwd]);
  useEffect(() => {
    void refreshGit();
  }, [refreshGit, nonce]);
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
  // 切回窗口：至多每 5 秒重读一次
  useEffect(() => onWindowFocus(scheduleGit), [scheduleGit]);

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
          key: `${keyPrefix}s:${g.path}`,
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
          key: `${keyPrefix}u:${g.path}`,
        });
      }
    }
    return out;
  }, [gitFiles, gitDiffs, git?.staged, git?.unstaged, git?.numstat, keyPrefix]);
  const sessionInGit = useMemo(
    () => gitFiles.filter((g) => changeByRel.has(g.path)).length,
    [gitFiles, changeByRel],
  );
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

  // 报给右栏：数据源、合计（numstat 不受 diff 文本上限影响）、仓库根
  const report = useMemo<RepoReport>(() => {
    if (!git) return { state: 'loading', files: 0, added: 0, removed: 0, sessionInGit: 0 };
    if (!git.ok)
      return {
        state: isNotGitRepoError(git.error) ? 'not-git' : 'error',
        error: git.error,
        files: 0,
        added: 0,
        removed: 0,
        sessionInGit: 0,
      };
    let added = 0;
    let removed = 0;
    for (const d of git.numstat ? Object.values(git.numstat.head) : gitDiffs) {
      added += d.added;
      removed += d.removed;
    }
    return {
      state: 'git',
      gitRoot: git.gitRoot,
      files: gitFiles.length,
      added,
      removed,
      sessionInGit,
    };
  }, [git, gitDiffs, gitFiles.length, sessionInGit]);
  useEffect(() => onReport(cwd, report), [cwd, report, onReport]);

  if (report.state !== 'git' || show === 'none') return null;

  const mine = !!previewKey?.startsWith(keyPrefix);
  const previewFiles: PreviewFile[] = gitItems.map(
    ({ entry: g, letter, diff: d, added, removed, key }) => {
      const gitDiff: ToolFileDiff | undefined = d
        ? { file: d.file, diff: parsePatch(d.body) }
        : undefined;
      return { key, path: g.path, letter, added, removed, gitDiff };
    },
  );

  /** 「提交」与「让助手提交」针对的文件：有过滤 / 只看本会话时是过滤后的 */
  const pickedRows = onlySession || q ? gitRows : gitItems;
  const stagedCount = gitFiles.filter((g) => g.staged).length;
  const commitPaths = [...new Set(pickedRows.map((r) => r.entry.path))];

  /** 交给当前助手提交：只填进输入框，用户看过再发。多个仓库时写明在哪个仓库 */
  const askCommit = (push: boolean) => {
    const paths = new Set(commitPaths);
    const files = gitFiles
      .filter((g) => paths.has(g.path))
      .map((g) => ({ path: g.path, staged: g.staged, unstaged: g.unstaged }));
    if (files.length)
      fillComposer(buildCommitPrompt(files, push, wtCwd ?? (label ? gitCwd : undefined)));
  };

  // worktree：正在看的那个（文件夹所在的，或切过去的）；助手改的文件落在别的 worktree 时提示
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
  const pickGit = (item: GitItem) => {
    setSelectedFile(item.entry.path);
    setPreviewKey(item.key);
    closeWorkbench();
  };
  const selectedRel = selectedFile ? relOf(gitCwd, selectedFile) : null;

  const head = label ? (
    <button
      type="button"
      className={pane.repoHead}
      aria-expanded={!collapsed}
      title={cwd}
      data-testid="repo-section-toggle"
      onClick={() => setCollapsed((v) => !v)}
    >
      {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      <FolderGit2 size={13} aria-hidden />
      <span className={pane.repoName}>{label}</span>
      {primary ? (
        <span className={pane.repoPrimary}>{t('ui.cli-monitor.project-primary')}</span>
      ) : null}
      <span className={styles.wbSpacer} />
      {gitFiles.length ? <span className={styles.count}>{gitFiles.length}</span> : null}
    </button>
  ) : null;

  const branchBar = branch ? (
    <div
      className={styles.branchBar}
      title={t('ui.session-workspace.current-branch', branch)}
      data-testid="rail-git-branch"
    >
      {/* 点开切换 / 新建分支；助手正在跑时不让切（它可能正在改这个仓库） */}
      <BranchPicker
        cwd={gitCwd}
        branch={branch}
        disabled={busy}
        className={styles.branchPicker}
        testId="rail-branch-picker"
        onSwitched={() => setBranchNonce((n) => n + 1)}
      />
      <GitSyncButtons sync={sync} ops={ops} />
    </div>
  ) : null;
  if (show === 'branch') return branchBar;

  return (
    <div
      className={label ? pane.repoSection : pane.repoSingle}
      data-testid="repo-section"
      data-cwd={cwd}
    >
      {head}
      {collapsed ? null : (
        <>
          {/* 当前分支：改动说的都是这个分支上的工作区 */}
          {branchBar}
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
          {elsewhere ? (
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
          <div className={`${styles.body} ${pane.repoBody}`} data-testid="git-list">
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
              ).map(([area, groupLabel, list]) =>
                // 没有暂存内容时不分组，和普通列表一样
                !list.length ? null : (
                  <div key={area} className={pane.gitGroup} data-testid={`git-group-${area}`}>
                    {stagedRows.length ? (
                      <div className={pane.gitGroupHead}>
                        <span>{groupLabel}</span>
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
      )}
      {mine && previewSlot && previewFiles.some((f) => f.key === previewKey)
        ? createPortal(
            <FilePreview
              hideFileTabs
              files={previewFiles}
              activeKey={previewKey!}
              cwd={gitCwd}
              onActiveKey={setPreviewKey}
              onClose={() => setPreviewKey(null)}
              onSaved={() => void refreshGit()}
            />,
            previewSlot,
          )
        : null}
    </div>
  );
};
