import { t } from '@nomi-ai/ui';
/**
 * 渲染进程侧的 provider 配置客户端：`ai:providers:*` IPC（经 preload 的 window.aiIPC）。
 *
 * 安全：主进程只回传掩码视图；明文 key 只在 upsert / addKey / rotateKey / testDraft
 * 的参数里单向发出，组件提交后立即清空输入框，不写 localStorage。
 */
export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic';
export type ProviderRole = 'chat' | 'agent-tools' | 'summary';
export type PresetCategory = 'custom' | 'vendor' | 'platform';

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
};

export const CATEGORY_LABELS: Record<PresetCategory, string> = {
  custom: '自定义配置',
  vendor: '模型厂商',
  platform: '第三方平台',
};

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

export interface ProviderInput extends Partial<ProviderConfig> {
  id?: string;
  presetId?: string;
  enabled?: boolean;
  apiKey?: string;
}

export interface FetchModelsResult {
  ok: boolean;
  latencyMs: number;
  url: string;
  models: FetchedModel[];
  error?: string;
}

export interface TestResult {
  endpoint?: string;
  ok: boolean;
  latencyMs: number;
  model?: string;
  error?: string;
  sample?: string;
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
  upsert: (input: ProviderInput) => call<ProviderView>('upsert', input),
  remove: (id: string) => call<void>('remove', id),
  setActive: (id: string | null, model?: string) =>
    call<ProviderState>('setActive', id, model).then(remember),
  fetchModels: (id: string) => call<FetchModelsResult>('fetchModels', id),
  fetchModelsDraft: (input: ProviderInput) => call<FetchModelsResult>('fetchModelsDraft', input),
  setModels: (id: string, models: string[]) => call<ProviderView>('setModels', id, models),
  setRoute: (role: ProviderRole, binding: { providerId: string; model?: string } | null) =>
    call<ProviderState>('setRoute', role, binding).then(remember),
  addKey: (id: string, key: string, label?: string) => call<ProviderView>('addKey', id, key, label),
  rotateKey: (id: string, keyId: string, key: string) =>
    call<ProviderView>('rotateKey', id, keyId, key),
  removeKey: (id: string, keyId: string) => call<ProviderView>('removeKey', id, keyId),
  promoteKey: (id: string, keyId: string) => call<ProviderView>('promoteKey', id, keyId),
  test: (id: string, keyId?: string) => call<TestResult>('test', id, keyId),
  testDraft: (input: ProviderInput) => call<TestResult>('testDraft', input),
  resetUsage: (id?: string) => call<void>('resetUsage', id),
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

export const LOCAL_ONLY_NOTICE = '此 Token 仅保存在本地设备，不会上传或同步';

/** 所有可选 provider（面板 / 切换器共用）：store 中启用的 + 环境变量的 */
export function selectableProviders(
  s: ProviderState,
): Array<{ id: string; label: string; disabled: boolean; group: string; brand: string }> {
  return [
    ...s.providers
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        label: p.name,
        disabled: false,
        group: t('我的供应商'),
        brand: p.presetId,
      })),
    // 没配 key 的环境变量 provider 不可用，不在选择器里占位
    ...s.envProviders
      .filter((e) => e.hasKey)
      .map((e) => ({
        id: e.id,
        label: e.name,
        disabled: false,
        group: t('环境变量'),
        brand: e.id,
      })),
  ];
}

/** 某 provider 在模型选择器里可选的模型：已启用的 → 否则拉取到的 → 否则默认模型。 */
export function selectableModels(s: ProviderState, providerId: string | undefined): string[] {
  if (!providerId) return [];
  const p = s.providers.find((x) => x.id === providerId);
  if (p) {
    const list = p.models.length ? p.models : (p.fetchedModels ?? []).map((m) => m.id);
    return [...new Set([p.defaultModel, ...list].filter(Boolean))];
  }
  const e = s.envProviders.find((x) => x.id === providerId);
  return e?.defaultModel ? [e.defaultModel] : [];
}

/** 端点预览（与主进程 protocol.ts 保持一致） */
export function endpointPreview(protocol: Protocol, baseURL: string, fullUrl: boolean): string {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (fullUrl) return base;
  if (protocol === 'anthropic') return `${/\/v1$/i.test(base) ? base : `${base}/v1`}/messages`;
  return `${base}${protocol === 'openai-responses' ? '/responses' : '/chat/completions'}`;
}
