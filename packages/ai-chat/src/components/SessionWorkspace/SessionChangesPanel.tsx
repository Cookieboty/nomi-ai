/**
 * Codex 右栏：「改动 · 文件」两视图。
 * 改动：git 仓库里以 `git status` / `git diff` 为准，本会话助手改过的文件带标记；项目有多个文件夹时每个仓库一段
 * （RepoGitSection；同一个仓库的多个文件夹合成一段）。都不是 git 仓库（或读不到）时退回本会话变更树。
 * 文件：一个文件夹时就是它的目录树；多个时每个文件夹一个顶层节点（主文件夹默认展开）。中栏 Diff 见 CenterChangesHost。
 */
import { t } from '@nomi-ai/ui';
import { Bot, Expand, FolderTree, PanelRightClose, RefreshCw, Search } from 'lucide-react';
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useResourceContext } from '../../contexts/ResourceContext';
import { harnessClient, type WorkspaceTreeNode } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import { workspaceFileHref } from '../../utils/resourceLinks';
import {
  aggregateSessionChanges,
  buildChangeFileTree,
  locateChangeMessage,
  mergeWorkspaceAndChanges,
  projectNameFromCwd,
  summarizeChanges,
  type ChangeEntry,
  type ChangeTreeNode,
} from '../../utils/sessionChanges';
import { rootOf, workspaceKey } from '../../utils/workspacePath';

import { ChangeFileTree } from './ChangeFileTree';
import { useChangesUi } from './ChangesUiContext';
import { FileReview, type ReviewFile } from './FileReview';
import { RepoGitSection, type RepoReport } from './RepoGitSection';
import styles from './SessionWorkspace.module.css';
import pane from './WorkspacePane.module.css';

type View = 'changes' | 'workspace';

const sep = (root: string) => (root.includes('\\') && !root.includes('/') ? '\\' : '/');
const joinPath = (root: string, rel: string) =>
  `${root.replace(/[\\/]+$/, '')}${sep(root)}${rel.replace(/^[\\/]+/, '')}`;

/** 磁盘树（相对路径）的路径换成绝对路径：多个文件夹时节点要能区分是哪个文件夹的 */
const absTree = (nodes: readonly ChangeTreeNode[], root: string): ChangeTreeNode[] =>
  nodes.map((n) =>
    n.kind === 'dir'
      ? { ...n, path: joinPath(root, n.path), children: absTree(n.children, root) }
      : n.entry
        ? n
        : { ...n, path: joinPath(root, n.path) },
  );

