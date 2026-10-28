import { t } from '../i18n';
/**
 * MCP 服务器配置（GUI 管理）：校验、导入（通用 `mcpServers` JSON / 数组）、预设与脱敏。
 */
export type Transport = 'stdio' | 'http' | 'sse';
/** ask = 每次调用都确认；read-auto = 只读工具自动，其它确认；auto = 全部自动（仍记审计） */
export type Trust = 'ask' | 'read-auto' | 'auto';

export interface McpServerEntry {
  id: string;
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  trust: Trust;
  /** env = 来自环境变量 MCP_SERVERS（只读） */
  origin: 'user' | 'env';
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function slugId(name: string, taken: Set<string>): string {
  let base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'mcp';
  if (!/^[a-z0-9]/.test(base)) base = `s${base}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) && x != null) out[k] = String(x);
  return Object.keys(out).length ? out : undefined;
};

export class McpConfigError extends Error {}

export function sanitizeServer(raw: unknown, taken = new Set<string>()): McpServerEntry {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = String(o.name ?? o.id ?? '')
    .trim()
    .slice(0, 60);
  if (!name) throw new McpConfigError(t('electron.common.please-enter-a-name'));
  let transport: Transport =
    o.transport === 'http' || o.transport === 'sse' ? o.transport : 'stdio';
  if (!o.transport && typeof o.url === 'string')
    transport = /\/sse\/?$/.test(o.url) ? 'sse' : 'http';
  const id = typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : slugId(name, taken);
  const e: McpServerEntry = {
    id,
    name,
    transport,
    enabled: o.enabled !== false,
    trust: o.trust === 'auto' || o.trust === 'read-auto' ? o.trust : 'ask',
    origin: o.origin === 'env' ? 'env' : 'user',
  };
  if (transport === 'stdio') {
    const command = String(o.command ?? '').trim();
    if (!command)
      throw new McpConfigError(t('electron.common.local-stdio-servers-need-a-start-command'));
    if (/[\n\r]/.test(command))
      throw new McpConfigError(t('electron.common.the-command-can-t-contain-line-breaks'));
    e.command = command;
    e.args = Array.isArray(o.args) ? o.args.map(String).slice(0, 64) : [];
    e.env = strMap(o.env);
  } else {
    const url = String(o.url ?? '').trim();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new McpConfigError(t('electron.common.please-enter-a-valid-server-url-http-https'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new McpConfigError(t('electron.common.server-urls-only-support-http-https'));
    e.url = u.toString();
    e.headers = strMap(o.headers);
  }
  return e;
}

/** 导入：支持 `{ "mcpServers": { name: {...} } }`、`{ name: {...} }` 或数组 */
export function parseImport(text: string, existing: string[] = []): McpServerEntry[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new McpConfigError(t('electron.common.not-valid-json'));
  }
  const taken = new Set(existing);
  const items: Array<Record<string, unknown>> = [];
  if (Array.isArray(j)) items.push(...(j as Array<Record<string, unknown>>));
  else if (j && typeof j === 'object') {
    const root = (j as Record<string, unknown>).mcpServers ?? j;
    if (root && typeof root === 'object' && !Array.isArray(root))
      for (const [name, v] of Object.entries(root as Record<string, unknown>))
        if (v && typeof v === 'object') items.push({ name, ...(v as Record<string, unknown>) });
  }
  if (!items.length) throw new McpConfigError(t('electron.common.no-server-configuration-found'));
  const out: McpServerEntry[] = [];
  for (const it of items) {
    const e = sanitizeServer({ ...it, origin: 'user', trust: 'ask' }, taken);
    taken.add(e.id);
    out.push(e);
  }
  return out;
}

const SECRET_KEY = /(key|token|secret|password|passwd|auth|cookie|credential)/i;

/**
 * 取值本身像凭据（字段名不一定带 key / token）：带账号口令的 URL、Bearer / Basic、常见令牌前缀、
 * 或 ≥ 32 个字符、只含令牌字符且至少 4 个数字的随机串。用于落盘加密与打码（导入其他工具的配置时尤其需要，#58）。
 */
export function isSecretValue(v: string): boolean {
  if (!v) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v)) return true;
  if (/^(bearer|basic)\s+\S{8,}/i.test(v)) return true;
  if (/^(sk-|ghp_|gho_|ghu_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.)/.test(v)) return true;
  // 长度 ≥ 32、只有 token 字符、至少 4 个数字：像随机令牌而不是普通单词 / 路径
  return (
    v.length >= 32 &&
    /^[A-Za-z0-9_\-+=.~]+$/.test(v) &&
    (v.match(/\d/g)?.length ?? 0) >= 4 &&
    /[A-Za-z]/.test(v)
  );
}

/** 给界面看的版本：敏感值打码 */
export function maskServer(e: McpServerEntry): McpServerEntry {
  const mask = (m?: Record<string, string>, all = false) =>
    m &&
    Object.fromEntries(
      Object.entries(m).map(([k, v]) => [
        k,
        (all || SECRET_KEY.test(k) || isSecretValue(v)) && v ? `${v.slice(0, 2)}••••••` : v,
      ]),
    );
  return { ...e, env: mask(e.env), headers: mask(e.headers, true) };
}

/** 编辑时：打码值原样回传 → 保留旧值 */
export function mergeSecrets(
  next: Record<string, string> | undefined,
  prev: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!next) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(next))
    out[k] = v.includes('••••••') && prev?.[k] ? prev[k] : v;
  return out;
}

export function isSecretKey(k: string): boolean {
  return SECRET_KEY.test(k);
}

/** `--api-key=xxx` / `API_KEY=xxx` 形式的参数：返回 [名字, 值] */
const SECRET_ARG_ASSIGN =
  /^(-{0,2}[\w.-]*(?:key|token|secret|password|passwd|auth|cookie|credential)[\w.-]*)=([\s\S]*)$/i;
const SECRET_FLAG =
  /^-{1,2}[\w.-]*(?:key|token|secret|password|passwd|auth|cookie|credential)[\w.-]*$/i;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 去掉 URL 里的账号口令、query 与 fragment（常见的 `?key=` / `?token=` 放凭据处），只保留 origin + path */
export function stripUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * 导出用：生成「只有结构、没有凭据」的 MCP 服务配置。
 * 是否是密钥只由字段语义决定，与落盘时是否加密（`enc:` 前缀）无关：
 * - env / headers 的全部取值一律替换为占位符（鉴权头名称千奇百怪，不靠名字白名单）；
 * - url 去掉账号口令 / query / fragment；
 * - args 里形如 `--token=xxx`、`--api-key xxx`、`KEY=xxx`、带凭据的 URL 都打码。
 */
export function redactServerForExport<T extends Partial<McpServerEntry>>(
  e: T,
  placeholder: string,
): T {
  const blank = (m?: Record<string, string>) =>
    m && Object.fromEntries(Object.keys(m).map((k) => [k, placeholder]));
  const out: Record<string, unknown> = { ...e };
  if ('env' in e) out.env = blank(e.env);
  if ('headers' in e) out.headers = blank(e.headers);
  if (typeof e.url === 'string') out.url = stripUrlCredentials(e.url);
  if (Array.isArray(e.args)) {
    let maskNext = false;
    out.args = e.args.map((a) => {
      const arg = String(a);
      if (maskNext) {
        maskNext = false;
        return placeholder;
      }
      const m = SECRET_ARG_ASSIGN.exec(arg);
      if (m) return `${m[1]}=${placeholder}`;
      if (SECRET_FLAG.test(arg)) {
        maskNext = true;
        return arg;
      }
      return URL_LIKE.test(arg) ? stripUrlCredentials(arg) : arg;
    });
  }
  return out as T;
}

/** 只读判断（MCP annotations） */
export function needsConfirm(trust: Trust, readOnlyHint: boolean): boolean {
  if (trust === 'auto') return false;
  if (trust === 'read-auto') return !readOnlyHint;
  return true;
}

export interface McpPreset {
  key: string;
  name: string;
  description: string;
  server: Partial<McpServerEntry>;
  /** 需要用户填的占位（例如目录） */
  needs?: string;
  license: string;
}

/** 常见官方参考服务器（不随应用分发；首次连接由 npx / uvx 从包仓库获取） */
export const MCP_PRESETS: McpPreset[] = [
  {
    key: 'filesystem',
    name: 'electron.common.filesystem',
    description: 'electron.common.read-and-write-the-folders-you-specify-official',
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '{dir}'],
    },
    needs: 'dir',
    license: 'MIT',
  },
  {
    key: 'memory',
    name: 'electron.common.knowledge-graph-memory',
    description:
      'electron.common.store-information-as-entities-relations-official-reference-implementation',
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    license: 'MIT',
  },
  {
    key: 'sequential-thinking',
    name: 'electron.common.sequential-thinking',
    description: 'electron.common.helps-the-model-break-down-complex-problems-official',
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    license: 'MIT',
  },
  {
    key: 'remote',
    name: 'electron.common.remote-http-server',
    description: 'electron.common.connect-to-a-streamable-http-sse-mcp-server',
    server: { transport: 'http', url: 'https://' },
    license: '—',
  },
];
