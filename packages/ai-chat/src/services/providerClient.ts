import { t } from '@nomi-ai/ui';
/**
 * 旧的 Nomi 供应商存储（`ai:providers:*`）：只剩预设列表（添加第三方供应商时选）和状态 / 切换
 * （环境变量供应商的过渡期，网关里没有分配时由它路由）。供应商的增删改在统一网关（gatewayClient）。
 * 主进程只回传掩码视图。
 */
export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic';
export type ProviderRole = 'chat' | 'agent-tools' | 'summary';
export type PresetCategory = 'custom' | 'vendor' | 'platform';

export interface ProviderPreset {
  id: string;
  name: string;
  category: PresetCategory;
  protocol: Protocol;
  baseURL: string;
  defaultModel: string;
  models: string[];
  requiresApiKey: boolean;
  websiteUrl?: string;
  apiKeyUrl?: string;
  keywords?: string[];
  hint?: string;
  docsUrl?: string;
  modelsEndpoint?: boolean | null;
  verified?: boolean;
  /** 单独核对日期（缺省用全局 2026-10-11） */
  checkedAt?: string;
  icon?: string;
  /** 统一网关：每种协议一个地址（§8.4） */
  urls?: Partial<Record<'messages' | 'responses' | 'chat' | 'gemini', string>>;
  /** 主力模型的元数据 */
  modelMeta?: Array<{
    id: string;
    ctx?: number;
    maxOutput?: number;
    reasoning?: boolean;
    vision?: boolean;
    toolCalling?: boolean;
  }>;
  quirks?: {
    maxTools?: number;
    dropParams?: string[];
    reasoningPassback?: boolean;
    preferWire?: 'messages' | 'responses' | 'chat' | 'gemini';
    extraBody?: Partial<
      Record<'messages' | 'responses' | 'chat' | 'gemini', Record<string, unknown>>
    >;
  };
  codingPlan?: boolean;
}

export interface FetchedModel {
  id: string;
  name?: string;
  ownedBy?: string;
}

export interface ModelMapping {
  from: string;
  to: string;
}

export interface ProviderConfig {
  name: string;
  note?: string;
  websiteUrl?: string;
  protocol: Protocol;
  baseURL: string;
  fullUrl: boolean;
  defaultModel: string;
  models: string[];
  fetchedModels?: FetchedModel[];
  fetchedAt?: number;
  modelMap?: ModelMapping[];
  headers?: Record<string, string>;
  userAgent?: string;
  thinking?: boolean;
}

export interface ProviderUsage {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastUsedAt?: number;
}

export interface KeyView {
  id: string;
  label?: string;
  masked: string;
  encryption: 'safeStorage' | 'none';
  createdAt: number;
  lastUsedAt?: number;
  lastError?: string;
}

export interface ProviderView extends ProviderConfig {
  id: string;
  presetId: string;
  enabled: boolean;
  active: boolean;
  keys: KeyView[];
  usage: ProviderUsage;
  source: 'store';
}

export interface EnvProviderView {
  id: string;
  name: string;
  protocol: Protocol;
  baseURL?: string;
  defaultModel?: string;
  hasKey: boolean;
  keyless?: boolean;
  active: boolean;
  usage: ProviderUsage;
  source: 'env';
}

export interface ProviderState {
  providers: ProviderView[];
  envProviders: EnvProviderView[];
  activeProviderId?: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  routes: Partial<Record<ProviderRole, { providerId: string; model?: string }>>;
  roles: ProviderRole[];
  encryption: 'safeStorage' | 'none';
  overrideId?: string;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}

function bridge(): AiBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
}

export const providerClientAvailable = (): boolean => Boolean(bridge());

const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
  const b = bridge();
  if (!b) throw new Error(t('window.aiIPC 不可用'));
  try {
    return (await b.invoke(`ai:providers:${method}`, ...args)) as T;
  } catch (err) {
    // Electron 包装成 "Error invoking remote method 'x': Error: msg"
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(
      new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
      { cause: err },
    );
  }
};

/**
 * 供应商显示名本地化：预设名（如「Ollama（本地）」）与主进程追加的「（环境变量）」后缀
 * 都是中文原文，这里在进入渲染层时统一翻译；用户自己起的名字不在词典里，原样保留。
 */
export function providerDisplayName(name: string): string {
  const env = /^(.*)（环境变量）$/.exec(name);
  if (env) return t('{0}（环境变量）', providerDisplayName(env[1]!));
  return t(name);
}

const localizeState = (s: ProviderState): ProviderState => ({
  ...s,
  providers: s.providers?.map((p) => ({ ...p, name: providerDisplayName(p.name) })),
  envProviders: s.envProviders?.map((e) => ({ ...e, name: providerDisplayName(e.name) })),
});

let lastState: ProviderState | undefined;
const remember = (raw: ProviderState): ProviderState => {
  const s = localizeState(raw);
  lastState = s;
  return s;
};

/** NOMI_PROVIDER 环境变量锁定了 provider：网关的分配不生效，实际按锁定的 provider 路由 */
export function providerOverrideActive(): boolean {
  return Boolean(lastState?.overrideId);
}

/** 当前生效 provider 的显示名（用于消息标签）；未知时 undefined。 */
export function effectiveProviderLabel(): string | undefined {
  const s = lastState;
  // 经统一网关时旧存储只知道一个占位 id，标签由网关的分配给出（services/nomiModel）
  if (!s?.effectiveProviderId || s.effectiveProviderId === 'nomi-gateway') return undefined;
  const id = s.effectiveProviderId;
  const name =
    s.providers.find((p) => p.id === id)?.name ??
    s.envProviders.find((e) => e.id === id)?.name ??
    id;
  return s.effectiveModel ? `${name} · ${s.effectiveModel}` : name;
}

export const providerClient = {
  presets: () =>
    call<ProviderPreset[]>('presets').then((ps) =>
      ps.map((p) => ({ ...p, name: providerDisplayName(p.name) })),
    ),
  state: () => call<ProviderState>('state').then(remember),
  setActive: (id: string | null, model?: string) =>
    call<ProviderState>('setActive', id, model).then(remember),
  onChanged(fn: (s: ProviderState) => void): () => void {
    const b = bridge();
    if (!b) return () => undefined;
    return b.on('ai:providers:changed', (p) => fn(remember(p as ProviderState)));
  },
  onOpenPanel(fn: () => void): () => void {
    const b = bridge();
    if (!b) return () => undefined;
    return b.on('ai:providers:open-panel', () => fn());
  },
};
