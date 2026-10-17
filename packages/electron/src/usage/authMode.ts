/**
 * 判断每个工具「当前是订阅 / 账号登录，还是 API 计费」，额度卡只对订阅登录的工具展示。
 *
 * 原则（与 quota.ts 一致）：不读取任何凭据内容。
 * - Claude Code：官方命令 `claude auth status`（JSON，只取 authMethod 字段；输出里的邮箱等一律丢弃）。
 * - Codex：官方命令 `codex login status`（只看是 ChatGPT 还是 API Key；输出里的 Key 片段一律丢弃）。
 *   这两个命令由官方 CLI 自己读它的凭据，Nomi 只看到「登录方式」这一个结论。
 * - 身份指纹：`claude auth status` 的 JSON 里有邮箱 / 组织 id，这里只用「随机盐 + sha256」算出一个短指纹，
 *   明文丢弃（见 quotaIdentity.ts），用来判断是否换号。
 * - CLI 不可用 / 超时时的本地兜底，只检查配置里是否「配了」某个键，不保存也不记录值：
 *   Claude：<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json 与 settings.local.json 的 apiKeyHelper，
 *   以及 env 里的 ANTHROPIC_API_KEY / AUTH_TOKEN / BASE_URL / 云厂商开关 → API；
 *   Codex：<CODEX_HOME 或 ~/.codex>/config.toml 的 forced_login_method / 自定义 model_provider；
 *   日志里有带套餐的 rate_limits → 订阅。绝不打开 auth.json / .credentials.json / 系统钥匙串。
 * - dsh / Grok（官方接口 / 自配供应商）与 Nomi 对话都走 API Key：固定 API（Grok 订阅额度接口未文档化，暂不探测）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCliBinAsync, withCliPath } from '../cli/detect';

import { claudeConfigDir, codexHomeDir } from './cliHomes';
import type { QuotaEntry } from './quota';
import { fingerprint } from './quotaIdentity';

const execFileP = promisify(execFile);

/** subscription = 账号 / 订阅登录；api = API Key / 第三方供应商 / 本地路由；unknown = 没登录或判断不了 */
export type AuthMode = 'subscription' | 'api' | 'unknown';

/** `claude auth status` 的 JSON：只认 authMethod / apiProvider（官方 CLI 参考列出的取值） */
export function parseClaudeAuthStatus(text: string): AuthMode | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const j = o as { authMethod?: unknown; apiProvider?: unknown } | null;
  const m = j?.authMethod;
  if (typeof m !== 'string') return null;
  if (m === 'claude.ai' || m === 'oauth_token') {
    // 账号登录但走的不是 Anthropic 官方（Bedrock / Vertex / Foundry）：没有订阅额度
    if (typeof j?.apiProvider === 'string' && j.apiProvider !== 'firstParty') return 'api';
    return 'subscription';
  }
  if (m === 'api_key' || m === 'api_key_helper' || m === 'third_party') return 'api';
  if (m === 'none') return 'unknown';
  return null;
}

const clip = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;

/**
 * 从 `claude auth status` 的 JSON 里取「身份指纹 + 套餐」：邮箱 / 组织 id 只进 sha256，明文丢弃；
 * 套餐（subscriptionType，如 pro / max）是非敏感的展示信息。
 */
export function parseClaudeIdentity(
  text: string,
  salt: string,
): { fp: string | null; plan?: string } {
  let o: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) o = j as Record<string, unknown>;
  } catch {
    /* 不是 JSON */
  }
  if (!o) return { fp: null };
  const plan = clip(o.subscriptionType, 24);
  const email = clip(o.email, 320);
  // 没有邮箱就没有可靠身份：返回 null（不把不同账号误判为同一个）
  const fp = fingerprint(salt, [email, clip(o.orgId, 80) ?? clip(o.organizationId, 80), plan]);
  return {
    fp,
    ...(plan ? { plan: plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase() } : {}),
  };
}

