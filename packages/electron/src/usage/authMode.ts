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
 * - dsh 与 Nomi 对话固定走 API Key。
 * - Grok 通过官方 ACP `initialize` 判断是否有 cached OAuth 登录态；额度由官方 CLI
 *   的 `_x.ai/billing` 扩展按需读取。
 *   因此官方登录只会显示「暂未返回可用额度」，不会误报为 API 计费。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCliBinAsync, withCliPath } from '../cli/detect';

import { claudeConfigDir, codexHomeDir, grokHomeDir } from './cliHomes';
import { parseGrokAuthStatus, readGrokAuthStatus } from './grokAuth';
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

/**
 * 官方命令明确说「已退出登录」（而不是命令不存在 / 超时 / 输出看不懂）：
 * Claude `authMethod: "none"`，Codex `Not logged in`。Grok 的 ACP 只给登录入口列表，没有可靠的退出登录信号，不判。
 */
export function isDefinitelySignedOut(kind: 'claude' | 'codex', text: string): boolean {
  if (kind === 'codex') return /not logged in/i.test(text);
  try {
    const j = JSON.parse(text) as { authMethod?: unknown } | null;
    return j?.authMethod === 'none';
  } catch {
    return false;
  }
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

/**
 * 不起进程判断 Claude Code 是否还登着 claude.ai 账号（#44）：OAuth 登录时全局配置
 * `<CLAUDE_CONFIG_DIR 或 ~>/.claude.json` 里有 `oauthAccount`，退出登录后被移除。
 * true = 有；false = 文件可读但没有（且没有 CLAUDE_CODE_OAUTH_TOKEN 长期令牌）；null = 读不到，无从判断。
 * 只看字段是否存在，不读取任何值。
 */
export function claudeOAuthPresent(home: string, env: NodeJS.ProcessEnv): boolean | null {
  if (isConfigured(env.CLAUDE_CODE_OAUTH_TOKEN)) return true;
  const file = env.CLAUDE_CONFIG_DIR
    ? path.join(claudeConfigDir(home, env), '.claude.json')
    : path.join(home, '.claude.json');
  try {
    const j = asRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!j) return null;
    const acct = asRecord(j.oauthAccount);
    return !!acct && Object.keys(acct).length > 0;
  } catch {
    return null;
  }
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

const GROK_API_KEYS = ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_DEPLOYMENT_KEY', 'NOMI_GROK_API_KEY'];

/** Grok 环境变量 / Nomi 写入的 provider 配置表示 API 计费；不读取 auth.json。 */
export function hasManagedGrokConfiguration(home: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const config = fs.readFileSync(
      path.join(grokHomeDir(home, env as NodeJS.ProcessEnv), 'config.toml'),
      'utf8',
    );
    return (
      config.includes('# >>> nomi managed (grok provider) >>>') ||
      /(^|\n)\s*env_key\s*=\s*"(?:XAI_API_KEY|GROK_API_KEY|GROK_DEPLOYMENT_KEY|NOMI_GROK_API_KEY)"/i.test(
        config,
      )
    );
  } catch {
    return false;
  }
}

export function hasCustomGrokConfiguration(
  home: string,
  env: NodeJS.ProcessEnv | Record<string, unknown>,
): boolean {
  return (
    GROK_API_KEYS.some((k) => isConfigured(env[k])) ||
    hasManagedGrokConfiguration(home, env as NodeJS.ProcessEnv)
  );
}

export function grokAuthFromConfig(home: string, env: NodeJS.ProcessEnv): AuthMode | null {
  return hasCustomGrokConfiguration(home, env) ? 'api' : null;
}

/**
 * Grok 本机是否像装过 / 用过官方 CLI（配置或会话目录），不涉及凭据文件。
 * 用于避免在完全没装 Grok 时每次刷新都拉起 ACP；真正的登录方式仍只看 ACP initialize。
 */
