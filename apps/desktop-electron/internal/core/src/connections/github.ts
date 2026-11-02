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

/** owner/name；不接受 `.` / `..` 这样的段（会拼出模板以外的路径） */
export const isRepo = (r: string) =>
  REPO.test(r) && r.split('/').every((x) => x !== '.' && x !== '..');
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
  const repo = () => need(p.repo, isRepo, 'repo');
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
  init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
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

// ---------- 对外能力（C3）：github.comment / github.pr.create ----------

export interface GithubCommentParams {
  repo: string;
  number: number;
  body: string;
}

export interface GithubPrParams {
  repo: string;
  /** 只允许推到 `nomi/` 前缀的分支（connections.md §2） */
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

/** 写请求：方法、路径与字段（字段逐项传，不拼 URL） */
export interface GithubWriteRequest {
  method: 'POST';
  path: string;
  fields: Record<string, string | boolean>;
}

const HEAD = /^nomi\/[A-Za-z0-9_./-]{1,200}$/;
const MAX_BODY = 60_000;

export function buildCommentRequest(p: GithubCommentParams): GithubWriteRequest {
  if (!isRepo(p.repo)) throw new GithubParamError('invalid repo');
  if (!Number.isInteger(p.number) || p.number <= 0 || p.number >= 1e9)
    throw new GithubParamError('invalid number');
  if (!p.body.trim() || p.body.length > MAX_BODY) throw new GithubParamError('invalid body');
  return {
    method: 'POST',
    path: `/repos/${p.repo}/issues/${p.number}/comments`,
    fields: { body: p.body },
  };
}

export function buildPrRequest(p: GithubPrParams): GithubWriteRequest {
  if (!isRepo(p.repo)) throw new GithubParamError('invalid repo');
  if (!HEAD.test(p.head) || p.head.includes('..'))
    throw new GithubParamError('head must be a nomi/ branch');
  if (!REF.test(p.base) || p.base.includes('..')) throw new GithubParamError('invalid base');
  if (!p.title.trim() || p.title.length > 256) throw new GithubParamError('invalid title');
  if ((p.body ?? '').length > MAX_BODY) throw new GithubParamError('invalid body');
  return {
    method: 'POST',
    path: `/repos/${p.repo}/pulls`,
    fields: {
      title: p.title,
      head: p.head,
      base: p.base,
      body: p.body ?? '',
      ...(p.draft ? { draft: true } : {}),
    },
  };
}

/** 写请求的结果：GitHub 明确拒绝（4xx 带错误正文）= 确定没生效；断网、超时、5xx = 不确定 */
export class GithubWriteError extends Error {
  constructor(
    message: string,
    readonly definite: boolean,
  ) {
    super(message);
  }
}

/** gh api 的写请求：字符串字段用 --raw-field（不解析 @文件），布尔用 -F */
export function ghWriteArgs(host: string, req: GithubWriteRequest): string[] {
  // --include：状态行与响应头也写到 stdout，按状态码判断「确定没生效」（4xx）还是不确定（5xx、断网）
  const args = ['api', '--method', req.method, '--include', '--hostname', host, req.path];
  for (const [k, v] of Object.entries(req.fields))
    if (typeof v === 'boolean') args.push('-F', `${k}=${v}`);
    else args.push('--raw-field', `${k}=${v}`);
  return args;
}

/** `gh api --include` 的输出：状态码（没有状态行 = 请求没拿到响应）与正文 */
export function splitIncluded(out: string): { status: number | null; body: string } {
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(out);
  if (!m) return { status: null, body: out };
  const sep = /\r?\n\r?\n/.exec(out);
  return { status: Number(m[1]), body: sep ? out.slice(sep.index + sep[0].length) : '' };
}

/** 4xx（除 408 / 429）= GitHub 处理了请求并拒绝，确定没生效 */
export const definiteRejection = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

export async function ghWrite(run: RunGh, host: string, req: GithubWriteRequest): Promise<unknown> {
  const r = await run(ghWriteArgs(host, req));
  const { status, body } = splitIncluded(r.stdout);
  let data: unknown = null;
  try {
    data = JSON.parse(body || 'null');
  } catch {
    /* 非 JSON */
  }
  if (r.code === 0 && (status === null || status < 300)) return data;
  const msg = (data as { message?: unknown } | null)?.message;
  const text = `GitHub ${status ?? `gh ${r.code}`}${typeof msg === 'string' ? `: ${msg}` : ''}`;
  throw new GithubWriteError(text, status !== null && definiteRejection(status));
}

/** 带令牌的写请求 */
export async function tokenWrite(
  fetchFn: FetchLike,
  host: string,
  token: string,
  req: GithubWriteRequest,
): Promise<unknown> {
  const url = assertPublicHttpUrl(`${apiBase(host)}${req.path}`).toString();
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nomi',
      },
      body: JSON.stringify(req.fields),
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GithubWriteError(e instanceof Error ? e.message : String(e), false);
  }
  if (!res.ok) throw new GithubWriteError(`GitHub ${res.status}`, definiteRejection(res.status));
  return res.json();
}
