/**
 * 四个 CLI 的全局凭据适配器（docs/design/cli-official-accounts.md §3）：读 / 写全局凭据，解析身份与新旧。
 * 只碰凭据本身：Claude 的 credentials 只替换 `claudeAiOauth`（保留 mcpOAuth 等其它键），`.claude.json` 只替换
 * `oauthAccount`；Gemini 的 `google_accounts.json` 只改 `active`。写文件一律 0600 原子写。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeConfigDir, codexHomeDir, geminiDir, grokHomeDir } from '../../usage/cliHomes';
import { writePrivateFileAtomic } from '../../utils/privateFile';

import { macKeychain, type KeychainAdapter } from './keychain';
import type { AccountIdentity, AccountKind, CredFiles, LiveCreds } from './types';

export interface AdapterEnv {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  keychain?: KeychainAdapter;
}

export interface CredAdapter {
  kind: AccountKind;
  /** 当前全局登录；没登录返回 null */
  read(): Promise<LiveCreds | null>;
  /** 把一份凭据写成全局登录 */
  write(files: CredFiles): Promise<void>;
  /** 从一份凭据解析身份与新旧（保险箱里的凭据也走这里） */
  inspect(files: CredFiles): { identity: AccountIdentity | null; freshness: number | null };
  /** 切换前置检查：返回不能切换的原因（null = 可以） */
  precheck(): string | null;
}

// ───────────────────────── 工具 ─────────────────────────

const readText = (f: string): string | null => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const mtime = (f: string): number | null => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return null;
  }
};
const parseObj = (s: string | null | undefined): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const j = JSON.parse(s) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 只解 JWT 的 payload（不校验签名，只用来取展示用的 email / sub） */
export function jwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return parseObj(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
  } catch {
    return null;
  }
}

