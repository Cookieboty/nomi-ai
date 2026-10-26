import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
/**
 * 统一网关（主进程 GatewayService，见 docs/design/unified-gateway.md §5、§6）。
 * 返回的数据里 Key 只有掩码、没有客户端令牌；明文 Key 只在 upsertProvider / detect 的参数里单向发出。
 */
export type Wire = 'messages' | 'responses' | 'chat' | 'gemini';
export type ClientId = 'nomi' | BuiltinCliId;

export const WIRES: readonly Wire[] = ['messages', 'responses', 'chat', 'gemini'];

export const WIRE_LABEL: Record<Wire, string> = {
  messages: 'Anthropic',
  responses: 'Responses',
  chat: 'Chat',
  gemini: 'Gemini',
};

export type GatewayStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; port: number; url: string }
  | { state: 'failed'; error: string };

export interface GatewayModel {
  id: string;
  enabled: boolean;
  label?: string;
  wires?: Wire[];
  ctx?: number;
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  metaSource?: MetaSource;
  /** 主进程按「用户 > 预设 > 模型列表 > 内置目录 > 默认值」算出的生效值（只读，保存时丢弃） */
  effective?: {
    ctx: number;
    maxOutput: number;
    reasoning?: boolean;
    vision?: boolean;
    source: MetaSource;
    maxOutputSource: MetaSource;
    /** 可开长上下文：标准窗口 / 最大输入 / 模型默认是否开启 / 超过标准窗口后的单价（USD 每百万 token） */
    longContext?: {
      standard: number;
      full: number;
      on: boolean;
      price?: {
        size: number;
        input: number;
        output: number;
        tierInput: number;
        tierOutput: number;
      };
    };
  };
  /** 这个模型默认开启长上下文（只对有标准窗口的模型有意义） */
  longContext?: boolean;
}

export type MetaSource = 'user' | 'preset' | 'listed' | 'catalog' | 'default';

export interface StoredProbe {
  ok: boolean;
  status?: number;
  at: number;
  model?: string;
  auth?: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  error?: string;
}

export interface KeyView {
  id: string;
  name?: string;
  masked: string;
  wire?: Wire;
  enabled: boolean;
  lastError?: string;
  decryptable: boolean;
  /** 并发上限 / 每分钟请求数（不设 = 不限） */
  maxConcurrency?: number;
  rpm?: number;
}

export interface ProviderView {
  id: string;
  name: string;
  presetId?: string;
  enabled: boolean;
  urls: Partial<Record<Wire, string>>;
  keys: KeyView[];
  models: GatewayModel[];
  source: 'user' | 'env';
  detected?: Partial<Record<Wire, StoredProbe>>;
  /** 这个供应商的模型都失败时依次改用（'provider/model'） */
  fallback?: string[];
  headers?: Record<string, string>;
  userAgent?: string;
  modelMap?: Array<{ from: string; to: string }>;
  /** 运行时学到的状态（§7.4） */
  learned?: LearnedState;
  createdAt: number;
  updatedAt: number;
}

export interface LearnedState {
  wireDown?: Partial<Record<Wire, { at: number; reason: string }>>;
  modelWire?: Record<string, Wire[]>;
  droppedParams?: Record<string, string[]>;
  /** Responses 接口不接受 custom 工具的模型（改用转换模式） */
  customToolsRefused?: string[];
}

export interface ClientModels {
  main?: string;
  /** 旧版本的「小模型」：界面已并入 Haiku 档，只读作 Haiku 档没设时的值 */
  small?: string;
  tiers?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>;
  subagent?: string;
  tools?: string;
  summary?: string;
}

/** set-assignment 的增量写入：null 用于清掉某个模型配置。 */
export type ClientModelsPatch = {
  [K in keyof ClientModels]?: ClientModels[K] | null;
};

export interface GatewayState {
  status: GatewayStatus;
  providers: ProviderView[];
  clients: Partial<
    Record<
      ClientId,
      {
        models: ClientModels;
        newTabSource?: 'official' | 'thirdParty';
        /** 官方来源时新标签用的账号 id；`local-<cli>` = 本机登录；缺省 = 跟随默认账号（§12） */
        newTabAccountId?: string | null;
      }
    >
  >;
  allowedPrivateHosts: string[];
  port: number;
  /** 严格模式（默认关）：模型不支持的参数直接报错，而不是丢弃并记录 */
  strictParams?: boolean;
  /** 入站请求体上限（字节）；默认 32 MiB */
  maxRequestBodyBytes?: number;
  /** 隐私模式（默认开）：发往云端第三方供应商前把密钥换成占位符；旧主进程没有这个字段 */
  privacyMode?: boolean;
  migratedFrom?: { at: number; files: string[] };
  /** 模型目录：收录的模型数、版本（同步日；没同步过是内置目录的生成日）、是否来自同步 */
  catalog?: { models: number; version: string; synced: boolean };
  /** 这次启动撤销旧版本全局配置的结果（§6.3 第 7 步） */
  legacyRevoke?: { revoked: string[]; failed: Array<{ kind: string; error: string }> };
}

