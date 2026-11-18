/**
 * 子任务改动带回来源对话：内核核对出的改动文件（delegate.completed 的 changedFiles / report.changedFiles）
 * 是权威列表；这里从子任务标签自己的会话里补上每个文件的 +/− 和行级 Diff（和子任务面板里
 * 「已编辑 N 个文件」卡片同一份数据），写进来源对话那条结果消息：
 *   - 消息正文列文件 + 增删行数（Nomi 下一轮从历史里读到改了什么；不放整段 Diff）；
 *   - 消息上记下 delegateChanges，对话里用同一张「已编辑 N 个文件」卡片打开每个文件的 Diff。
 */
import type { ConvMessage } from '../types/conversation';
import { fromHarnessMessage } from '../utils/convAdapters';
import { parseGitStatus, splitUnifiedDiff } from '../utils/gitStatusParse';
import { diffAllAdded, parsePatch } from '../utils/lineDiff';
import { aggregateSessionChanges, type ChangeEntry } from '../utils/sessionChanges';
import { workspaceKey, workspaceRelPath } from '../utils/workspacePath';

import type { DelegateResult } from './delegateClient';
import type {
  GitDiffResult,
  HarnessTabMessage,
  HarnessTabsState,
  WorkspaceFileResult,
} from './harnessClient';

export interface DelegateChangeFile {
  file: string;
  /** 子任务会话里认得出的增删行数（跑命令改的文件没有） */
  added?: number;
  removed?: number;
}

/** 结果消息上记下的子任务改动（持久化在消息里） */
export interface DelegateChanges {
  /** 子任务标签（读它的会话拿行级 Diff） */
  tabId?: string;
  /** 改动落地所在的工作目录（撤销 / 查看工作区文件针对它；转存新分支或未验收时没有） */
  cwd?: string;
  /** 子任务自己运行时的目录（worktree 隔离时与 cwd 不同，用来把工具事件路径转成相对路径） */
  childCwd?: string;
  backend?: string;
  /** 这一次（或接着对话的这一轮）的时间范围：只取这段里子任务会话的改动 */
  from?: number;
  to?: number;
  files: DelegateChangeFile[];
}

const prefetchedByChanges = new WeakMap<DelegateChanges, HarnessTabMessage[]>();
const prefetchedGitByChanges = new WeakMap<DelegateChanges, Map<string, GitFallbackEntry>>();

/** 同一轮 collectDelegateChanges 刚拉过的子任务消息（按结果对象弱引用挂载，不跨实例串扰、自动回收） */
export function peekPrefetchedTabMessages(changes: DelegateChanges): HarnessTabMessage[] | null {
  return prefetchedByChanges.get(changes) ?? null;
}

/** 同一轮 collectDelegateChanges 刚拉过的 Git Diff 回退映射（按结果对象弱引用挂载） */
export function peekPrefetchedGitFallback(
  changes: DelegateChanges,
): ReadonlyMap<string, GitFallbackEntry> | null {
  return prefetchedGitByChanges.get(changes) ?? null;
}

export type GitFallbackEntry = Omit<ChangeEntry, 'messageId'>;

function toGitEntryKey(
  cwd: string | undefined,
  gitRoot: string | undefined,
  relFromRoot: string,
): string {
  const full = gitRoot ? `${gitRoot.replace(/[\\/]+$/, '')}/${relFromRoot}` : relFromRoot;
  return workspaceKey(workspaceRelPath(cwd, full));
}

function statusLetterFromCode(code: string): Pick<ChangeEntry, 'status' | 'letter'> {
  switch (code) {
    case 'A':
    case '?':
      return { status: 'added', letter: 'A' };
    case 'D':
      return { status: 'deleted', letter: 'D' };
    default:
      return { status: 'modified', letter: 'M' };
  }
}