export function hasGrokLocalPresence(home: string, env: NodeJS.ProcessEnv): boolean {
  const dir = grokHomeDir(home, env);
  try {
    if (fs.existsSync(path.join(dir, 'config.toml'))) return true;
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(path.join(dir, 'sessions'))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** @deprecated 使用 hasGrokLocalPresence；保留别名以免外部测试瞬时断裂 */
export const hasGrokAuthFile = hasGrokLocalPresence;

export interface AuthDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** 运行官方「登录状态」命令，返回 stdout+stderr；没有 CLI / 超时 / 出错返回 null。可注入（测试）。 */
  run?: (kind: 'claude' | 'codex') => Promise<string | null>;
  /** Grok ACP 登录状态探测（测试注入）；默认调用官方 `grok agent stdio`。 */
  grokRun?: () => Promise<string | null>;
  /** 兜底之外的本地线索：来源里已经有带套餐的额度快照 */
  hasSubscriptionData?: (id: 'claude' | 'codex' | 'grok') => boolean;
  /** 身份指纹用的本机随机盐（见 quotaIdentity.ts）；不给则不产生指纹 */
  salt?: () => string;
}

/** 登录方式 + 非敏感的身份信息（指纹 / 套餐） */
export interface AuthInfo {
  mode: AuthMode;
  /** 账号指纹（换号检测用）；取不到可靠身份时为 null */
  fp: string | null;
  plan?: string;
  /** 官方命令明确说已退出登录（mode 仍为 unknown）。与「探测失败 / CLI 不存在 / 超时」不同：调用方要立即清掉旧账号额度 */
  signedOut?: boolean;
  /** 结论来自官方登录状态命令（不是本地配置兜底）：只有这种才记作「上一次的结论」落盘 */
  fromCli?: boolean;
}

const TTL_MS = 5 * 60_000;

async function runStatus(kind: 'claude' | 'codex' | 'grok'): Promise<string | null> {
  if (kind === 'grok') return readGrokAuthStatus();
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
  /**
   * 上一次官方登录状态命令给出的结论（订阅 / API），落盘、重启后恢复。
   * 被动读取在本次会话还没探测过时用它，而不是只凭本地配置猜（例如 Codex 配了自定义
   * model_provider 但官方说是 ChatGPT 登录）。invalidate 不清它；明确退出登录时清掉。
   */
  private readonly known = new Map<string, AuthInfo>();
  private onKnownChange: (() => void) | null = null;

  constructor(private readonly d: AuthDeps = {}) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** nomi / dsh 固定 API；Claude / Codex / Grok 先问官方接口，再用本地配置兜底 */
  async detect(id: string): Promise<AuthMode> {
    return (await this.detectFull(id)).mode;
  }

  /**
   * 同 detect，同时带上身份指纹 / 套餐（来自同一次官方命令输出，不额外起进程）。
   * 注意：缓存（5 分钟）未命中时会运行官方登录状态命令——只有「已授权」的调用方才能用它；
   * 被动读取一律走 detectPassive。
   */
  detectFull(id: string): Promise<AuthInfo> {
    if (id === 'nomi' || id === 'dsh') return Promise.resolve({ mode: 'api', fp: null });
    if (id !== 'claude' && id !== 'codex' && id !== 'grok')
      return Promise.resolve({ mode: 'unknown', fp: null });
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < TTL_MS) return Promise.resolve(hit.info);
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const p = this.probe(id)
      .then((info) => {
        this.cache.set(id, { at: this.now(), info });
        if (info.signedOut) this.setKnown(id, null);
        else if (info.fromCli)
          this.setKnown(id, {
            mode: info.mode,
            fp: info.fp,
            ...(info.plan ? { plan: info.plan } : {}),
          });
        return info;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** known 变化时调用（UsageService 用来落盘） */
  setOnKnownChange(fn: () => void): void {
    this.onKnownChange = fn;
  }

  /** 落盘用：每个工具上一次官方探测的结论（只有模式 / 套餐 / 加盐指纹，不含凭据） */
  knownSnapshot(): Record<string, AuthInfo> {
    return Object.fromEntries(this.known);
  }

  /** 启动时恢复上一次的结论；不占用探测缓存，「刷新」时照常重新探测 */
  restoreKnown(saved: Record<string, AuthInfo>): void {
    for (const [id, info] of Object.entries(saved)) this.known.set(id, info);
  }

  /** 换号 / 清空数据：忘掉上一次的结论（不带参数 = 全部） */
  forgetKnown(id?: string): void {
    if (id) this.setKnown(id, null);
    else for (const k of [...this.known.keys()]) this.setKnown(k, null);
  }

  private setKnown(id: string, info: AuthInfo | null): void {
    const prev = this.known.get(id);
    if (info) {
      if (prev && prev.mode === info.mode && prev.fp === info.fp && prev.plan === info.plan) return;
      this.known.set(id, info);
    } else if (prev) this.known.delete(id);
    else return;
    try {
      this.onKnownChange?.();
    } catch {
      /* 落盘失败不影响探测结果 */
    }
  }

  /** 不带参数：清掉全部；带工具 id：只清该工具的登录状态缓存（单工具刷新用） */
  invalidate(id?: string): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  /**
   * 被动读取（面板挂载 / 30 秒轮询 / changed 事件 / 刷新结果里的其它工具）：绝不启动任何官方 CLI 进程。
   * 只用已有的探测缓存（不论新旧）、本地配置和已有额度数据；都没有就是 unknown，不用外部命令补齐。
   * 要运行登录状态进程必须显式走 detectFull，且调用方需先确认 enabled + 主动刷新 + 用户点了该工具。
   */
  detectPassive(id: string): AuthInfo {
    if (id === 'nomi' || id === 'dsh') return { mode: 'api', fp: null };
    if (id !== 'claude' && id !== 'codex' && id !== 'grok') return { mode: 'unknown', fp: null };
    // Claude 退出登录有本地信号：即便缓存 / 状态栏快照还在，也不能把旧账号当成仍在订阅（#44）
    if (id === 'claude') {
      const home = this.d.home ?? os.homedir();
      const env = this.d.env ?? process.env;
      if (claudeOAuthPresent(home, env) === false && claudeAuthFromConfig(home, env) !== 'api') {
        this.cache.delete(id);
        this.setKnown(id, null);
        return { mode: 'unknown', fp: null, signedOut: true };
      }
    }
    const hit = this.cache.get(id);
    if (hit) return hit.info;
    // 本地就能确定的（自定义 / 托管 API 配置）优先；其次是上一次官方命令的结论
    return this.beforeCli(id) ?? this.known.get(id) ?? this.afterCli(id, false);
  }

  /** 不需要（也不允许）起进程就能确定的结论：自定义 / 托管 API 配置，或本机根本没有 Grok */
  private beforeCli(id: 'claude' | 'codex' | 'grok'): AuthInfo | null {
    const home = this.d.home ?? os.homedir();
    const env = this.d.env ?? process.env;
    // 自定义供应商 / API Key → 一律按 API（不再调用官方状态命令）
    if (id === 'claude' && claudeAuthFromConfig(home, env) === 'api')
      return { mode: 'api', fp: null };
    // Nomi 管理的 Grok provider 明确覆盖官方登录；单独的 XAI_API_KEY 则交给
    // Grok 自己的优先级（已登录 OAuth 时官方文档规定 OAuth 优先）。
    if (id === 'grok' && hasManagedGrokConfiguration(home, env)) return { mode: 'api', fp: null };
    // 本机完全没有 Grok 配置/会话、也不是 API 配置时，不为每次刷新都拉起 ACP。
    if (id === 'grok' && !hasGrokLocalPresence(home, env) && !hasCustomGrokConfiguration(home, env))
      return { mode: 'unknown', fp: null };
    return null;
  }

  /** 官方命令没给出（或说「没登录」）之后的本地兜底：配置 → 已有额度数据；明确退出登录不被历史数据恢复 */
  private afterCli(id: 'claude' | 'codex' | 'grok', signedOut: boolean): AuthInfo {
    const home = this.d.home ?? os.homedir();
    const env = this.d.env ?? process.env;
    const cfg =
      id === 'claude'
        ? claudeAuthFromConfig(home, env)
        : id === 'codex'
          ? codexAuthFromConfig(home, env)
          : grokAuthFromConfig(home, env);
    if (cfg) return { mode: cfg, fp: null };
    // 明确退出登录：不能再用历史额度 / 状态栏快照把它「恢复」成订阅登录
    if (signedOut) return { mode: 'unknown', fp: null, signedOut: true };
    if (this.d.hasSubscriptionData?.(id)) return { mode: 'subscription', fp: null };
    return { mode: 'unknown', fp: null };
  }

  private async probe(id: 'claude' | 'codex' | 'grok'): Promise<AuthInfo> {
    const pre = this.beforeCli(id);
    if (pre) return pre;
    const text: string | null =
      id === 'grok'
        ? await (this.d.grokRun ?? readGrokAuthStatus)().catch(() => null)
        : await (this.d.run ?? runStatus)(id).catch(() => null);
    const fromCli = text
      ? id === 'claude'
        ? parseClaudeAuthStatus(text)
        : id === 'codex'
          ? parseCodexLoginStatus(text)
          : parseGrokAuthStatus(text)
      : null;
    // 官方命令说「没登录」时，仍允许下面的兜底再判断（例如只用环境变量的 API Key）
    if (fromCli && fromCli !== 'unknown') {
      const ident =
        id === 'claude' && text && this.d.salt ? parseClaudeIdentity(text, this.d.salt()) : null;
      return {
        mode: fromCli,
        fp: ident?.fp ?? null,
        ...(ident?.plan ? { plan: ident.plan } : {}),
        fromCli: true,
      };
    }
    const signedOut =
      (id === 'claude' || id === 'codex') && !!text && isDefinitelySignedOut(id, text);
    return this.afterCli(id, signedOut);
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
    if (e.status !== 'ok' && auth !== 'subscription' && !detected.has(e.id)) continue;
    if (auth === 'api') out.push({ ...e, status: 'api', windows: [], auth });
    else if (auth === 'subscription') out.push({ ...e, auth });
    else if (e.status === 'ok') out.push({ ...e, auth });
  }
  return out;
}
