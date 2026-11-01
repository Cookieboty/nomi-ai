/**
 * GitHub 连接的适配器（docs/design/connections.md §4；依据 persistent-tasks-references.md §2.13）。
 *
 * - 检测：`gh auth status --json hosts --hostname <host> --no-refresh`（输出不含令牌；--no-refresh 不改动用户的登录）；
 * - 只拼固定请求：能力 → 请求模板，模型给的是参数，不是 URL；仓库不在授权范围里直接拒绝；
 * - cli-login：`gh api` 逐项传参、不经 shell，子进程环境只留必要变量；Nomi 不读取令牌（不调 `gh auth token`）；
 * - keychain：内核直接请求（Authorization 头在内核里加），先过 netGuard。
 */
import { execFile } from 'node:child_process';

import { assertPublicHttpUrl } from '../security/netGuard';

export interface GhAccount {
  host: string;
  login: string;
  scopes: string[];
  tokenSource: string;
  active: boolean;
  state: string;
}

/** 远多于「读」的权限：添加连接时如实提示 */
const WIDE = new Set([
  'repo',
  'workflow',
  'delete_repo',
  'write:packages',
  'delete:packages',
  'write:org',
  'write:public_key',
  'write:repo_hook',
]);
export function wideScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => WIDE.has(s) || s.startsWith('admin:'));
}

/** 解析 `gh auth status --json hosts` 的输出 */
export function parseAuthStatus(raw: string): GhAccount[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const hosts = (v as { hosts?: Record<string, unknown[]> }).hosts;
  if (!hosts || typeof hosts !== 'object') return [];
  const out: GhAccount[] = [];
  for (const [host, list] of Object.entries(hosts)) {
    if (!Array.isArray(list)) continue;
    for (const a of list as Array<Record<string, unknown>>) {
      if (typeof a?.login !== 'string') continue;
      out.push({
        host,
        login: a.login,
        scopes:
          typeof a.scopes === 'string'
            ? a.scopes
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        tokenSource: typeof a.tokenSource === 'string' ? a.tokenSource : '',
        active: a.active === true,
        state: typeof a.state === 'string' ? a.state : '',
      });
    }
  }
  return out;
}

export const GITHUB_ENDPOINTS = [
  'repo',
  'issues',
  'issue',
  'issue_comments',
  'pulls',
  'pull',
  'commits',
  'check_runs',
  'workflow_runs',
  'notifications',
] as const;
export type GithubEndpoint = (typeof GITHUB_ENDPOINTS)[number];