/** 从 gitDiff 响应与未跟踪文件内容构造按路径键索引的变更统计与行级 Diff */
export function buildGitFallbackMap(
  git: GitDiffResult | null | undefined,
  cwd: string | undefined,
  untrackedContents?: ReadonlyMap<string, string>,
): Map<string, GitFallbackEntry> {
  const map = new Map<string, GitFallbackEntry>();
  if (!git?.ok) return map;
  const patches = new Map<string, ReturnType<typeof parsePatch>>();
  for (const d of splitUnifiedDiff(git.diff ?? '')) {
    if (d.file && d.file !== '(unnamed)')
      patches.set(toGitEntryKey(cwd, git.gitRoot, d.file), parsePatch(d.body));
  }
  const numstat = new Map<string, { added: number; removed: number }>();
  if (git.numstat?.head) {
    for (const [p, cnt] of Object.entries(git.numstat.head)) {
      numstat.set(toGitEntryKey(cwd, git.gitRoot, p), cnt);
    }
  }
  const statusEntries = parseGitStatus(git.status ?? '');
  for (const g of statusEntries) {
    const k = toGitEntryKey(cwd, git.gitRoot, g.path);
    const rel = workspaceRelPath(
      cwd,
      git.gitRoot ? `${git.gitRoot.replace(/[\\/]+$/, '')}/${g.path}` : g.path,
    );
    if (g.untracked) {
      const text = untrackedContents?.get(k);
      if (text !== undefined) {
        const diff = diffAllAdded(text);
        map.set(k, {
          file: rel,
          added: diff.added,
          removed: 0,
          statsKnown: true,
          changeKind: 'add',
          status: 'added',
          letter: 'A',
          diff: { file: rel, changeKind: 'add', diff },
        });
      }
      continue;
    }
    const diff = patches.get(k);
    const ns = numstat.get(k);
    const added = ns?.added ?? diff?.added;
    const removed = ns?.removed ?? diff?.removed;
    if (added == null || removed == null) continue;
    const code = g.unstaged ? g.work : g.index;
    const { status, letter } = statusLetterFromCode(code);
    map.set(k, {
      file: rel,
      added,
      removed,
      statsKnown: true,
      status,
      letter,
      ...(diff ? { diff: { file: rel, diff } } : {}),
    });
  }
  for (const [k, ns] of numstat.entries()) {
    if (map.has(k)) continue;
    const diff = patches.get(k);
    const rel = Object.keys(git.numstat?.head ?? {}).find(
      (p) => toGitEntryKey(cwd, git.gitRoot, p) === k,
    );
    const file = rel
      ? workspaceRelPath(cwd, git.gitRoot ? `${git.gitRoot.replace(/[\\/]+$/, '')}/${rel}` : rel)
      : k;
    map.set(k, {
      file,
      added: ns.added,
      removed: ns.removed,
      statsKnown: true,
      status: 'modified',
      letter: 'M',
      ...(diff ? { diff: { file, diff } } : {}),
    });
  }
  if (!git.numstat?.head) {
    for (const d of splitUnifiedDiff(git.diff ?? '')) {
      if (!d.file || d.file === '(unnamed)') continue;
      const k = toGitEntryKey(cwd, git.gitRoot, d.file);
      if (map.has(k)) continue;
      const rel = workspaceRelPath(
        cwd,
        git.gitRoot ? `${git.gitRoot.replace(/[\\/]+$/, '')}/${d.file}` : d.file,
      );
      const diff = parsePatch(d.body);
      map.set(k, {
        file: rel,
        added: diff.added,
        removed: diff.removed,
        statsKnown: true,
        status: diff.added > 0 && diff.removed === 0 ? 'added' : 'modified',
        letter: diff.added > 0 && diff.removed === 0 ? 'A' : 'M',
        diff: { file: rel, diff },
      });
    }
  }
  return map;
}

/** 内核核对出的改动文件：汇报里的优先（已按 git 核对），否则内核列出的 */
export function reportedFiles(r: DelegateResult): string[] {
  const files = (r.report?.changedFiles?.length ? r.report.changedFiles : r.changedFiles) ?? [];
  return [...new Set(files.filter(Boolean))];
}