/** `codex login status` 的输出：Logged in using ChatGPT / Logged in using an API key - … / Not logged in */
export function parseCodexLoginStatus(text: string): AuthMode | null {
  const s = text.toLowerCase();
  if (/not logged in/.test(s)) return 'unknown';
  if (/using an? api key/.test(s)) return 'api';
  if (/using chatgpt/.test(s)) return 'subscription';
  return null;
}

const CLAUDE_API_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/** 「配了」：非空字符串且不是 0 / false；布尔取其值；其它非空值算配了。只判断有没有，值本身不保存 */
function isConfigured(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const n = v.trim().toLowerCase();
    return n !== '' && n !== '0' && n !== 'false';
  }
  return v !== null && v !== undefined;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** 配置里是否把 Claude Code 指向了官方订阅之外（环境变量 / settings 的 env / apiKeyHelper） */
export function hasCustomClaudeConfiguration(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  settingsDocuments: unknown[] = [],
): boolean {
  if (CLAUDE_API_KEYS.some((k) => isConfigured(env[k]))) return true;
  for (const d of settingsDocuments) {
    const s = asRecord(d);
    if (!s) continue;
    if (isConfigured(s.apiKeyHelper)) return true;
    const e = asRecord(s.env);
    if (e && CLAUDE_API_KEYS.some((k) => isConfigured(e[k]))) return true;
  }
  return false;
}

/** 读 settings.json / settings.local.json（只在内存里判断是否配了自定义供应商，不记录任何值） */
export function readClaudeSettingsDocs(home: string, env: NodeJS.ProcessEnv): unknown[] {
  const dir = claudeConfigDir(home, env);
  const out: unknown[] = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      /* 没有 / 不是合法 JSON */
    }
  }
  return out;
}

/** 兜底：自定义供应商 / apiKeyHelper → API（settings.json + settings.local.json，尊重 CLAUDE_CONFIG_DIR） */
export function claudeAuthFromConfig(home: string, env: NodeJS.ProcessEnv): AuthMode | null {
  return hasCustomClaudeConfiguration(env, readClaudeSettingsDocs(home, env)) ? 'api' : null;
}

