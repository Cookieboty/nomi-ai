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
        const more = i < this.candidates.length - 1;
        if (!more || !isKeyError(msg) || req.signal?.aborted) break;
      }
    }
    this.sink?.recordUsage(this.id, undefined, false);
    throw lastErr;
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
      const model = req.model || resModel || this.defaultModel || 'unknown';
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
      if (failed && !emitted && more && isKeyError(failed) && !req.signal?.aborted) continue;
      this.sink?.recordUsage(this.id, usage, !failed);
      if (!failed) this.emitCall(req, startedAt, usedModel, fullUsage, outText);
      return;
    }
  }
}

export type ProviderFactory = (opts: AiSdkLlmProviderOptions) => LLMProvider;

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
  return new TrackedProvider(p.id, candidates, sink, p.defaultModel);
}

export interface ResolvedProvider {
  provider: LLMProvider;
  model?: string;
}

export interface RoutedRegistryOptions {
  store?: ProviderStore;
  /** 环境变量 providers（静态） */
  envProviders?: LLMProvider[];
  factory?: ProviderFactory;
  /** `NOMI_PROVIDER` 覆盖 */
  overrideId?: string;
  onError?: (msg: string, err: unknown) => void;
}

export class RoutedLLMRegistry implements LLMRegistry {
  private readonly env = new Map<string, LLMProvider>();
  private readonly extra = new Map<string, LLMProvider>();
  private stored = new Map<string, LLMProvider>();
  private readonly unsubscribe?: () => void;

  constructor(private readonly opts: RoutedRegistryOptions = {}) {
    for (const p of opts.envProviders ?? []) {
      this.env.set(p.id, opts.store ? new TrackedProvider(p.id, [p], opts.store) : p);
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
            store,
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

  resolve(role: ProviderRole = 'chat'): ResolvedProvider | undefined {
    const override = this.opts.overrideId ? this.get(this.opts.overrideId) : undefined;
    if (override) return { provider: override };
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
