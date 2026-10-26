/**
 * 右栏「改动」的 git 写操作（docs/design/changes-panel-git.md）：暂存、提交、撤销刚才的提交、
 * 检查远端、拉取（只快进）、推送（不强推）。只读的 status / diff 在 slashDiscovery.ts。
 *
 * - cwd 由调用方经 knownDir 校验；路径一律按字面（--literal-pathspecs）从 stdin 传，且必须落在仓库里；
 * - 提交钩子照常跑（不加 --no-verify）；
 * - 拉取 = fetch + `merge --ff-only @{u}`：不受 pull.rebase 等配置影响，分叉时不合并；
 * - 推送总写明 `HEAD:refs/heads/<分支>`，不带 `+`：配置里的强推 refspec 不生效，也从不加 --force；
 * - 同一个目录同时只跑一个写操作。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { waitForShellPath } from './shellPath';
import { gitEnv } from './slashDiscovery';

export type GitOpCode =
  /** 这个目录有别的 git 操作在跑 */
  | 'busy'
  /** 参数不对（路径越界、提交信息为空…） */
  | 'invalid'
  /** 认证失败（凭据助手 / SSH agent 没给到） */
  | 'auth'
  /** 本地与上游分叉，不能快进 */
  | 'diverged'
  /** 远端拒绝推送（远端有新提交、受保护分支…） */
  | 'rejected'
  /** 本地改动会被拉取覆盖 */
  | 'dirty'
  /** 提交钩子 / commitlint 拒绝 */
  | 'hook'
  /** 没有可提交的内容 */
  | 'nothing'
  /** 游离 HEAD */
  | 'detached'
  /** 没有远端 */
  | 'no-remote'
  /** 没有上游分支 */
  | 'no-upstream'
  /** 上游分支名和本地不同：照 push.default=simple 拒绝 */
  | 'mismatch'
  /** 撤销提交：HEAD 已经不是那个提交 / 已经推送 */
  | 'moved'
  | 'pushed'
  /** 生成提交信息：Nomi 和当前标签都没有可用的模型 */
  | 'no-model'
  | 'timeout'
  | 'error';

export interface GitOpResult {
  ok: boolean;
  code?: GitOpCode;
  /** git 的原始输出（截到最后 8 KB） */
  output?: string;
  /** 提交：新提交的完整 sha；放弃改动：存改动的 stash 的 sha */
  sha?: string;
  /** 生成的提交信息 */
  message?: string;
}

export interface GitSyncStatus {
  /** 当前分支；游离 HEAD 时 null */
  branch: string | null;
  /** 游离 HEAD 的短提交号 */
  detached?: string;
  /** 上游分支（如 origin/feat/x）；没有时不给 */
  upstream?: string;
  ahead: number;
  behind: number;
  remotes: string[];
  /** 没有上游时推送会用的远端 */
  pushRemote?: string;
}

const LOCAL_MS = 8000;
/** 提交钩子（lint-staged 等）、pre-push 钩子可能跑十几秒到几分钟 */
const HOOK_MS = 5 * 60_000;
const NET_MS = 2 * 60_000;
const OUTPUT_MAX = 8 * 1024;
const MAX_PATHS = 20_000;

/** 写操作的环境：同 gitEnv，但不带 GIT_OPTIONAL_LOCKS=0（那只适合只读的状态刷新） */
export function gitOpsEnv(): NodeJS.ProcessEnv {
  const env = gitEnv();
  delete env.GIT_OPTIONAL_LOCKS;
  return env;
}

/** 远端地址里内嵌的凭据（https://user:token@host）不显示出来 */
export const redact = (s: string) => s.replace(/:\/\/[^/@\s]+@/g, '://***@');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(cwd: string, args: string[], timeout = LOCAL_MS, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', ...args],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: gitOpsEnv() },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        resolve({
          code: !e ? 0 : typeof e.code === 'number' ? e.code : -1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
          timedOut: !!e?.killed,
        });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

const out = (...rs: Run[]) => {
  const s = rs
    .map((r) => `${r.stdout}\n${r.stderr}`.trim())
    .filter(Boolean)
    .join('\n');
  const r = redact(s);
  return r.length > OUTPUT_MAX ? `…${r.slice(-OUTPUT_MAX)}` : r;
};

const line = async (cwd: string, args: string[]) => {
  const r = await run(cwd, args);
  return r.code === 0 ? r.stdout.trim() : '';
};

