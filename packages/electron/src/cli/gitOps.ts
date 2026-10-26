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
  | 'timeout'
  | 'error';

export interface GitOpResult {
  ok: boolean;
  code?: GitOpCode;
  /** git 的原始输出（截到最后 8 KB） */
  output?: string;
  /** 提交：新提交的完整 sha */
  sha?: string;
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
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: gitEnv() },
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
  return s.length > OUTPUT_MAX ? `…${s.slice(-OUTPUT_MAX)}` : s;
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

const running = new Set<string>();

async function locked(cwd: string, fn: () => Promise<GitOpResult>): Promise<GitOpResult> {
  const key = path.resolve(cwd);
  if (running.has(key)) return { ok: false, code: 'busy' };
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

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