/** 兜底：config.toml 里的 forced_login_method / 自定义 model_provider（只看这两个字段，不碰 auth.json） */
export function codexAuthFromConfig(home: string, env: NodeJS.ProcessEnv): AuthMode | null {
  let toml: string;
  try {
    toml = fs.readFileSync(path.join(codexHomeDir(home, env), 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  // 只看顶层键（第一个 [table] 之前）
  const top = toml.split(/^\s*\[/m)[0] ?? '';
  const forced = /^\s*forced_login_method\s*=\s*"(\w+)"/m.exec(top)?.[1];
  if (forced === 'api') return 'api';
  if (forced === 'chatgpt') return 'subscription';
  const prov = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  if (prov && prov !== 'openai') return 'api';
  return null;
}

export interface AuthDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** 运行官方「登录状态」命令，返回 stdout+stderr；没有 CLI / 超时 / 出错返回 null。可注入（测试）。 */
  run?: (kind: 'claude' | 'codex') => Promise<string | null>;
  /** 兜底之外的本地线索：来源里已经有带套餐的额度快照 */
  hasSubscriptionData?: (id: 'claude' | 'codex') => boolean;
  /** 身份指纹用的本机随机盐（见 quotaIdentity.ts）；不给则不产生指纹 */
  salt?: () => string;
}

/** 登录方式 + 非敏感的身份信息（指纹 / 套餐） */
export interface AuthInfo {
  mode: AuthMode;
  /** 账号指纹（换号检测用）；取不到可靠身份时为 null */
  fp: string | null;
  plan?: string;
}

const TTL_MS = 5 * 60_000;

async function runStatus(kind: 'claude' | 'codex'): Promise<string | null> {
  const bin = await resolveCliBinAsync(kind);
  if (!bin) return null;
  const args = kind === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  try {
    const r = await execFileP(bin, args, {
      encoding: 'utf8',
      timeout: 6000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
      env: { ...withCliPath(), NO_COLOR: '1' },
    });
    return `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    // 未登录时 CLI 以退出码 1 结束，但 stdout / stderr 里仍有状态
    const x = e as { stdout?: unknown; stderr?: unknown };
    const out = `${typeof x.stdout === 'string' ? x.stdout : ''}\n${typeof x.stderr === 'string' ? x.stderr : ''}`;
    return out.trim() ? out : null;
  }
}

export class AuthModeDetector {
  private readonly cache = new Map<string, { at: number; info: AuthInfo }>();
  private readonly inflight = new Map<string, Promise<AuthInfo>>();

  constructor(private readonly d: AuthDeps = {}) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** nomi / dsh 固定 API；claude / codex 先问官方命令，再用本地配置兜底 */
  async detect(id: string): Promise<AuthMode> {
    return (await this.detectFull(id)).mode;
  }

  /** 同 detect，同时带上身份指纹 / 套餐（来自同一次官方命令输出，不额外起进程） */
  detectFull(id: string): Promise<AuthInfo> {
    if (id === 'nomi' || id === 'dsh' || id === 'grok')
      return Promise.resolve({ mode: 'api', fp: null });
    if (id !== 'claude' && id !== 'codex') return Promise.resolve({ mode: 'unknown', fp: null });
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < TTL_MS) return Promise.resolve(hit.info);
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const p = this.probe(id)
      .then((info) => {
        this.cache.set(id, { at: this.now(), info });
        return info;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async probe(id: 'claude' | 'codex'): Promise<AuthInfo> {
    const home = this.d.home ?? os.homedir();
    const env = this.d.env ?? process.env;
    // Claude：配置里指向了自定义供应商 / apiKeyHelper → 一律按 API（不再调用 CLI）
    if (id === 'claude' && claudeAuthFromConfig(home, env) === 'api')
      return { mode: 'api', fp: null };
    const text: string | null = await (this.d.run ?? runStatus)(id).catch(() => null);
    const fromCli = text
      ? id === 'claude'
        ? parseClaudeAuthStatus(text)
        : parseCodexLoginStatus(text)
      : null;
    // 官方命令说「没登录」时，仍允许下面的兜底再判断（例如只用环境变量的 API Key）
    if (fromCli && fromCli !== 'unknown') {
      const ident =
        id === 'claude' && text && this.d.salt ? parseClaudeIdentity(text, this.d.salt()) : null;
      return { mode: fromCli, fp: ident?.fp ?? null, ...(ident?.plan ? { plan: ident.plan } : {}) };
    }
    const cfg = id === 'claude' ? claudeAuthFromConfig(home, env) : codexAuthFromConfig(home, env);
    if (cfg) return { mode: cfg, fp: null };
    if (this.d.hasSubscriptionData?.(id)) return { mode: 'subscription', fp: null };
    return { mode: 'unknown', fp: null };
  }
}

/**
 * 把「按来源汇总的额度」按登录方式过滤：
 * - 订阅登录：有数据 → ok；没数据 → unavailable（显示「暂未返回可用额度」）
 * - API 计费：status = api（显示「API 计费，无订阅额度」）；Nomi 对话不出现在额度卡里
 * - 判断不了：有数据才展示，没有数据就不出现（不对没登录的工具乱报「暂未返回」）
 */
export function applyAuthModes(
  entries: QuotaEntry[],
  modes: Record<string, AuthMode>,
  detected: ReadonlySet<string>,
): QuotaEntry[] {
  const out: QuotaEntry[] = [];
  for (const e of entries) {
    const auth = modes[e.id] ?? 'unknown';
    if (e.id === 'nomi') continue;
    // 没检测到这个工具的本机痕迹，也没有额度数据：不出现
    if (e.status !== 'ok' && !detected.has(e.id)) continue;
    if (auth === 'api') out.push({ ...e, status: 'api', windows: [], auth });
    else if (auth === 'subscription') out.push({ ...e, auth });
    else if (e.status === 'ok') out.push({ ...e, auth });
  }
  return out;
}