/** 网络操作 / 推送失败的原因 */
export function classify(r: Run): GitOpCode {
  if (r.timedOut) return 'timeout';
  const s = `${r.stdout}\n${r.stderr}`;
  if (
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|Invalid username or password/i.test(
      s,
    )
  )
    return 'auth';
  if (/Not possible to fast-forward|diverging branches|have diverged/i.test(s)) return 'diverged';
  if (/would be overwritten by merge|commit your changes or stash them/i.test(s)) return 'dirty';
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/i.test(s)) return 'rejected';
  return 'error';
}

const fail = (code: GitOpCode, ...rs: Run[]): GitOpResult => ({
  ok: false,
  code,
  ...(rs.length ? { output: out(...rs) } : {}),
});

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const running = new Set<string>();

/** 锁按仓库（common dir 的真实路径）：同一仓库从子目录 / 软链打开也共用一把锁 */
async function locked(cwd: string, fn: () => Promise<GitOpResult>): Promise<GitOpResult> {
  const common = await line(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const key = real(common || cwd);
  if (running.has(key)) return { ok: false, code: 'busy' };
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}

/** 路径（相对 cwd，同 git status）：必须是字符串、不越出仓库；不合法时整批拒绝 */
async function checkPaths(cwd: string, paths: unknown): Promise<string[] | null> {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) return null;
  const top = await line(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const base = real(cwd);
  const root = real(top);
  const list: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return null;
    if (path.isAbsolute(p)) return null;
    const rel = path.relative(root, path.resolve(base, p));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      return null;
    list.push(p);
  }
  return list;
}

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const hasHead = async (cwd: string) =>
  (await run(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;

async function stage(cwd: string, paths: string[]): Promise<Run> {
  return run(
    cwd,
    ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
    LOCAL_MS * 4,
    paths.join('\0'),
  );
}

/** 暂存（含删除、未跟踪） */
export function gitStage(cwd: string, paths: unknown): Promise<GitOpResult> {
  return locked(cwd, async () => {
    const list = await checkPaths(cwd, paths);
    if (!list) return fail('invalid');
    const r = await stage(cwd, list);
    return r.code === 0 ? { ok: true } : fail(r.timedOut ? 'timeout' : 'error', r);
  });
}

/** 取消暂存：回到 HEAD 的样子；还没有任何提交时从暂存区移除 */
export function gitUnstage(cwd: string, paths: unknown): Promise<GitOpResult> {
  return locked(cwd, async () => {
    const list = await checkPaths(cwd, paths);
    if (!list) return fail('invalid');
    const args = (await hasHead(cwd))
      ? ['restore', '--staged']
      : ['rm', '--cached', '-r', '-q', '--ignore-unmatch'];
    const r = await run(
      cwd,
      ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
      LOCAL_MS * 4,
      list.join('\0'),
    );
    return r.code === 0 ? { ok: true } : fail(r.timedOut ? 'timeout' : 'error', r);
  });
}

/**
 * 提交。给了 paths 就先暂存它们（界面在没有已暂存内容时这样用），否则只提交已暂存的。
 * 钩子照常跑；失败时暂存的状态保留，用户改完再提交。
 */
export function gitCommit(cwd: string, message: unknown, paths?: unknown): Promise<GitOpResult> {
  const msg = typeof message === 'string' ? message.replace(/\r\n?/g, '\n').trim() : '';
  if (!msg || msg.length > 20_000) return Promise.resolve(fail('invalid'));
  return locked(cwd, async () => {
    if (paths != null) {
      const list = await checkPaths(cwd, paths);
      if (!list) return fail('invalid');
      const s = await stage(cwd, list);
      if (s.code !== 0) return fail(s.timedOut ? 'timeout' : 'error', s);
    }
    // 钩子里的 pnpm / node 要用登录 shell 的 PATH
    await waitForShellPath();
    const r = await run(cwd, ['commit', '-F', '-'], HOOK_MS, `${msg}\n`);
    if (r.code !== 0) {
      if (r.timedOut) return fail('timeout', r);
      const s = `${r.stdout}\n${r.stderr}`;
      if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(s))
        return fail('nothing', r);
      return fail('hook', r);
    }
    return { ok: true, sha: await line(cwd, ['rev-parse', 'HEAD']), output: out(r) };
  });
}

/** 撤销刚才的提交（改动回到暂存区）：只在 HEAD 仍是它、而且没推送到任何远端时 */
export function gitCommitUndo(cwd: string, sha: unknown): Promise<GitOpResult> {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha))
    return Promise.resolve(fail('invalid'));
  return locked(cwd, async () => {
    if ((await line(cwd, ['rev-parse', 'HEAD'])) !== sha) return fail('moved');
    if (await line(cwd, ['branch', '-r', '--contains', sha])) return fail('pushed');
    const hasParent = (await run(cwd, ['rev-parse', '--verify', '-q', `${sha}^`])).code === 0;
    const r = hasParent
      ? await run(cwd, ['reset', '--soft', 'HEAD~1'])
      : // 第一个提交：删掉分支引用，暂存区不动（等同 soft reset）
        await run(cwd, ['update-ref', '-d', 'HEAD', sha]);
    return r.code === 0 ? { ok: true } : fail('error', r);
  });
}