/** 子任务会话里 [from, to] 之间的消息（没有范围时全部） */
export function messagesInRange(
  messages: readonly ConvMessage[],
  from?: number,
  to?: number,
): ConvMessage[] {
  if (from == null && to == null) return [...messages];
  return messages.filter(
    (m) => (from == null || (m.at ?? 0) >= from) && (to == null || (m.at ?? 0) <= to),
  );
}

const keyOf = (cwd: string | undefined, file: string) => workspaceKey(workspaceRelPath(cwd, file));

/**
 * 子任务会话里的改动，按内核列出的文件挑出来（同路径后写覆盖）；内核列表里有、会话里认不出的
 * （跑命令改的）优先从 Git Diff 回退映射补回真实的 +/− 与 Diff。
 * 返回的 entries 带行级 Diff（卡片用），files 只有路径和计数（消息正文用）。
 */
export function matchDelegateChanges(
  reported: readonly string[],
  childMessages: readonly ConvMessage[],
  cwd: string | undefined,
  messageId: string,
  gitFallback?: ReadonlyMap<string, GitFallbackEntry> | null,
): { files: DelegateChangeFile[]; entries: ChangeEntry[] } {
  const byKey = new Map<string, ChangeEntry>();
  for (const e of aggregateSessionChanges(childMessages)) {
    if (e.file && e.file !== '(unnamed)') byKey.set(keyOf(cwd, e.file), e);
  }
  const files: DelegateChangeFile[] = [];
  const entries: ChangeEntry[] = [];
  for (const f of reported) {
    const k = keyOf(cwd, f);
    const hit = byKey.get(k);
    if (hit) {
      files.push({ file: f, added: hit.added, removed: hit.removed });
      entries.push({ ...hit, file: workspaceRelPath(cwd, hit.file), messageId });
      continue;
    }
    const gitHit = gitFallback?.get(k);
    if (gitHit) {
      files.push({ file: f, added: gitHit.added, removed: gitHit.removed });
      entries.push({ ...gitHit, file: f, messageId });
      continue;
    }
    files.push({ file: f });
    entries.push({
      file: f,
      added: 0,
      removed: 0,
      statsKnown: false,
      status: 'modified',
      letter: 'M',
      messageId,
    });
  }
  return { files, entries };
}

export interface DelegateChangesDeps {
  tabs: () => Promise<HarnessTabsState>;
  tabMessages: (id: string) => Promise<HarnessTabMessage[]>;
  gitDiff?: (cwd: string) => Promise<GitDiffResult>;
  readFile?: (cwd: string, relPath: string) => Promise<WorkspaceFileResult>;
  now?: () => number;
}

/** 读子任务会话等太久就不等了（结果消息照样写，只是没有 +/−） */
const READ_TIMEOUT_MS = 2500;
const MAX_UNTRACKED_READS = 20;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** 若报告中存在尚未拿到统计的文件且提供了 gitDiff，则按工作区 Git 状态补齐真实 +/− 与 Diff */
export async function resolveGitFallbackForReported(
  reported: readonly string[],
  diffCwd: string | undefined,
  missingPaths: ReadonlySet<string>,
  deps: Pick<DelegateChangesDeps, 'gitDiff' | 'readFile'>,
): Promise<Map<string, GitFallbackEntry> | null> {
  if (!diffCwd || !missingPaths.size || !deps.gitDiff) return null;
  const git = await withTimeout(deps.gitDiff(diffCwd), READ_TIMEOUT_MS);
  if (!git?.ok) return null;
  const untrackedContents = new Map<string, string>();
  if (deps.readFile) {
    const statusEntries = parseGitStatus(git.status ?? '');
    const untrackedByKey = new Map<string, string>();
    for (const g of statusEntries) {
      if (g.untracked) untrackedByKey.set(toGitEntryKey(diffCwd, git.gitRoot, g.path), g.path);
    }
    const candidates = reported
      .filter((f) => {
        const k = keyOf(diffCwd, f);
        return missingPaths.has(k) && untrackedByKey.has(k);
      })
      .slice(0, MAX_UNTRACKED_READS);
    if (candidates.length) {
      const reads = await Promise.all(
        candidates.map(async (f) => {
          const rel = workspaceRelPath(diffCwd, f);
          const res = await withTimeout(deps.readFile!(diffCwd, rel), READ_TIMEOUT_MS);
          return { k: keyOf(diffCwd, f), res };
        }),
      );
      for (const { k, res } of reads) {
        if (res?.ok && !res.binary && !res.truncated && typeof res.content === 'string') {
          untrackedContents.set(k, res.content);
        }
      }
    }
  }
  const gitMap = buildGitFallbackMap(git, diffCwd, untrackedContents);
  return gitMap.size ? gitMap : null;
}

