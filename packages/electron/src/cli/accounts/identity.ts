/**
 * 官方账号的身份（只读非凭据信息，S7）：
 * - Claude：`claude auth status --json`（随 CLAUDE_CONFIG_DIR 变化，给出邮箱 / 套餐 / 组织），
 *   失败时退回 .claude.json 的 oauthAccount（只有身份字段，不含令牌）；
 * - Codex：`codex login status` 只给出是否登录；
 * - Grok：官方 ACP initialize 里的认证方式（cached_token = 已用账号登录）；
 * - Gemini：.gemini/google_accounts.json 的 active（邮箱列表，不含凭据）。
 * 读不到邮箱时显示用户给账号起的名字。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readGrokAuthStatus } from '../../usage/grokAuth';
import { runLimited, STDOUT_LIMIT } from '../../usage/limitedProcess';
import { resolveCliBinAsync, withCliPath } from '../detect';

import { officialAccountEnv, userCliHome } from './homes';
import type { AccountKind } from './types';

export interface ReadIdentity {
  loggedIn: boolean;
  email?: string;
  plan?: string;
  org?: string;
  /** 稳定键（同一账号多次登录得到同一个值），判断「同一身份登录在两个目录」用（S10） */
  key?: string;
}

const STATUS_TIMEOUT_MS = 15_000;

export interface IdentityDeps {
  /** 测试注入：CLI 状态命令的输出 */
  run?: (
    kind: AccountKind,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; code: number | null } | null>;
  grokAuth?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

async function runStatus(
  kind: AccountKind,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number | null } | null> {
  const bin = await resolveCliBinAsync(kind).catch(() => null);
  if (!bin) return null;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-acct-status-'));
  try {
    return await runLimited(bin, args, {
      cwd,
      env,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBytes: STDOUT_LIMIT,
    });
  } catch {
    return null;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Claude `auth status --json` 的输出 → 身份 */
export function parseClaudeStatus(stdout: string): ReadIdentity | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (j.loggedIn !== true) return { loggedIn: false };
  const email = str(j.email);
  return {
    loggedIn: true,
    ...(email ? { email, key: email.toLowerCase() } : {}),
    ...(str(j.subscriptionType) ? { plan: str(j.subscriptionType) } : {}),
    ...(str(j.orgName) ? { org: str(j.orgName) } : {}),
  };
}

/** .claude.json 的 oauthAccount（只有身份字段）→ 身份；状态命令不可用时的退路 */
export function claudeIdentityFromConfig(
  configDir: string,
  userDefault: boolean,
): ReadIdentity | null {
  const file = fs.existsSync(path.join(configDir, '.claude.json'))
    ? path.join(configDir, '.claude.json')
    : userDefault
      ? path.join(path.dirname(configDir), '.claude.json')
      : null;
  const oa = file ? readJson(file)?.oauthAccount : null;
  if (!oa || typeof oa !== 'object') return null;
  const o = oa as Record<string, unknown>;
  const email = str(o.emailAddress);
  const key = str(o.accountUuid) ?? email?.toLowerCase();
  return {
    loggedIn: true,
    ...(email ? { email } : {}),
    ...(key ? { key } : {}),
    ...(str(o.organizationName) ? { org: str(o.organizationName) } : {}),
  };
}

/**
 * 读某个账号目录（null = 用户自己的 CLI 目录，即默认账号）的身份。读不到返回 { loggedIn: false }。
 */
export async function readIdentity(
  kind: AccountKind,
  accountDir: string | null,
  d: IdentityDeps = {},
): Promise<ReadIdentity> {
  const baseEnv = d.env ?? withCliPath(process.env);
  const env = officialAccountEnv(kind, baseEnv, accountDir);
  const run = d.run ?? runStatus;
  if (kind === 'claude') {
    const r = await run(kind, ['auth', 'status', '--json'], env);
    const parsed = r ? parseClaudeStatus(r.stdout) : null;
    if (parsed) return parsed;
    const dir = accountDir ?? userCliHome('claude', baseEnv, d.home);
    return claudeIdentityFromConfig(dir, !accountDir) ?? { loggedIn: false };
  }
  if (kind === 'codex') {
    const r = await run(kind, ['login', 'status'], env);
    const text = r?.stdout ?? '';
    return { loggedIn: /logged in/i.test(text) && !/not logged in/i.test(text) };
  }
  if (kind === 'grok') {
    const mode = await (d.grokAuth ?? ((e) => readGrokAuthStatus({ env: () => e })))(env);
    return { loggedIn: mode === 'cached_token' };
  }
  // gemini
  const root = accountDir ?? userCliHome('gemini', baseEnv, d.home);
  const accounts = readJson(path.join(root, '.gemini', 'google_accounts.json'));
  const email = str(accounts?.active);
  const loggedIn = fs.existsSync(path.join(root, '.gemini', 'oauth_creds.json'));
  return { loggedIn, ...(email ? { email, key: email.toLowerCase() } : {}) };
}
