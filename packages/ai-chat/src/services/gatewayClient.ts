/**
 * 统一网关（主进程 GatewayService，见 docs/design/unified-gateway.md §5、§6）。
 * 返回的数据里 Key 只有掩码、没有客户端令牌；明文 Key 只在 upsertProvider / detect 的参数里单向发出。
 */
export type Wire = 'messages' | 'responses' | 'chat' | 'gemini';
export type ClientId = 'nomi' | 'claude' | 'codex' | 'gemini' | 'grok' | 'dsh';

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
  metaSource?: 'user' | 'preset' | 'listed' | 'catalog' | 'default';
}

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
  createdAt: number;
  updatedAt: number;
}

export interface ClientModels {
  main?: string;
  small?: string;
  tiers?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>;
  subagent?: string;
  tools?: string;
  summary?: string;
}

export interface GatewayState {
  status: GatewayStatus;
  providers: ProviderView[];
  clients: Partial<
    Record<ClientId, { models: ClientModels; newTabSource?: 'official' | 'thirdParty' }>
  >;
  allowedPrivateHosts: string[];
  port: number;
  migratedFrom?: { at: number; files: string[] };
}

export interface ProviderInput {
  id?: string;
  name: string;
  presetId?: string;
  enabled?: boolean;
  urls: Partial<Record<Wire, string>>;
  newKeys?: Array<{ value: string; name?: string; wire?: Wire }>;
  keys?: Array<{ id: string; name?: string; enabled: boolean; wire?: Wire }>;
  models?: GatewayModel[];
  detected?: Partial<Record<Wire, StoredProbe>>;
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
  urls: Partial<Record<Wire, string>>;
}

export interface DetectInput {
  providerId?: string;
  url?: string;
  urls?: Partial<Record<Wire, string>>;
  keys?: string[];
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
    patch: { models?: ClientModels; newTabSource?: 'official' | 'thirdParty' },
  ) => call<void>('set-assignment', client, patch),
  resetToken: (client: ClientId) => call<void>('reset-token', client),
  clearLearned: (providerId: string) => call<void>('clear-learned', providerId),
  confirmPrivateHost: (hostPort: string) => call<void>('confirm-private-host', hostPort),
  retry: () => call<void>('retry'),
  onChanged: (fn: () => void) =>
    bridge()?.on?.('ai:gateway:changed', () => fn()) ?? (() => undefined),
};
