/**
 * ProviderService —— 面板 / 托盘使用的 provider 管理门面（主进程）。
 *
 * 只返回视图（掩码 key），所有明文 key 的使用都在主进程内完成。
 */
import type { LLMProviderEntry } from '@nomi-ai/bundle-ig-base';

import { envProviderConfig, type AiSdkLlmProviderOptions } from '../ai-sdk/AiSdkLlmProvider';

import {
  PRESET_CATEGORY_LABELS,
  PROVIDER_PRESETS,
  findPreset,
  type ProviderPreset,
} from './presets';
import {
  PROTOCOL_LABELS,
  endpointURL,
  modelsRequestHeaders,
  modelsURL,
  parseModelList,
  type FetchedModel,
  type Protocol,
} from './protocol';
import {
  defaultProviderFactory,
  type ProviderFactory,
  type RoutedLLMRegistry,
} from './ProviderRouter';
import {
  PROVIDER_ROLES,
  type ProviderInput,
  type ProviderRole,
  type ProviderStore,
  type ProviderUsage,
  type ProviderView,
  type RouteBinding,
} from './ProviderStore';

export interface EnvProviderView {
  id: string;
  name: string;
  protocol: Protocol;
  baseURL?: string;
  defaultModel?: string;
  hasKey: boolean;
  /** 本地服务（如 Ollama），无需 key */
  keyless: boolean;
  active: boolean;
  usage: ProviderUsage;
  source: 'env';
}

export interface ProviderState {
  providers: ProviderView[];
  envProviders: EnvProviderView[];
  activeProviderId?: string;
  /** 实际生效的对话 provider（考虑 override / 路由 / env fallback）——下一次请求就发给它 */
  effectiveProviderId?: string;
  /** 实际生效的对话模型 */
  effectiveModel?: string;
  routes: Partial<Record<ProviderRole, RouteBinding>>;
  roles: readonly ProviderRole[];
  encryption: 'safeStorage' | 'none';
  overrideId?: string;
}

export interface FetchModelsResult {
  ok: boolean;
  latencyMs: number;
  url: string;
  models: FetchedModel[];
  error?: string;
}

export interface TestResult {
  /** 实际请求的端点 */
  endpoint?: string;
  ok: boolean;
  latencyMs: number;
  model?: string;
  error?: string;
  /** 仅为 UI 提示：返回内容前 40 字 */
  sample?: string;
}

export interface ProviderServiceOptions {
  store: ProviderStore;
  envEntries: LLMProviderEntry[];
  getRegistry: () => RoutedLLMRegistry | undefined;
  factory?: ProviderFactory;
  overrideId?: string;
  testTimeoutMs?: number;
  /** 「获取模型」用的 fetch（测试注入） */
  fetchImpl?: typeof fetch;
}

/** 把 key / token 样式的片段从错误信息里抹掉，避免经 UI / 日志泄露。 */
export function redactSecrets(msg: string, secrets: string[] = []): string {
  let out = msg;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out.replace(/\b(sk|key|AIza)[-_A-Za-z0-9]{12,}\b/g, '***').slice(0, 300);
}

export class ProviderService {
  constructor(private readonly opts: ProviderServiceOptions) {}

  onChange(listener: () => void): () => void {
    return this.opts.store.onChange(listener);
  }

  presets(): readonly ProviderPreset[] {
    return PROVIDER_PRESETS;
  }

  /** 预设分类 / 协议的显示名（UI 用） */
  meta(): { categories: typeof PRESET_CATEGORY_LABELS; protocols: typeof PROTOCOL_LABELS } {
    return { categories: PRESET_CATEGORY_LABELS, protocols: PROTOCOL_LABELS };
  }