export interface ProviderInput {
  id?: string;
  name: string;
  presetId?: string;
  enabled?: boolean;
  urls: Partial<Record<Wire, string>>;
  newKeys?: Array<{
    value: string;
    name?: string;
    wire?: Wire;
    position?: number;
    enabled?: boolean;
    maxConcurrency?: number | null;
    rpm?: number | null;
  }>;
  /** maxConcurrency / rpm：数字 = 设置，null = 清除，不传 = 不改 */
  keys?: Array<{
    id: string;
    name?: string;
    enabled: boolean;
    wire?: Wire;
    maxConcurrency?: number | null;
    rpm?: number | null;
  }>;
  models?: GatewayModel[];
  /** modelMap / headers / fallback：传了就整体替换（[] / {} 清空）；userAgent 传空串清除 */
  modelMap?: Array<{ from: string; to: string }>;
  headers?: Record<string, string>;
  userAgent?: string;
  fallback?: string[];
  detected?: Partial<Record<Wire, StoredProbe>>;
  quirks?: {
    maxTools?: number;
    dropParams?: string[];
    reasoningPassback?: boolean;
    preferWire?: Wire;
    extraBody?: Partial<Record<Wire, Record<string, unknown>>>;
  };
}

export interface ProbeLine {
  wire: Wire;
  url: string;
  ok: boolean;
  auth?: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  status?: number;
  model?: string;
  error?: string;
  ms: number;
}

export interface DetectResult {
  wires: Partial<Record<Wire, ProbeLine>>;
  byKey: Record<string, Partial<Record<Wire, ProbeLine>>>;
  models: string[];
  /** 模型列表接口顺带返回的上下文 / 输出上限 */
  limits?: Record<string, { ctx?: number; maxOutput?: number }>;
  urls: Partial<Record<Wire, string>>;
}

export interface DetectInput {
  providerId?: string;
  url?: string;
  urls?: Partial<Record<Wire, string>>;
  keys?: string[];
  savedKeyIds?: string[];
  fallbackModel?: string;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on?: (channel: string, fn: (p: unknown) => void) => () => void;
}

const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

export const gatewayClientAvailable = (): boolean => Boolean(bridge());

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error('aiIPC unavailable');
  const r = (await b.invoke(`ai:gateway:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

/** 上游地址的 host:port（与网关 upstreamGuard 的写法一致），用于确认本机 / 局域网地址 */
export function hostPortOf(url: string): string | null {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/** 本机或局域网地址（需要用户确认后网关才会访问，§15） */
export function isPrivateUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (!m) return /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  } catch {
    return false;
  }
}

export const gatewayClient = {
  /** 形状不对（旧主进程 / 测试桩）时抛错，调用方按「网关不可用」处理 */
  state: async () => {
    const s = await call<GatewayState>('state');
    if (!s || !Array.isArray(s.providers) || typeof s.clients !== 'object' || !s.status)
      throw new Error('invalid gateway state');
    return s;
  },
  upsertProvider: (input: ProviderInput) => call<ProviderView>('upsert-provider', input),
  removeProvider: (id: string) => call<void>('remove-provider', id),
  detect: (input: DetectInput) => call<DetectResult>('detect', input),
  setAssignment: (
    client: ClientId,
    patch: {
      models?: ClientModelsPatch;
      newTabSource?: 'official' | 'thirdParty';
      newTabAccountId?: string | null;
    },
  ) => call<void>('set-assignment', client, patch),
  resetToken: (client: ClientId) => call<void>('reset-token', client),
  clearLearned: (providerId: string) => call<void>('clear-learned', providerId),
  confirmPrivateHost: (hostPort: string) => call<void>('confirm-private-host', hostPort),
  retry: () => call<void>('retry'),
  setOptions: (patch: {
    strictParams?: boolean;
    maxRequestBodyBytes?: number;
    privacyMode?: boolean;
  }) => call<GatewayState>('set-options', patch),
  onChanged: (fn: () => void) =>
    bridge()?.on?.('ai:gateway:changed', () => fn()) ?? (() => undefined),
};
