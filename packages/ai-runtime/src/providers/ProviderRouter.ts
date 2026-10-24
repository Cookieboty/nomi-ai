/**
 * RoutedLLMRegistry —— 把 env providers 与 ProviderStore 里的 providers 合成一个 LLMRegistry，
 * 并提供 `resolve(role)` 做 active provider / 按角色路由。
 *
 * 选择优先级（ChatFacade 未显式指定 provider 时）：
 *   1. `NOMI_PROVIDER` 环境变量（强制覆盖，调试 / 托管部署用）
 *   2. 面板里为该角色（chat / agent-tools / summary）绑定的 provider + 模型
 *   3. 面板里的「当前 provider」
 *   4. 环境变量 providers（已配 key 的云端 → ollama → 未配 key 的）
 * 显式传 `provider: '<id>'` 时直接取该 id（store 与 env 的 id 不会冲突：store 一律 `p-` 前缀）。
 *
 * store 变化时增量重建对应的 AiSdkLlmProvider —— 切换即时生效，无需重启。
 */
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProvider,
  LLMRegistry,
  ToolDefinition,
} from '@nomi-ai/bundle-ig-base';

import { AiSdkLlmProvider, type AiSdkLlmProviderOptions } from '../ai-sdk/AiSdkLlmProvider';

import { estimateTokens } from './estimate';
import { mapModel, type ModelMapping, type Protocol } from './protocol';
import type { ProviderRole, ProviderStore, StoredProvider } from './ProviderStore';
import type { UsageCallEvent } from './usageEvent';

type ToolRunner = {
  chat: (req: ChatRequest) => Promise<ChatResponse>;
  stream: (req: ChatRequest) => AsyncIterable<ChatChunk>;
};

interface WithToolsCapable {
  withTools(defs: ToolDefinition[]): ToolRunner;
}

function hasWithTools(p: LLMProvider): p is LLMProvider & WithToolsCapable {
  return typeof (p as unknown as WithToolsCapable).withTools === 'function';
}

export interface UsageSink {
  recordUsage(
    id: string,
    u: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
    ok: boolean,
  ): void;
  markKey?(id: string, keyIndex: number, error?: string): void;
  /** 每次成功调用一条明细（含模型 / 时间 / 缓存 token） */
  recordCall?(e: UsageCallEvent): void;
  /** 每次请求（含失败、换 key）一条诊断日志；只有元数据，不含对话内容 */
  logCall?(e: LlmCallLog): void;
}

export interface LlmCallLog {
  provider: string;
  /** 用的是第几个 key（0 起） */
  keyIndex: number;
  reqId: string;
  /** 请求里写的模型（可能是 default 占位符或空） */
  requested: string;
  /** 实际发给上游的模型；解析不出时为 unknown */
  model: string;
  stream: boolean;
  ok: boolean;
  error?: string;
  ms: number;
}

/** 认证 / 限流 / 额度类错误：换下一个 key 有意义。 */
export function isKeyError(message: string): boolean {
  return /\b(401|402|403|429)\b|unauthori[sz]ed|forbidden|invalid[_ ]?api[_ ]?key|incorrect api key|api key|quota|rate limit|insufficient|billing/i.test(
    message,
  );
}

/**
 * 包装一个 provider 的多个 key（每个 key 一个 AiSdkLlmProvider 实例），按顺序 fallback，
 * 并把 AI SDK 返回的 token usage 记到本地统计。
 */
export class TrackedProvider implements LLMProvider, WithToolsCapable {
  constructor(
    readonly id: string,
    private readonly candidates: LLMProvider[],
    private readonly sink?: UsageSink,
    /** provider 的默认模型（请求未指定模型时记账用） */
    private readonly defaultModel?: string,
    /** provider 的模型映射（上游没回报实际模型时，用它把请求里的别名解析成真实模型再记账） */
    private readonly modelMap?: readonly ModelMapping[],
  ) {
    if (candidates.length === 0) throw new Error(`[${id}] no candidates`);
  }

  withTools(defs: ToolDefinition[]): ToolRunner {
    return {
      chat: (req) =>
        this.runChat(req, (p) => (hasWithTools(p) ? p.withTools(defs).chat(req) : p.chat(req))),
      stream: (req) =>
        this.runStream(req, (p) =>
          hasWithTools(p) ? p.withTools(defs).stream(req) : p.stream(req),
        ),
    };
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.runChat(req, (p) => p.chat(req));
  }

  stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    return this.runStream(req, (p) => p.stream(req));
  }

  abort(reqId: string): void {
    for (const c of this.candidates) c.abort(reqId);
  }

  private async runChat(
    req: ChatRequest,
    call: (p: LLMProvider) => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    let lastErr: unknown;
    const startedAt = Date.now();
    for (let i = 0; i < this.candidates.length; i++) {
      try {
        const res = await call(this.candidates[i]!);
        this.sink?.markKey?.(this.id, i);
        this.logCall(req, i, startedAt, false, res.model);
        this.emitCall(req, startedAt, res.model, res.usage, res.content);
        this.sink?.recordUsage(
          this.id,
          res.usage
            ? {
                inputTokens: res.usage.promptTokens,
                outputTokens: res.usage.completionTokens,
                totalTokens: res.usage.totalTokens,
              }
            : undefined,
          true,
        );
        return { ...res, provider: this.id };
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.sink?.markKey?.(this.id, i, msg);
        this.logCall(req, i, startedAt, false, undefined, msg);
        const more = i < this.candidates.length - 1;
        if (!more || !isKeyError(msg) || req.signal?.aborted) break;
      }
    }
    this.sink?.recordUsage(this.id, undefined, false);
    throw lastErr;
  }

  /**
   * 计费用的模型名（账本键 / 单价匹配用）：优先用 provider 已解析出的实际模型（default 占位符已换成默认模型、
   * modelMap 别名已映射）；它没给时才自己按同样规则解析 请求模型 → 默认模型 → 映射。
   * 请求里的占位符 / 别名不能当计费键，否则调用会记成 default / 别名，费用缺失或按错价格计算。
   */
  private billingModel(req: ChatRequest, resModel: string | undefined): string {
    if (resModel?.trim()) return resModel.trim();
    const asked = req.model && req.model !== 'default' ? req.model : (this.defaultModel ?? '');
    const resolved = asked ? mapModel(asked, this.modelMap).trim() : '';
    return resolved || 'unknown';
  }

  /** 诊断日志：这次请求发给了谁、用的哪个模型、成没成（排查「请求没带模型」之类的问题） */
  private logCall(
    req: ChatRequest,
    keyIndex: number,
    startedAt: number,
    stream: boolean,
    resModel: string | undefined,
    error?: string,
  ): void {
    if (!this.sink?.logCall) return;
    try {
      this.sink.logCall({
        provider: this.id,
        keyIndex,
        reqId: req.reqId,
        requested: req.model ?? '',
        model: this.billingModel(req, resModel),
        stream,
        ok: !error,
        ...(error ? { error } : {}),
        ms: Math.max(0, Date.now() - startedAt),
      });
    } catch {
      /* 日志失败不能影响对话 */
    }
  }

  /** 记一条调用明细：上游有 usage 用 usage，没有才按文本估算并标记 estimated */
  private emitCall(
    req: ChatRequest,
    startedAt: number,
    resModel: string | undefined,
    usage: ChatUsage | undefined,
    outText: string,
  ): void {
    if (!this.sink?.recordCall) return;
    try {
      const model = this.billingModel(req, resModel);
      const base = { providerId: this.id, model, at: startedAt, reqId: req.reqId };
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (usage && (usage.promptTokens || usage.completionTokens)) {
        this.sink.recordCall({
          ...base,
          durationMs,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          estimated: false,
        });
        return;
      }
      const inText = req.messages.map((m) => m.content).join('\n');
      this.sink.recordCall({
        ...base,
        durationMs,
        inputTokens: estimateTokens(inText),
        outputTokens: estimateTokens(outText),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated: true,
      });
    } catch {
      /* 记账失败不能影响对话 */
    }
  }

  private async *runStream(
    req: ChatRequest,
    call: (p: LLMProvider) => AsyncIterable<ChatChunk>,
  ): AsyncIterable<ChatChunk> {
    const startedAt = Date.now();
    for (let i = 0; i < this.candidates.length; i++) {
      let emitted = false;
      let outText = '';
      let usedModel: string | undefined;
      let fullUsage: ChatUsage | undefined;
      let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
      let failed: string | undefined;
      const more = i < this.candidates.length - 1;
      for await (const chunk of call(this.candidates[i]!)) {
        if (chunk.type === 'error') {
          failed = chunk.error;
          // 尚未输出任何内容且是 key 类错误：静默换下一个 key
          if (!emitted && more && isKeyError(chunk.error) && !req.signal?.aborted) break;
          yield chunk;
          continue;
        }
        if (chunk.type === 'delta') outText += chunk.content;
        if (chunk.type === 'usage') {
          fullUsage = chunk.usage;
          usedModel = chunk.model;
          usage = {
            inputTokens: chunk.usage.promptTokens,
            outputTokens: chunk.usage.completionTokens,
            totalTokens: chunk.usage.totalTokens,
          };
        }
        if (
          chunk.type === 'delta' ||
          chunk.type === 'tool_call.delta' ||
          chunk.type === 'reasoning'
        )
          emitted = true;
        yield chunk;
      }
      this.sink?.markKey?.(this.id, i, failed);
      this.logCall(req, i, startedAt, true, usedModel, failed);
      if (failed && !emitted && more && isKeyError(failed) && !req.signal?.aborted) continue;
      this.sink?.recordUsage(this.id, usage, !failed);
      if (!failed) this.emitCall(req, startedAt, usedModel, fullUsage, outText);
      return;
    }
  }
}