  state(): ProviderState {
    const { store } = this.opts;
    const usage = store.usage();
    const activeId = store.activeProviderId();
    const resolved = this.opts.getRegistry()?.resolve('chat');
    const effective = resolved?.provider.id;
    const effStored = effective ? store.providers().find((p) => p.id === effective) : undefined;
    const effEnv = effective ? this.opts.envEntries.find((e) => e.id === effective) : undefined;
    const effectiveModel =
      resolved?.model ??
      effStored?.defaultModel ??
      (effEnv ? envProviderConfig(effEnv).defaultModel : undefined);
    return {
      providers: store.list(),
      envProviders: this.opts.envEntries.map((e) => {
        const c = envProviderConfig(e);
        return {
          id: e.id,
          name: `${findPreset(e.id === 'claude' ? 'anthropic' : e.id)?.name ?? e.id}（环境变量）`,
          protocol: c.protocol ?? 'openai-chat',
          baseURL: c.baseURL,
          defaultModel: c.defaultModel,
          hasKey: Boolean(e.apiKey) || c.requiresApiKey === false,
          keyless: c.requiresApiKey === false,
          active: activeId === e.id,
          usage: {
            requests: 0,
            errors: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            ...usage[e.id],
          },
          source: 'env' as const,
        };
      }),
      activeProviderId: activeId,
      effectiveProviderId: effective,
      effectiveModel,
      routes: store.routes(),
      roles: PROVIDER_ROLES,
      encryption: store.encryption,
      overrideId: this.opts.overrideId,
    };
  }

  private assertKnown(id: string): void {
    const known = this.opts.store.has(id) || this.opts.envEntries.some((e) => e.id === id);
    if (!known) throw new Error(`provider '${id}' 不存在`);
  }

  upsert(input: ProviderInput): ProviderView {
    return this.opts.store.upsert(input);
  }

  remove(id: string): void {
    this.opts.store.remove(id);
  }

  setActive(id: string | null, model?: string): ProviderState {
    if (id) this.assertKnown(id);
    this.opts.store.setActive(id ?? undefined, model);
    return this.state();
  }

  setModels(id: string, enabled: string[]): ProviderView {
    return this.opts.store.setModels(id, { enabled });
  }

  /** 已保存 provider：拉取上游模型列表并缓存到 provider.fetchedModels。 */
  async fetchModels(id: string): Promise<FetchModelsResult> {
    const p = this.opts.store.providers().find((x) => x.id === id);
    if (!p) throw new Error(`provider '${id}' 不存在`);
    const key = this.opts.store.resolveKeys(id)[0];
    const res = await this.listModels(
      {
        protocol: p.protocol,
        baseURL: p.baseURL,
        fullUrl: p.fullUrl,
        headers: p.headers,
        userAgent: p.userAgent,
      },
      key,
    );
    if (res.ok) this.opts.store.setModels(id, { fetched: res.models });
    return res;
  }

  /** 草稿（新建 / 编辑中未保存）：拉取模型列表；编辑已有 provider 且没填新 key 时用已保存的 key。 */
  async fetchModelsDraft(input: ProviderInput): Promise<FetchModelsResult> {
    const cfg = this.draftConfig(input);
    return this.listModels(cfg, cfg.apiKey);
  }