export const SessionChangesPanel: React.FC<{
  messages: readonly ConvMessage[];
  /** 工作目录（项目的主文件夹 / 编程助手标签的目录） */
  cwd?: string | null;
  /** 项目的全部文件夹（工作目录在前）；不给 = 只有 cwd */
  roots?: readonly string[] | null;
  /** 整页右栏全高模式 */
  rail?: boolean;
  /** 当前标签正在跑：跑完后自动刷新 git 状态 */
  busy?: boolean;
  /** 收起右栏（与顶栏开关同一状态） */
  onClose?: () => void;
}> = ({ messages, cwd, roots: rootsProp, rail = false, busy = false, onClose }) => {
  const [view, setView] = useState<View>('changes');
  const [onlySession, setOnlySession] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** 全树可能有上万个文件：过滤用延迟值，输入框不被整树重渲染卡住 */
  const treeFilter = useDeferredValue(filter);
  const [badgePulse, setBadgePulse] = useState(false);
  /** 每个文件夹的磁盘树（相对路径） */
  const [diskTrees, setDiskTrees] = useState<Record<string, WorkspaceTreeNode[]>>({});
  const [diskBusy, setDiskBusy] = useState(false);
  const [diskErr, setDiskErr] = useState<string | null>(null);
  const [openDiskPaths, setOpenDiskPaths] = useState<string[]>([]);
  /** 标题栏「刷新」：各仓库段据此重读 git 与分支 */
  const [nonce, setNonce] = useState(0);
  /** 各仓库段报上来的状态 */
  const [reports, setReports] = useState<Record<string, RepoReport>>({});
  const prevCount = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const resource = useResourceContext();
  const { workbench, closeWorkbench, openDetail, openWorkbench, setPreviewOpen, previewSlot } =
    useChangesUi();

  const roots = useMemo(() => {
    const list = (rootsProp?.length ? [...rootsProp] : cwd ? [cwd] : []).filter(Boolean);
    return list.filter((r, i) => list.findIndex((x) => workspaceKey(x) === workspaceKey(r)) === i);
  }, [rootsProp, cwd]);
  const rootsKey = roots.join('\0');
  const multi = roots.length > 1;
  const primary = roots[0] ?? null;
  // 文件夹变了：旧的状态不带过来
  const [reportsFor, setReportsFor] = useState(rootsKey);
  if (reportsFor !== rootsKey) {
    setReportsFor(rootsKey);
    setReports({});
    setDiskTrees({});
  }
  const onReport = useCallback(
    (root: string, r: RepoReport) => setReports((m) => (m[root] === r ? m : { ...m, [root]: r })),
    [],
  );

  const changes = useMemo(() => aggregateSessionChanges(messages), [messages]);
  const changeByFile = useMemo(() => new Map(changes.map((c) => [c.file, c])), [changes]);
  /** 多个文件夹：本会话变更按所在文件夹分开（都不在的算主文件夹的） */
  const changesByRoot = useMemo(() => {
    const m = new Map<string, ChangeEntry[]>(roots.map((r) => [r, []]));
    for (const c of changes) {
      const r = rootOf(roots, c.file) ?? primary;
      if (r) m.get(r)!.push(c);
    }
    return m;
  }, [changes, roots, primary]);
  const label = (r: string) => projectNameFromCwd(r);
  const wrapRoots = (build: (root: string) => ChangeTreeNode[]): ChangeTreeNode[] =>
    roots.map((r, i) => ({
      kind: 'dir' as const,
      name: label(r),
      path: r,
      title: r,
      open: i === 0,
      children: build(r),
    }));
  const changedTree = useMemo(
    () =>
      multi
        ? wrapRoots((r) =>
            buildChangeFileTree(changesByRoot.get(r) ?? [], { cwd: r, compact: true }),
          )
        : buildChangeFileTree(changes, { cwd, compact: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wrapRoots 只读 roots
    [changes, cwd, multi, changesByRoot, rootsKey],
  );
  const workspaceTree = useMemo(
    () =>
      multi
        ? wrapRoots((r) =>
            absTree(mergeWorkspaceAndChanges(diskTrees[r] ?? [], changesByRoot.get(r) ?? [], r), r),
          )
        : mergeWorkspaceAndChanges(diskTrees[primary ?? ''] ?? [], changes, cwd),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wrapRoots 只读 roots
    [diskTrees, changes, cwd, multi, changesByRoot, primary, rootsKey],
  );
  const project = projectNameFromCwd(cwd);

  const refreshDisk = useCallback(async () => {
    if (!roots.length) {
      setDiskTrees({});
      setDiskErr(null);
      return;
    }
    setDiskBusy(true);
    try {
      const got = await Promise.all(
        roots.map(async (r) => {
          try {
            const res = await harnessClient.workspaceList(r);
            return [r, res] as const;
          } catch (e) {
            return [
              r,
              { ok: false, error: e instanceof Error ? e.message : String(e) } as {
                ok: false;
                error: string;
                entries?: WorkspaceTreeNode[];
              },
            ] as const;
          }
        }),
      );
      const next: Record<string, WorkspaceTreeNode[]> = {};
      let err: string | null = null;
      for (const [r, res] of got) {
        if (res.ok) next[r] = res.entries ?? [];
        // 只有一个文件夹时读不出来就显示原因；多个时读不出来的那个文件夹是空的
        else if (!multi) err = res.error || t('ui.slash-commands.failed-to-read');
        else next[r] = [];
      }
      setDiskTrees(next);
      setDiskErr(err);
    } finally {
      setDiskBusy(false);
    }
  }, [rootsKey, multi]); // eslint-disable-line react-hooks/exhaustive-deps -- roots 由 rootsKey 决定

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

  // 各段的状态：有一个是 git 仓库就按 git 显示；同一个仓库（gitRoot 相同）只留第一段
  const repoStates = roots.map((r) => reports[r]);
  const gitRepos = roots.filter((r) => reports[r]?.state === 'git');
  const dupOf = (r: string) => {
    const root = reports[r]?.gitRoot;
    if (!root) return false;
    const first = gitRepos.find((x) => reports[x]?.gitRoot === root);
    return first !== undefined && first !== r;
  };
  const shownRepos = gitRepos.filter((r) => !dupOf(r));
  const source: 'git' | 'session' | 'loading' =
    shownRepos.length > 0
      ? 'git'
      : roots.length && repoStates.some((x) => !x || x.state === 'loading')
        ? 'loading'
        : 'session';
  const gitTotals = shownRepos.reduce(
    (a, r) => {
      const x = reports[r]!;
      return {
        files: a.files + x.files,
        added: a.added + x.added,
        removed: a.removed + x.removed,
        sessionInGit: a.sessionInGit + x.sessionInGit,
      };
    },
    { files: 0, added: 0, removed: 0, sessionInGit: 0 },
  );
  const summary = source === 'git' ? gitTotals : summarizeChanges(changes);

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

  /** 本会话变更与磁盘文件的预览（git 的由各仓库段自己画） */
  const previewFiles: ReviewFile[] = useMemo(() => {
    const where = (p: string) => (multi ? { cwds: [rootOf(roots, p) ?? primary!] } : {});
    const fromChanges = changes.map((c) => ({
      key: `c:${c.file}`,
      path: c.file,
      letter: c.letter,
      added: c.added,
      removed: c.removed,
      change: c,
      ...where(c.file),
    }));
    const extra = openDiskPaths
      .filter((p) => !changeByFile.has(p))
      .map((p) => ({ key: `d:${p}`, path: p, ...where(p) }));
    return [...fromChanges, ...extra];
  }, [changes, openDiskPaths, changeByFile, multi, rootsKey, primary]); // eslint-disable-line react-hooks/exhaustive-deps -- roots 由 rootsKey 决定

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
    if (source === 'git') return null;
    const bad = roots.map((r) => reports[r]).find((x) => x?.state === 'error');
    return bad ? bad.error || t('ui.session-workspace.could-not-read-git-status') : null;
  })();

  const pickFile = (file: string) => {
    setSelectedFile(file);
    if (view === 'workspace') {
      setPreviewKey(null);
      closeWorkbench();
      const root = rootOf(roots, file) ?? cwd;
      if (root && resource)
        resource.open(workspaceFileHref(root, file), { ...resource.scope, cwd: root });
      return;
    }
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
      setPreviewKey(null);
      closeWorkbench();
      const root = rootOf(roots, file) ?? cwd;
      if (root && resource)
        resource.open(workspaceFileHref(root, file), { ...resource.scope, cwd: root });
    }
  };

  const openFullscreen = () =>
    openDetail({
      entries: changes,
      file: selectedFile ?? changes[0]?.file,
      sourceLabel: t('ui.providers-schedule.all'),
      messageId: changes[0]?.messageId,
    });

  // 中栏预览只在同一来源（磁盘 d: / 本会话 c:）的文件间前后切换
  const portalFiles = previewKey
    ? previewFiles.filter((f) => f.key[0] === previewKey[0])
    : previewFiles;
  const changesActive = view === 'changes';
  const workspaceActive = view === 'workspace';
  const changesCount = source === 'git' ? gitTotals.files : changes.length;
  const openWorkspace = () => {
    setView('workspace');
    void refreshDisk();
  };
  const refreshing = workspaceActive ? diskBusy : source === 'loading';
  const diskEmpty = !Object.values(diskTrees).some((l) => l.length);
  // 只有真有内容可筛时才显示筛选框
  const showFilter = changesActive
    ? source === 'git'
      ? gitTotals.files > 0
      : changes.length > 0
    : !diskErr && (!diskEmpty || changes.length > 0);

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
      {changesActive && source === 'git' && gitTotals.sessionInGit > 0 ? (
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
          <span className={styles.count}>{gitTotals.sessionInGit}</span>
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

  // 各仓库段一直挂着（报状态、跟着助手的改动刷新）；不在「改动」视图或不是 git 时不画
  const q = filter.trim().toLowerCase();
  const sections = roots.map((r, i) => (
    <RepoGitSection
      key={r}
      cwd={r}
      keyPrefix={multi ? `g:${i}|` : 'g:'}
      label={multi ? label(r) : undefined}
      primary={multi && i === 0}
      show={dupOf(r) ? 'none' : changesActive ? 'all' : multi ? 'none' : 'branch'}
      busy={busy}
      changes={multi ? (changesByRoot.get(r) ?? []) : changes}
      query={q}
      onlySession={onlySession}
      setOnlySession={setOnlySession}
      previewKey={previewKey}
      setPreviewKey={setPreviewKey}
      selectedFile={selectedFile}
      setSelectedFile={setSelectedFile}
      nonce={nonce}
      onReport={onReport}
    />
  ));

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
      data-multi={multi || undefined}
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
            title={multi ? roots.join('\n') : cwd ? `${project} · ${cwd}` : undefined}
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
              setNonce((n) => n + 1);
              if (workspaceActive) void refreshDisk();
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

      {/* 各仓库段一直挂在同一个位置（换视图 / 数据源时不重新挂载）；不在「改动 · git」时不画，但仍报状态 */}
      {changesActive && source === 'git' ? filterBox : null}
      <div
        className={multi && changesActive && source === 'git' ? pane.repoStack : pane.repoSingle}
        data-testid={multi ? 'repo-stack' : undefined}
      >
        {sections}
      </div>
      {changesActive && source === 'git' ? null : (
        <>
          {changesActive ? (
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
                ) : diskEmpty && !changes.length && !diskBusy && !multi ? (
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
        </>
      )}
      {previewing && !previewKey!.startsWith('g:') && previewSlot && portalFiles.length > 0
        ? createPortal(
            <FileReview
              hideFileTabs
              files={portalFiles}
              activeKey={previewKey!}
              cwd={cwd}
              onActiveKey={setPreviewKey}
              onClose={() => setPreviewKey(null)}
              onSaved={() => setNonce((n) => n + 1)}
            />,
            previewSlot,
          )
        : null}
    </section>
  );
};