export type ProviderFactory = (opts: AiSdkLlmProviderOptions) => LLMProvider;

/** 经统一网关的 Nomi 对话在用量 / 记账里显示的 provider id */
export const GATEWAY_PROVIDER_ID = 'nomi-gateway';
/** 统一网关报回实际服务模型的响应头（与 @nomi-ai/gateway 的 SERVED_MODEL_HEADER 一致） */
export const NOMI_SERVED_MODEL_HEADER = 'x-nomi-served-model';

export const defaultProviderFactory: ProviderFactory = (opts) => new AiSdkLlmProvider(opts);

/** StoredProvider + 解密后的 keys → TrackedProvider。 */
export function buildStoredProvider(
  p: StoredProvider,
  keys: string[],
  factory: ProviderFactory,
  sink?: UsageSink,
): TrackedProvider {
  const base: AiSdkLlmProviderOptions = {
    id: p.id,
    protocol: p.protocol,
    baseURL: p.baseURL,
    fullUrl: p.fullUrl,
    defaultModel: p.defaultModel,
    modelMap: p.modelMap,
    thinking: p.thinking,
    userAgent: p.userAgent,
    headers: p.headers,
    requiresApiKey: true,
  };
  const candidates =
    keys.length > 0
      ? keys.map((apiKey) => factory({ ...base, apiKey }))
      : // 无 key（本地 Ollama / 自建网关）：允许不带 Authorization
        [factory({ ...base, requiresApiKey: false })];
  return new TrackedProvider(p.id, candidates, sink, p.defaultModel, p.modelMap);
}

export interface ResolvedProvider {
  provider: LLMProvider;
  model?: string;
}

/**
 * 统一网关给 Nomi 对话的路由（docs/design/unified-gateway.md §12.5）：
 * 按角色返回网关地址、nomi 客户端令牌、provider/model 与首选协议；网关未就绪或没配模型时返回 null，
 * 此时退回旧存储（过渡期：旧存储移除前保底，里面是迁移前的同一批供应商）。
 */
export interface GatewayRoute {
  resolve(role: ProviderRole): {
    baseURL: string;
    token: string;
    model: string;
    protocol: Protocol;
    /** 真正收到请求的上游（网关供应商 id 与上游地址），工具结果的隐私判断用它而不是网关回环地址 */
    receiver: { id: string; baseURL: string };
  } | null;
}

export interface RoutedRegistryOptions {
  store?: ProviderStore;
  gateway?: GatewayRoute;
  /** 环境变量 providers（静态） */
  envProviders?: LLMProvider[];
  factory?: ProviderFactory;
  /** `NOMI_PROVIDER` 覆盖 */
  overrideId?: string;
  onError?: (msg: string, err: unknown) => void;
  /** 每次模型请求的诊断日志（元数据，不含对话内容） */
  onCall?: (e: LlmCallLog) => void;
}