export interface GithubReadParams {
  endpoint: GithubEndpoint;
  repo?: string;
  number?: number;
  ref?: string;
  since?: string;
  state?: 'open' | 'closed' | 'all';
  branch?: string;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
const SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export class GithubParamError extends Error {
  readonly code = 'bad_params';
}

/** 能力 github.read 的请求模板：参数 → 路径与查询（全部校验，拒绝拼出模板以外的路径） */
export function buildReadRequest(p: GithubReadParams): {
  path: string;
  query: Record<string, string>;
} {
  const need = <T>(v: T | undefined, ok: (v: T) => boolean, what: string): T => {
    if (v === undefined || !ok(v)) throw new GithubParamError(`invalid ${what}`);
    return v;
  };
  const repo = () => need(p.repo, (r) => REPO.test(r), 'repo');
  const num = () => need(p.number, (n) => Number.isInteger(n) && n > 0 && n < 1e9, 'number');
  const query: Record<string, string> = { per_page: '50' };
  if (p.since !== undefined) query.since = need(p.since, (s) => SINCE.test(s), 'since');
  if (p.state !== undefined)
    query.state = need(p.state, (s) => ['open', 'closed', 'all'].includes(s), 'state');
  switch (p.endpoint) {
    case 'repo':
      return { path: `/repos/${repo()}`, query: {} };
    case 'issues':
      return { path: `/repos/${repo()}/issues`, query };
    case 'issue':
      return { path: `/repos/${repo()}/issues/${num()}`, query: {} };
    case 'issue_comments':
      return { path: `/repos/${repo()}/issues/${num()}/comments`, query };
    case 'pulls':
      return { path: `/repos/${repo()}/pulls`, query };
    case 'pull':
      return { path: `/repos/${repo()}/pulls/${num()}`, query: {} };
    case 'commits':
      if (p.ref !== undefined) query.sha = need(p.ref, (r) => REF.test(r), 'ref');
      return { path: `/repos/${repo()}/commits`, query };
    case 'check_runs':
      return {
        path: `/repos/${repo()}/commits/${encodeURIComponent(need(p.ref, (r) => REF.test(r), 'ref'))}/check-runs`,
        query: { per_page: '50' },
      };
    case 'workflow_runs':
      if (p.branch !== undefined) query.branch = need(p.branch, (r) => REF.test(r), 'branch');
      return { path: `/repos/${repo()}/actions/runs`, query };
    case 'notifications':
      return { path: '/notifications', query };
  }
}

/** 通知不按单个仓库请求：结果里只留授权范围内仓库的条目 */
export function filterByRepos(
  endpoint: GithubEndpoint,
  data: unknown,
  repos: readonly string[] | null,
): unknown {
  if (endpoint !== 'notifications' || repos === null || !Array.isArray(data)) return data;
  const allow = new Set(repos.map((r) => r.toLowerCase()));
  return data.filter((n) => {
    const name = (n as { repository?: { full_name?: unknown } })?.repository?.full_name;
    return typeof name === 'string' && allow.has(name.toLowerCase());
  });
}

export const GH_TIMEOUT_MS = 30_000;

/** 子进程环境：只留必要变量，关交互（gh 里环境变量优先于已存的登录，所以也不传任何 *_TOKEN） */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'GH_CONFIG_DIR',
    'SystemRoot',
    'TMPDIR',
    'TEMP',
    'TMP',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.NO_COLOR = '1';
  return env;
}

export type RunGh = (args: string[]) => Promise<{ stdout: string; code: number }>;

export const runGh: RunGh = (args) =>
  new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { env: ghEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const raw = (error as { code?: unknown } | null)?.code;
        // 没装 gh：ENOENT（字符串）→ 按 127 处理
        const code = !error ? 0 : raw === 'ENOENT' ? 127 : typeof raw === 'number' ? raw : 1;
        resolve({ stdout: String(stdout ?? ''), code });
      },
    );
  });

/** gh 是否安装 / 当前各账号（不含令牌） */
export async function ghAccounts(
  run: RunGh,
  host?: string,
): Promise<{ installed: boolean; accounts: GhAccount[] }> {
  const args = ['auth', 'status', '--json', 'hosts', '--no-refresh'];
  if (host) args.push('--hostname', host);
  const r = await run(args).catch(() => ({ stdout: '', code: 127 }));
  if (r.code === 127) return { installed: false, accounts: [] };
  if (r.code !== 0 && !r.stdout) return { installed: true, accounts: [] };
  return { installed: true, accounts: parseAuthStatus(r.stdout) };
}

const querystring = (q: Record<string, string>) => {
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : '';
};

/** 经本机 gh 登录发 GET（参数逐项传，不经 shell） */
export async function ghGet(
  run: RunGh,
  host: string,
  path: string,
  query: Record<string, string>,
): Promise<unknown> {
  const r = await run([
    'api',
    '--method',
    'GET',
    '--hostname',
    host,
    `${path}${querystring(query)}`,
  ]);
  if (r.code !== 0) throw new Error(`gh api failed (${r.code}): ${r.stdout.slice(0, 300)}`);
  return JSON.parse(r.stdout || 'null');
}

export function apiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** 带令牌的 GET（令牌只在这一刻出现在内核内存里） */
export async function tokenGet(
  fetchFn: FetchLike,
  host: string,
  token: string,
  path: string,
  query: Record<string, string>,
): Promise<{ data: unknown; scopes: string[] | null }> {
  const url = assertPublicHttpUrl(`${apiBase(host)}${path}${querystring(query)}`).toString();
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nomi',
    },
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const scopesHeader = res.headers.get('x-oauth-scopes');
  return {
    data: await res.json(),
    // 细粒度令牌没有这个头：null = 不知道（用细粒度令牌时按仓库授权看）
    scopes:
      scopesHeader === null
        ? null
        : scopesHeader
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
  };
}