/**
 * 委派结果 → 子任务改动（没有改动文件时 null）。
 * 读不到子任务会话或部分文件通过命令修改时，结合 landedCwd 的 Git Diff 补齐真实 +/− 与 Diff。
 * 注意：仅在 landedCwd 非空时查 Git，避免 worktree 转存新分支（r.cwd === null）时误读主工作区。
 */
export async function collectDelegateChanges(
  r: DelegateResult,
  deps: DelegateChangesDeps,
): Promise<DelegateChanges | null> {
  const reported = reportedFiles(r);
  if (!reported.length) return null;
  const now = deps.now?.() ?? Date.now();
  // 这一次 / 这一轮的时间范围：优先用精确 startedAt，否则从结束往前推用时（多留 1 秒），之后的不算
  const from =
    r.startedAt != null && r.startedAt > 0
      ? r.startedAt - 1000
      : r.durationMs > 0
        ? now - r.durationMs - 1000
        : undefined;
  const to = now + 1000;
  const state = await withTimeout(deps.tabs(), READ_TIMEOUT_MS);
  const tab =
    state?.tabs.find((x) => x.id === r.tabId) ??
    state?.tabs.find((x) => x.delegation?.taskId === r.taskId);
  const tabId = tab?.id ?? r.tabId;
  // 子任务执行目录用来归一化会话里的工具路径；落盘到卡片的 cwd 用真正落地的工作区目录（避免指向已拆毁的 worktree）
  const childCwd = tab?.cwd ?? (r.cwd || undefined);
  const landedCwd = r.cwd !== undefined ? r.cwd || undefined : tab?.cwd;
  const base: DelegateChanges = {
    ...(tabId ? { tabId } : {}),
    ...(landedCwd ? { cwd: landedCwd } : {}),
    ...(childCwd && childCwd !== landedCwd ? { childCwd } : {}),
    ...(tab?.backend ? { backend: tab.backend } : {}),
    ...(from != null ? { from } : {}),
    to,
    files: reported.map((file) => ({ file })),
  };
  let raw: HarnessTabMessage[] | null = null;
  let conv: ConvMessage[] = [];
  if (tabId) {
    raw = await withTimeout(deps.tabMessages(tabId), READ_TIMEOUT_MS);
    if (raw) {
      const backend = tab?.backend ?? (r.cli === 'nomi' ? 'claude' : r.cli);
      conv = messagesInRange(
        raw.map((m) => fromHarnessMessage(m, backend)),
        from,
        to,
      );
    }
  }
  const matchCwd = childCwd ?? landedCwd;
  const initial = matchDelegateChanges(reported, conv, matchCwd, '');
  const missingKeys = new Set<string>();
  const diffCwd = landedCwd;
  for (const f of initial.files) {
    if (f.added == null || f.removed == null) {
      missingKeys.add(keyOf(diffCwd ?? matchCwd, f.file));
    }
  }
  let gitMap: Map<string, GitFallbackEntry> | null = null;
  if (missingKeys.size && diffCwd) {
    gitMap = await resolveGitFallbackForReported(reported, diffCwd, missingKeys, deps);
  }
  const finalMatched = gitMap
    ? matchDelegateChanges(reported, conv, matchCwd, '', gitMap)
    : initial;
  const out: DelegateChanges = {
    ...base,
    files: finalMatched.files,
  };
  if (raw) prefetchedByChanges.set(out, raw);
  if (gitMap) prefetchedGitByChanges.set(out, gitMap);
  return out;
}