/** 在嵌套对象里找第一个某名字的字符串字段（Grok 的 auth.json 字段名未在真机核对） */
function findField(o: unknown, names: string[], depth = 0): string | undefined {
  if (!o || typeof o !== 'object' || depth > 4) return undefined;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (names.includes(k) && typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(o as Record<string, unknown>)) {
    const hit = findField(v, names, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** 合并写 JSON 文件的某一个键（文件里其它内容原样保留） */
function patchJsonKey(file: string, key: string, value: unknown) {
  const cur = parseObj(readText(file)) ?? {};
  if (value === undefined) delete cur[key];
  else cur[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivateFileAtomic(file, JSON.stringify(cur, null, 2));
}

// ───────────────────────── Claude ─────────────────────────

/** Claude 在 macOS 钥匙串里的服务名：设了 CLAUDE_CONFIG_DIR 时追加目录的 sha256 前 8 位（2.1.303 源码） */
export function claudeKeychainService(env: NodeJS.ProcessEnv, configDir: string): string {
  const base = 'Claude Code-credentials';
  if (!env.CLAUDE_CONFIG_DIR) return base;
  return `${base}-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

export function claudeAccountName(env: NodeJS.ProcessEnv): string {
  let name: string;
  try {
    name = env.USER || os.userInfo().username;
  } catch {
    name = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

export function claudeAdapter(o: AdapterEnv = {}): CredAdapter {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const keychain = o.keychain ?? macKeychain;
  const dir = claudeConfigDir(home, env);
  const credFile = path.join(dir, '.credentials.json');
  const globalJson = env.CLAUDE_CONFIG_DIR
    ? path.join(dir, '.claude.json')
    : path.join(home, '.claude.json');
  const service = claudeKeychainService(env, dir);
  const account = claudeAccountName(env);
  const mac = platform === 'darwin';

  const readStore = async () => (mac ? keychain.get(service, account) : readText(credFile));
  const inspect = (files: CredFiles) => {
    const oauth = parseObj(files.credentials);
    const acct = parseObj(files.oauthAccount);
    const key = str(acct?.accountUuid) ?? str(acct?.emailAddress);
    return {
      identity: key
        ? {
            key,
            email: str(acct?.emailAddress),
            plan: str(oauth?.subscriptionType),
            org: str(acct?.organizationName),
          }
        : null,
      freshness: num(oauth?.expiresAt) ?? null,
    };
  };
  return {
    kind: 'claude',
    inspect,
    precheck: () => null,
    async read() {
      const store = parseObj(await readStore());
      const oauth = store?.claudeAiOauth;
      if (!oauth || typeof oauth !== 'object') return null;
      const acct = parseObj(readText(globalJson))?.oauthAccount;
      const files: CredFiles = {
        credentials: JSON.stringify(oauth),
        ...(acct && typeof acct === 'object' ? { oauthAccount: JSON.stringify(acct) } : {}),
      };
      return { files, ...inspect(files) };
    },
    async write(files) {
      const oauth = parseObj(files.credentials);
      if (!oauth) throw new Error('claude credentials missing');
      // 只替换 claudeAiOauth；同一存储里的其它键（如 MCP 的 OAuth）保留
      const cur = parseObj(await readStore()) ?? {};
      const next = JSON.stringify({ ...cur, claudeAiOauth: oauth });
      if (mac) await keychain.set(service, account, next);
      else {
        fs.mkdirSync(dir, { recursive: true });
        writePrivateFileAtomic(credFile, next);
      }
      patchJsonKey(globalJson, 'oauthAccount', parseObj(files.oauthAccount) ?? undefined);
    },
  };
}

// ───────────────────────── Codex ─────────────────────────

export function codexAdapter(o: AdapterEnv = {}): CredAdapter {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const dir = codexHomeDir(home, env);
  const file = path.join(dir, 'auth.json');
  const inspect = (files: CredFiles) => {
    const j = parseObj(files['auth.json']);
    const tokens = (j?.tokens ?? {}) as Record<string, unknown>;
    const id = jwtPayload(tokens.id_token);
    const auth = (id?.['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const email = str(id?.email);
    const accountId = str(tokens.account_id) ?? str(auth.chatgpt_account_id);
    const key = [str(id?.sub) ?? email, accountId].filter(Boolean).join('|');
    const last = str(j?.last_refresh);
    return {
      identity: key ? { key, email, plan: str(auth.chatgpt_plan_type), org: accountId } : null,
      freshness: last ? Date.parse(last) || null : null,
    };
  };
  return {
    kind: 'codex',
    inspect,
    precheck() {
      // 钥匙串存储时 auth.json 不是真实凭据：先请用户改成文件存储（§5 第 6 步）
      const toml = readText(path.join(dir, 'config.toml')) ?? '';
      const m = /^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m.exec(toml);
      return m && m[1] !== 'file' ? 'codex-keyring' : null;
    },
    async read() {
      const text = readText(file);
      const j = parseObj(text);
      if (!text || !j || !j.tokens) return null;
      const files = { 'auth.json': text };
      const info = inspect(files);
      return { files, ...info, freshness: info.freshness ?? mtime(file) };
    },
    async write(files) {
      if (!parseObj(files['auth.json'])) throw new Error('codex auth.json missing');
      fs.mkdirSync(dir, { recursive: true });
      writePrivateFileAtomic(file, files['auth.json']!);
    },
  };
}

// ───────────────────────── Grok ─────────────────────────

export function grokAdapter(o: AdapterEnv = {}): CredAdapter {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const dir = grokHomeDir(home, env);
  const file = path.join(dir, 'auth.json');
  const lock = path.join(dir, 'auth.json.lock');
  const inspect = (files: CredFiles) => {
    const j = parseObj(files['auth.json']);
    const token = findField(j, ['id_token', 'access_token', 'accessToken']);
    const claims = jwtPayload(token);
    const email = findField(j, ['email']) ?? str(claims?.email);
    const key = findField(j, ['user_id', 'userId']) ?? str(claims?.sub) ?? email;
    const exp = num(claims?.exp);
    return {
      identity: key ? { key, email } : null,
      freshness: exp ? exp * 1000 : null,
    };
  };
  return {
    kind: 'grok',
    inspect,
    precheck() {
      // Grok 刷新 token 时持有 auth.json.lock：正在刷新就稍后再切，不和它抢写
      try {
        const st = fs.statSync(lock);
        return Date.now() - st.mtimeMs < 30_000 && st.size > 0 ? 'grok-refreshing' : null;
      } catch {
        return null;
      }
    },
    async read() {
      const text = readText(file);
      if (!text || !parseObj(text)) return null;
      const files = { 'auth.json': text };
      const info = inspect(files);
      return { files, ...info, freshness: info.freshness ?? mtime(file) };
    },
    async write(files) {
      if (!parseObj(files['auth.json'])) throw new Error('grok auth.json missing');
      fs.mkdirSync(dir, { recursive: true });
      writePrivateFileAtomic(file, files['auth.json']!);
    },
  };
}

// ───────────────────────── Gemini ─────────────────────────

export function geminiAdapter(o: AdapterEnv = {}): CredAdapter {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const dir = geminiDir(home, env);
  const creds = path.join(dir, 'oauth_creds.json');
  const accounts = path.join(dir, 'google_accounts.json');
  const inspect = (files: CredFiles) => {
    const c = parseObj(files['oauth_creds.json']);
    const a = parseObj(files['google_accounts.json']);
    const id = jwtPayload(c?.id_token);
    const email = str(a?.active) ?? str(id?.email);
    const key = str(id?.sub) ?? email;
    return { identity: key ? { key, email } : null, freshness: num(c?.expiry_date) ?? null };
  };
  return {
    kind: 'gemini',
    inspect,
    precheck() {
      // 开了加密存储：凭据在钥匙串 / 加密文件里，暂不支持全局切换
      const v = env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
      return v === 'true' || v === '1' ? 'gemini-encrypted-storage' : null;
    },
    async read() {
      const text = readText(creds);
      const c = parseObj(text);
      if (!text || !c || !(c.refresh_token || c.access_token)) return null;
      const acc = readText(accounts);
      const files: CredFiles = {
        'oauth_creds.json': text,
        ...(acc ? { 'google_accounts.json': acc } : {}),
      };
      const info = inspect(files);
      return { files, ...info, freshness: info.freshness ?? mtime(creds) };
    },
    async write(files) {
      if (!parseObj(files['oauth_creds.json'])) throw new Error('gemini oauth_creds.json missing');
      fs.mkdirSync(dir, { recursive: true });
      writePrivateFileAtomic(creds, files['oauth_creds.json']!);
      // google_accounts.json 只更新 active；old 列表保留
      const email = inspect(files).identity?.email;
      if (email) {
        const cur = parseObj(readText(accounts)) ?? {};
        const old = Array.isArray(cur.old) ? (cur.old as unknown[]).filter((x) => x !== email) : [];
        const prev = str(cur.active);
        if (prev && prev !== email && !old.includes(prev)) old.push(prev);
        writePrivateFileAtomic(accounts, JSON.stringify({ ...cur, active: email, old }, null, 2));
      }
      // 认证方式改成 Google 登录，否则 settings.json 里选的 API Key 等方式会让切换不生效。
      // 带注释（JSONC）解析不了的设置文件不碰
      const settingsPath = path.join(dir, 'settings.json');
      const raw = readText(settingsPath);
      const settings = raw === null ? {} : parseObj(raw);
      if (settings) {
        const security = (settings.security ?? {}) as Record<string, unknown>;
        const auth = (security.auth ?? {}) as Record<string, unknown>;
        if (auth.selectedType !== 'oauth-personal') {
          const next = {
            ...settings,
            security: { ...security, auth: { ...auth, selectedType: 'oauth-personal' } },
          };
          writePrivateFileAtomic(settingsPath, JSON.stringify(next, null, 2));
        }
      }
    },
  };
}

export function adapterFor(kind: AccountKind, o: AdapterEnv = {}): CredAdapter {
  return kind === 'claude'
    ? claudeAdapter(o)
    : kind === 'codex'
      ? codexAdapter(o)
      : kind === 'grok'
        ? grokAdapter(o)
        : geminiAdapter(o);
}