export class RoutedLLMRegistry implements LLMRegistry {
  private readonly env = new Map<string, LLMProvider>();
  private readonly extra = new Map<string, LLMProvider>();
  private stored = new Map<string, LLMProvider>();
  private readonly unsubscribe?: () => void;
  /** store 记账 + 诊断日志 */
  private readonly sink?: UsageSink;

  constructor(private readonly opts: RoutedRegistryOptions = {}) {
    const store = opts.store;
    this.sink = store && {
      recordUsage: (id, u, ok) => store.recordUsage(id, u, ok),
      markKey: (id, i, error) => store.markKey(id, i, error),
      recordCall: (e) => store.recordCall(e),
      ...(opts.onCall ? { logCall: opts.onCall } : {}),
    };
    for (const p of opts.envProviders ?? []) {
      this.env.set(p.id, this.sink ? new TrackedProvider(p.id, [p], this.sink) : p);
    }
    if (opts.store) {
      this.rebuild();
      this.unsubscribe = opts.store.onChange(() => this.rebuild());
    }
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  /** 从 store 重建（切换 / 改 key 即时生效）。 */
  rebuild(): void {
    const store = this.opts.store;
    if (!store) return;
    const next = new Map<string, LLMProvider>();
    for (const p of store.providers()) {
      if (!p.enabled) continue;
      try {
        next.set(
          p.id,
          buildStoredProvider(
            p,
            store.resolveKeys(p.id),
            this.opts.factory ?? defaultProviderFactory,
            this.sink,
          ),
        );
      } catch (err) {
        this.opts.onError?.(`build provider ${p.id} failed`, err);
      }
    }
    this.stored = next;
  }

  register(provider: LLMProvider): void {
    this.extra.set(provider.id, provider);
  }

  get(id: string): LLMProvider | undefined {
    return this.stored.get(id) ?? this.env.get(id) ?? this.extra.get(id);
  }

  /** 列表顺序 = 默认选择顺序（第一项即未路由时的默认）。 */
  list(): LLMProvider[] {
    const first = this.resolve('chat')?.provider;
    const all = [...this.stored.values(), ...this.env.values(), ...this.extra.values()];
    return first ? [first, ...all.filter((p) => p !== first)] : all;
  }

  /** env providers（只读视图，供面板展示「环境变量来源」）。 */
  envIds(): string[] {
    return [...this.env.keys()];
  }

  /** 网关 provider 按（地址、令牌、协议）缓存：配置没变就复用同一个实例 */
  private gatewayCache: { sig: string; provider: LLMProvider } | null = null;

  private gatewayProvider(r: NonNullable<ReturnType<GatewayRoute['resolve']>>): LLMProvider {
    const sig = `${r.baseURL}|${r.token}|${r.protocol}|${r.receiver.id}|${r.receiver.baseURL}`;
    if (this.gatewayCache?.sig === sig) return this.gatewayCache.provider;
    const p = (this.opts.factory ?? defaultProviderFactory)({
      id: GATEWAY_PROVIDER_ID,
      protocol: r.protocol,
      baseURL: r.baseURL,
      fullUrl: false,
      defaultModel: r.model,
      apiKey: r.token,
      requiresApiKey: true,
      receiver: r.receiver,
      // 网关回退到别的候选时，记账按实际服务的模型（#97）
      servedModelHeader: NOMI_SERVED_MODEL_HEADER,
    });
    // 用量仍由这里记账（网关对 nomi 客户端的用量回调不再重复记）
    const provider = new TrackedProvider(GATEWAY_PROVIDER_ID, [p], this.sink, r.model);
    this.gatewayCache = { sig, provider };
    return provider;
  }

  resolve(role: ProviderRole = 'chat'): ResolvedProvider | undefined {
    const override = this.opts.overrideId ? this.get(this.opts.overrideId) : undefined;
    if (override) return { provider: override };
    const viaGateway = this.opts.gateway?.resolve(role);
    if (viaGateway) return { provider: this.gatewayProvider(viaGateway), model: viaGateway.model };
    const store = this.opts.store;
    if (store) {
      const route = store.route(role);
      const routed = route ? this.get(route.providerId) : undefined;
      if (routed) return { provider: routed, model: route?.model };
      const activeId = store.activeProviderId();
      const active = activeId ? this.get(activeId) : undefined;
      if (active) return { provider: active };
    }
    const fallback = [...this.env.values(), ...this.extra.values()][0];
    return fallback ? { provider: fallback } : undefined;
  }
}