  private async listModels(
    cfg: {
      protocol: Protocol;
      baseURL: string;
      fullUrl?: boolean;
      headers?: Record<string, string>;
      userAgent?: string;
    },
    apiKey: string | undefined,
  ): Promise<FetchModelsResult> {
    const url = modelsURL(cfg.protocol, cfg.baseURL, cfg.fullUrl);
    const t0 = Date.now();
    const extra = {
      ...(cfg.headers ?? {}),
      ...(cfg.userAgent ? { 'User-Agent': cfg.userAgent } : {}),
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.testTimeoutMs ?? 15_000);
    try {
      const f = (this.opts.fetchImpl ?? fetch) as typeof fetch;
      const r = await f(url, {
        headers: modelsRequestHeaders(cfg.protocol, apiKey, extra),
        signal: ctl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      const models = parseModelList(JSON.parse(text));
      return { ok: true, latencyMs: Date.now() - t0, url, models };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        url,
        models: [],
        error: redactSecrets(
          ctl.signal.aborted ? '超时' : err instanceof Error ? err.message : String(err),
          apiKey ? [apiKey] : [],
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 表单草稿 → 完整连接配置（缺省值来自预设 / 已保存的 provider）。 */
  private draftConfig(
    input: ProviderInput,
  ): AiSdkLlmProviderOptions & { protocol: Protocol; baseURL: string; defaultModel: string } {
    const saved = input.id ? this.opts.store.providers().find((x) => x.id === input.id) : undefined;
    const preset = findPreset(input.presetId ?? saved?.presetId) ?? findPreset('custom')!;
    const apiKey =
      input.apiKey?.trim() || (saved ? this.opts.store.resolveKeys(saved.id)[0] : undefined);
    return {
      id: 'connectivity-test',
      protocol: input.protocol ?? saved?.protocol ?? preset.protocol,
      baseURL: (input.baseURL ?? saved?.baseURL ?? preset.baseURL).trim().replace(/\/+$/, ''),
      fullUrl: input.fullUrl ?? saved?.fullUrl ?? false,
      defaultModel:
        input.defaultModel?.trim() || saved?.defaultModel || preset.defaultModel || 'default',
      modelMap: input.modelMap ?? saved?.modelMap,
      headers: input.headers ?? saved?.headers,
      userAgent: input.userAgent ?? saved?.userAgent,
      thinking: input.thinking ?? saved?.thinking,
      apiKey,
      requiresApiKey: false,
    };
  }

  setRoute(role: ProviderRole, binding: RouteBinding | null): ProviderState {
    if (binding?.providerId) this.assertKnown(binding.providerId);
    this.opts.store.setRoute(role, binding);
    return this.state();
  }

  addKey(id: string, key: string, label?: string): ProviderView {
    return this.opts.store.addKey(id, key, label);
  }

  rotateKey(id: string, keyId: string, key: string): ProviderView {
    return this.opts.store.rotateKey(id, keyId, key);
  }

  removeKey(id: string, keyId: string): ProviderView {
    return this.opts.store.removeKey(id, keyId);
  }

  promoteKey(id: string, keyId: string): ProviderView {
    return this.opts.store.promoteKey(id, keyId);
  }

  resetUsage(id?: string): void {
    this.opts.store.resetUsage(id);
  }

  /** 测试已保存 provider 的某个 key（默认主 key）。 */
  async test(id: string, keyId?: string): Promise<TestResult> {
    const { store } = this.opts;
    const p = store.providers().find((x) => x.id === id);
    if (!p) {
      // env provider：走 registry 里的实例
      const reg = this.opts.getRegistry();
      const prov = reg?.get(id);
      if (!prov) throw new Error(`provider '${id}' 不存在`);
      return this.ping(() =>
        prov.chat({
          reqId: `test-${Date.now()}`,
          provider: id,
          model: 'default',
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 16,
          stream: false,
        }),
      );
    }
    const keys = store.resolveKeys(id);
    const idx = keyId ? p.keys.findIndex((k) => k.id === keyId) : 0;
    if (keyId && idx < 0) throw new Error(`key '${keyId}' 不存在`);
    const apiKey = keys[idx];
    const result = await this.pingWith(
      {
        id: 'connectivity-test',
        protocol: p.protocol,
        baseURL: p.baseURL,
        fullUrl: p.fullUrl,
        defaultModel: p.defaultModel,
        modelMap: p.modelMap,
        headers: p.headers,
        userAgent: p.userAgent,
        apiKey,
        requiresApiKey: false,
      },
      apiKey ? [apiKey] : [],
    );
    store.markKey(id, Math.max(idx, 0), result.ok ? undefined : result.error);
    return result;
  }

  /** 测试 / 测速尚未保存的草稿（面板「填写 → 测试 → 保存」流程）。 */
  async testDraft(input: ProviderInput): Promise<TestResult> {
    const cfg = this.draftConfig(input);
    return this.pingWith(cfg, cfg.apiKey ? [cfg.apiKey] : []);
  }

  private async pingWith(cfg: AiSdkLlmProviderOptions, secrets: string[]): Promise<TestResult> {
    const factory = this.opts.factory ?? defaultProviderFactory;
    const endpoint = cfg.baseURL
      ? endpointURL(cfg.protocol ?? 'openai-chat', cfg.baseURL, cfg.fullUrl)
      : undefined;
    let provider;
    try {
      provider = factory(cfg);
    } catch (err) {
      return {
        ok: false,
        latencyMs: 0,
        endpoint,
        error: redactSecrets(String((err as Error).message), secrets),
      };
    }
    const res = await this.ping(
      () =>
        provider.chat({
          reqId: `test-${Date.now()}`,
          provider: 'connectivity-test',
          model: cfg.defaultModel ?? 'default',
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 16,
          stream: false,
        }),
      secrets,
    );
    return { ...res, endpoint, model: res.model ?? cfg.defaultModel };
  }

  private async ping(
    run: () => Promise<{ content: string; model?: string }>,
    secrets: string[] = [],
  ): Promise<TestResult> {
    const t0 = Date.now();
    const timeoutMs = this.opts.testTimeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超时（${timeoutMs}ms）`)), timeoutMs);
        }),
      ]);
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        model: res.model,
        sample: (res.content ?? '').slice(0, 40),
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: redactSecrets(err instanceof Error ? err.message : String(err), secrets),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