async function branchOf(cwd: string) {
  return line(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
}

const config = (cwd: string, key: string) => line(cwd, ['config', '--get', key]);

async function remotesOf(cwd: string) {
  return (await line(cwd, ['remote']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 没有上游时推送用哪个远端：branch.<b>.pushRemote → remote.pushDefault → origin → 唯一的远端 */
async function pickPushRemote(cwd: string, branch: string, remotes: string[]) {
  const named =
    (await config(cwd, `branch.${branch}.pushRemote`)) || (await config(cwd, 'remote.pushDefault'));
  if (named && remotes.includes(named)) return named;
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 && !remotes[0]!.startsWith('-') ? remotes[0] : undefined;
}

/** 上游：branch.<b>.remote + branch.<b>.merge（只认远端上的分支） */
async function upstreamOf(cwd: string, branch: string) {
  const remote = await config(cwd, `branch.${branch}.remote`);
  const merge = await config(cwd, `branch.${branch}.merge`);
  if (!remote || remote === '.' || remote.startsWith('-') || !merge.startsWith('refs/heads/'))
    return null;
  return { remote, ref: merge, name: merge.slice('refs/heads/'.length) };
}

/** 分支、上游、ahead / behind（相对本地已知的远端分支，要新的先 fetch）；不是 git 仓库时 null */
export async function gitSyncStatus(cwd: string): Promise<GitSyncStatus | null> {
  const branch = await branchOf(cwd);
  const remotes = await remotesOf(cwd);
  if (!branch) {
    const sha = await line(cwd, ['rev-parse', '--short', 'HEAD']);
    return sha ? { branch: null, detached: sha, ahead: 0, behind: 0, remotes } : null;
  }
  const upstream = await line(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream) {
    return {
      branch,
      ahead: 0,
      behind: 0,
      remotes,
      pushRemote: await pickPushRemote(cwd, branch, remotes),
    };
  }
  const [behind = 0, ahead = 0] = (
    await line(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  )
    .split(/\s+/)
    .map(Number);
  return { branch, upstream, ahead: ahead || 0, behind: behind || 0, remotes };
}

/** 检查远端：fetch 上游所在的远端（没有上游就是推送会用的那个） */
export function gitFetch(cwd: string): Promise<GitOpResult> {
  return locked(cwd, async () => {
    const branch = await branchOf(cwd);
    const remotes = await remotesOf(cwd);
    const remote = branch
      ? ((await upstreamOf(cwd, branch))?.remote ?? (await pickPushRemote(cwd, branch, remotes)))
      : remotes[0];
    if (!remote) return fail('no-remote');
    if (remote.startsWith('-')) return fail('invalid');
    const r = await run(cwd, ['fetch', remote], NET_MS);
    return r.code === 0 ? { ok: true } : fail(classify(r), r);
  });
}

/** 拉取：fetch 上游再只快进；分叉时什么都不改 */
export function gitPull(cwd: string): Promise<GitOpResult> {
  return locked(cwd, async () => {
    const branch = await branchOf(cwd);
    if (!branch) return fail('detached');
    const up = await upstreamOf(cwd, branch);
    if (!up) return fail('no-upstream');
    const f = await run(cwd, ['fetch', up.remote], NET_MS);
    if (f.code !== 0) return fail(classify(f), f);
    await waitForShellPath();
    const m = await run(cwd, ['merge', '--ff-only', '@{u}'], HOOK_MS);
    return m.code === 0 ? { ok: true, output: out(m) } : fail(classify(m), m);
  });
}

/**
 * 推送当前分支。有上游：推到上游（分支名必须相同，同 push.default=simple）；
 * 没有：推到同名分支并设为上游。refspec 不带 `+`，不加 --force。
 */
export function gitPush(cwd: string): Promise<GitOpResult> {
  return locked(cwd, async () => {
    const branch = await branchOf(cwd);
    if (!branch) return fail('detached');
    const up = await upstreamOf(cwd, branch);
    let args: string[];
    if (up) {
      if (up.name !== branch) return fail('mismatch');
      const pushRemote =
        (await config(cwd, `branch.${branch}.pushRemote`)) ||
        (await config(cwd, 'remote.pushDefault'));
      const remote = pushRemote || up.remote;
      if (remote.startsWith('-')) return fail('invalid');
      args = ['push', remote, `HEAD:${up.ref}`];
    } else {
      const remote = await pickPushRemote(cwd, branch, await remotesOf(cwd));
      if (!remote) return fail('no-remote');
      args = ['push', '-u', remote, `HEAD:refs/heads/${branch}`];
    }
    await waitForShellPath();
    const r = await run(cwd, args, HOOK_MS);
    return r.code === 0 ? { ok: true, output: out(r) } : fail(classify(r), r);
  });
}

export interface GitWorktree {
  path: string;
  /** 分支名（refs/heads/ 之后）；游离 HEAD 时不给 */
  branch?: string;
  head?: string;
  detached?: boolean;
  /** 第一个：主工作区 */
  main?: boolean;
  /** 就是传入的 cwd 所在的 worktree */
  current?: boolean;
  /** Nomi 委派任务的隔离目录（.nomi-delegate/<id>） */
  delegate?: boolean;
  locked?: boolean;
  /** 目录已经不在了（git worktree prune 会清掉） */
  prunable?: boolean;
}

export interface GitWorktreeList {
  /** cwd 是附属 worktree（不是主工作区） */
  linked: boolean;
  worktrees: GitWorktree[];
}

/** 解析 `git worktree list --porcelain`：每段空行分隔，`worktree <path>` 开头 */
export function parseWorktrees(raw: string): GitWorktree[] {
  const list: GitWorktree[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    let w: GitWorktree | null = null;
    let bare = false;
    for (const l of block.split('\n')) {
      const [key, ...rest] = l.split(' ');
      const val = rest.join(' ');
      if (key === 'worktree') w = { path: val };
      else if (!w) continue;
      else if (key === 'HEAD') w.head = val;
      else if (key === 'branch') w.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'detached') w.detached = true;
      else if (key === 'bare') bare = true;
      else if (key === 'locked') w.locked = true;
      else if (key === 'prunable') w.prunable = true;
    }
    if (w && !bare) list.push(w);
  }
  return list;
}

/** 同一个仓库的所有 worktree；不是 git 仓库时 null */
export async function gitWorktrees(cwd: string): Promise<GitWorktreeList | null> {
  const top = await line(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const [gitDir, commonDir] = (
    await line(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  ).split('\n');
  const r = await run(cwd, ['worktree', 'list', '--porcelain']);
  const here = real(top);
  const worktrees = (r.code === 0 ? parseWorktrees(r.stdout) : [{ path: top }]).map((w, i) => ({
    ...w,
    ...(i === 0 ? { main: true } : {}),
    ...(real(w.path) === here ? { current: true } : {}),
    ...(/[\\/]\.nomi-delegate[\\/][^\\/]+$/.test(w.path) ? { delegate: true } : {}),
  }));
  return {
    linked: !!gitDir && !!commonDir && real(gitDir) !== real(commonDir),
    worktrees,
  };
}

/**
 * 列出来的 worktree 里，真属于 cwd 所在仓库的那些路径：它的 common dir 就是这个仓库的，
 * 而且 <w>/.git 是指回 <commonDir>/worktrees/<name> 的 gitfile（主工作区则 <w>/.git 就是 common dir）。
 * .git/worktrees/x/gitdir 可以被改成任意目录，不校验就会把仓库外的目录当成已知工作区。
 */
export async function ownedWorktrees(cwd: string, worktrees: GitWorktree[]): Promise<string[]> {
  const common = await line(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return [];
  const want = real(common);
  const owned: string[] = [];
  for (const w of worktrees) {
    if (w.prunable) continue;
    const dotgit = path.join(w.path, '.git');
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dotgit);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (real(dotgit) !== want) continue;
    } else if (st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      if (!m) continue;
      const gd = real(path.resolve(w.path, m[1]!));
      if (path.dirname(gd) !== path.join(want, 'worktrees')) continue;
    } else continue;
    const c = await line(w.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (c && real(c) === want) owned.push(w.path);
  }
  return owned;
}

/** 生成提交信息时给模型看的 diff 上限（字符）；更多的只给文件列表 */
const CONTEXT_DIFF_MAX = 24_000;
const UNTRACKED_PEEK = 1500;
const UNTRACKED_MAX = 10;
const CONTEXT_PATHS_MAX = 300;

export interface GitCommitContext {
  /** 最近的提交标题（照着仓库的风格写） */
  subjects: string[];
  stat: string;
  diff: string;
  truncated: boolean;
}

/**
 * 要提交的内容（生成提交信息用）：paths 为空 = 已暂存的；否则这些文件相对 HEAD 的改动，
 * 未跟踪的文件附上开头一段。只读。
 */
export async function gitCommitContext(
  cwd: string,
  paths?: unknown,
): Promise<GitCommitContext | null> {
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const subjects = (await line(cwd, ['log', '-10', '--format=%s'])).split('\n').filter(Boolean);
  let stat: string;
  let diff: string;
  if (paths == null) {
    stat = await line(cwd, ['diff', ...flags, '--cached', '--stat']);
    diff = (await run(cwd, ['diff', ...flags, '--cached'])).stdout;
  } else {
    const all = await checkPaths(cwd, paths);
    if (!all) return null;
    // 命令行长度有上限（Windows 约 32K）：只看前面这些文件
    const list = all.slice(0, CONTEXT_PATHS_MAX);
    const head = (await hasHead(cwd)) ? ['HEAD'] : ['--cached'];
    const spec = ['--literal-pathspecs'];
    stat = await line(cwd, [...spec, 'diff', ...flags, '--stat', ...head, '--', ...list]);
    diff = (await run(cwd, [...spec, 'diff', ...flags, ...head, '--', ...list])).stdout;
    const untracked = (
      await line(cwd, [...spec, 'ls-files', '--others', '--exclude-standard', '--', ...list])
    )
      .split('\n')
      .filter(Boolean);
    const base = real(cwd);
    const top = real(await line(cwd, ['rev-parse', '--show-toplevel']));
    const peeks = untracked.slice(0, UNTRACKED_MAX).map((f) => {
      let head = '';
      try {
        const file = path.resolve(base, f);
        const st = fs.lstatSync(file);
        // 软链、非普通文件不读：可能指向仓库外的密钥
        if (st.isSymbolicLink()) return `new file: ${f}\n(symlink)`;
        if (!st.isFile() || !inside(top, real(file))) return `new file: ${f}`;
        const buf = fs.readFileSync(file).subarray(0, UNTRACKED_PEEK);
        head = buf.includes(0) ? '(binary)' : buf.toString('utf8');
      } catch {
        /* 读不了就只给文件名 */
      }
      return `new file: ${f}\n${head}`;
    });
    if (untracked.length > UNTRACKED_MAX)
      peeks.push(`… ${untracked.length - UNTRACKED_MAX} more new files`);
    if (untracked.length) {
      stat = [stat, ...untracked.map((f) => ` ${f} (new)`)].filter(Boolean).join('\n');
      diff = [diff, ...peeks].filter(Boolean).join('\n');
    }
  }
  const truncated = diff.length > CONTEXT_DIFF_MAX;
  return { subjects, stat, diff: truncated ? diff.slice(0, CONTEXT_DIFF_MAX) : diff, truncated };
}

const DISCARD_TAG = 'nomi: discard';
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

async function stashPush(cwd: string, args: string[], paths: string[], label: string) {
  const before = await line(cwd, ['rev-parse', '-q', '--verify', 'refs/stash']);
  const r = await run(
    cwd,
    [
      '--literal-pathspecs',
      'stash',
      'push',
      ...args,
      '-m',
      label,
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ],
    LOCAL_MS * 4,
    paths.join('\0'),
  );
  const sha = await line(cwd, ['rev-parse', '-q', '--verify', 'refs/stash']);
  // 没有可存的改动时 git 不建 stash（退出码也是 0）
  return { r, sha: sha && sha !== before ? sha : '' };
}

/**
 * 放弃这些文件未暂存的改动（含未跟踪文件）：存进 git stash 而不是直接丢掉，可以撤销；已暂存的部分留着。
 * 已跟踪的和未跟踪的分两个 stash（git 的 --keep-index 碰上未跟踪文件的路径会出错），按创建顺序返回。
 */
export function gitDiscard(
  cwd: string,
  paths: unknown,
): Promise<GitOpResult & { stashes?: string[] }> {
  return locked(cwd, async () => {
    const list = await checkPaths(cwd, paths);
    if (!list) return fail('invalid');
    if (!(await hasHead(cwd))) return fail('invalid');
    const top = real(await line(cwd, ['rev-parse', '--show-toplevel']));
    const others = new Set(
      (await run(top, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
        .split('\0')
        .filter(Boolean)
        .map((f) => path.resolve(top, f)),
    );
    const base = real(cwd);
    const untracked = list.filter((p) => others.has(path.resolve(base, p)));
    const tracked = list.filter((p) => !others.has(path.resolve(base, p)));
    const label = `${DISCARD_TAG} ${list.length}`;
    const stashes: string[] = [];
    if (tracked.length) {
      const t = await stashPush(cwd, ['--keep-index'], tracked, label);
      if (t.r.code !== 0) return fail(t.r.timedOut ? 'timeout' : 'error', t.r);
      if (t.sha) stashes.push(t.sha);
    }
    if (untracked.length) {
      const u = await stashPush(cwd, ['--include-untracked'], untracked, label);
      if (u.r.code !== 0) return { ...fail(u.r.timedOut ? 'timeout' : 'error', u.r), stashes };
      if (u.sha) stashes.push(u.sha);
    }
    return stashes.length ? { ok: true, stashes } : fail('nothing');
  });
}

const stashIndex = async (cwd: string, sha: string) =>
  (await line(cwd, ['stash', 'list', '--format=%H'])).split('\n').indexOf(sha);

/**
 * 撤销放弃。已跟踪的：工作区按 stash 里的样子还原（暂存区不动，不做合并，所以不会冲突），
 * 前提是这些文件之后没再改过；未跟踪的：stash pop。成功后删掉对应的 stash。
 */
export function gitDiscardUndo(cwd: string, stashes: unknown): Promise<GitOpResult> {
  const list = Array.isArray(stashes) ? stashes : [stashes];
  if (
    !list.length ||
    list.length > 2 ||
    !list.every((s) => typeof s === 'string' && SHA_RE.test(s))
  )
    return Promise.resolve(fail('invalid'));
  return locked(cwd, async () => {
    const top = real(await line(cwd, ['rev-parse', '--show-toplevel']));
    for (const sha of list as string[]) if ((await stashIndex(top, sha)) < 0) return fail('moved');
    for (const sha of list as string[]) {
      const untracked = (await run(top, ['rev-parse', '-q', '--verify', `${sha}^3`])).code === 0;
      if (untracked) {
        const r = await run(top, ['stash', 'pop', '-q', `stash@{${await stashIndex(top, sha)}}`]);
        if (r.code !== 0) return fail('error', r);
        continue;
      }
      // stash 的第二个父提交是当时的暂存区：它和工作区（stash 本身）之间的差别就是放弃掉的
      const changes = (
        await run(top, ['diff', '--name-status', '-z', '--no-renames', `${sha}^2`, sha])
      ).stdout.split('\0');
      const restore: string[] = [];
      const remove: string[] = [];
      for (let i = 0; i + 1 < changes.length; i += 2) {
        const [st, f] = [changes[i]!, changes[i + 1]!];
        if (!f) continue;
        (st === 'D' ? remove : restore).push(f);
      }
      const all = [...restore, ...remove];
      if (all.length) {
        // 放弃之后又改过：不覆盖（git diff 没有 --pathspec-from-file，分批放进参数）
        for (let k = 0; k < all.length; k += 200) {
          const dirty = await run(top, [
            '--literal-pathspecs',
            'diff',
            '--name-only',
            '--',
            ...all.slice(k, k + 200),
          ]);
          if (dirty.code !== 0) return fail('error', dirty);
          if (dirty.stdout.trim()) return fail('moved', dirty);
        }
      }
      if (restore.length) {
        const r = await run(
          top,
          [
            '--literal-pathspecs',
            'restore',
            `--source=${sha}`,
            '--worktree',
            '--pathspec-from-file=-',
            '--pathspec-file-nul',
          ],
          LOCAL_MS * 4,
          restore.join('\0'),
        );
        if (r.code !== 0) return fail('error', r);
      }
      for (const f of remove) {
        const file = path.resolve(top, f);
        // 上级目录换成了指向仓库外的软链：不删
        if (!inside(top, real(path.dirname(file)))) return fail('invalid');
        fs.rmSync(file, { force: true });
      }
      const d = await run(top, ['stash', 'drop', '-q', `stash@{${await stashIndex(top, sha)}}`]);
      if (d.code !== 0) return fail('error', d);
    }
    return { ok: true };
  });
}
