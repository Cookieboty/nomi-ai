/**
 * ChatFacade —— 消息发送 / 流式接收 / 中断 / 重生 / 可选 tool agent 循环。
 *
 * - `sendMessage` / `stream` 落在 LLM Provider 上（由 IgPluginHost 注入的 registry 选出）。
 * - `agent` / `agentStream`：当 provider 暴露 `withTools`（Vercel AI SDK 后端）时，
 *   把 ToolRegistry 中的工具交给 AI SDK `stopWhen: stepCountIs` 循环；否则退化为
 *   单次 stream/chat（保持 IPC 契约稳定）。
 * - 思考/推理模型（DeepSeek、Claude thinking、o-series 等）：UI 路径用 `stream` /
 *   `agentStream`（`stream: true`）。`sendMessage` / `agent` 仍走非流式 `chat()`；
 *   经统一网关时由 gateway `timeouts.ts` 对非流式 / reasoning 使用更长首字节超时，
 *   避免旧默认 30s 在思考阶段被客户端主动断开。
 */

import {
  LLMRegistryKey,
  ToolRegistryKey,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type LLMRole,
  type ToolDefinition,
} from '@nomi-ai/bundle-ig-base';

import type { SdkContext } from '../di/SdkContext';
import { AIClientError, ErrorCodes } from '../errors';

import { fitMessagesToBudget, type ContextBudget } from './chatContext';

export interface ChatStreamOptions {
  reqId?: string;
  provider?: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  extra?: Record<string, unknown>;
  /**
   * 多轮上下文预算：`messages` 为完整对话（含 system），发送前按预算裁剪；
   * 传 `false` 关闭裁剪。默认 [DEFAULT_CONTEXT_BUDGET](./chatContext.ts)。
   */
  context?: ContextBudget | false;
  /** Agent loop max steps when using AI SDK tools (default 20, ai-runtime DEFAULT_MAX_STEPS). */
  maxSteps?: number;
  /**
   * 任务角色（未显式指定 provider 时用于路由）：sendMessage/stream 默认 `chat`，
   * agent/agentStream 默认 `agent-tools`；后台摘要等可传 `summary`。
   */
  role?: LLMRole;
}

interface WithTools {
  withTools(defs: ToolDefinition[]): {
    chat: (req: ChatRequest) => Promise<ChatResponse>;
    stream: (req: ChatRequest) => AsyncIterable<ChatChunk>;
  };
}

function hasWithTools(p: LLMProvider): p is LLMProvider & WithTools {
  return typeof (p as unknown as WithTools).withTools === 'function';
}

export interface ChatFacade {
  sendMessage(opts: ChatStreamOptions): Promise<ChatResponse>;
  stream(opts: ChatStreamOptions): AsyncIterable<ChatChunk>;
  /** Single-turn or multi-step tool agent (AI SDK when available). */
  agent(opts: ChatStreamOptions): Promise<ChatResponse>;
  agentStream(opts: ChatStreamOptions): AsyncIterable<ChatChunk>;
  abort(reqId: string): void;
  regenerate(opts: ChatStreamOptions): AsyncIterable<ChatChunk>;
}

interface Picked {
  provider: LLMProvider;
  model?: string;
}

export function createChatFacade(ctx: SdkContext): ChatFacade {
  /**
   * 在途请求 → 实际执行它的 provider 实例。abort 必须通知这些实例：网关 provider 是单槽缓存，
   * 别的角色 / 配置的请求会把它替换掉，按当前路由 `reg.list()` 找不到原实例（#92）。
   */
  const inflight = new Map<string, Set<LLMProvider>>();
  const own = (reqId: string, provider: LLMProvider): (() => void) => {
    let set = inflight.get(reqId);
    if (!set) {
      set = new Set();
      inflight.set(reqId, set);
    }
    set.add(provider);
    const mine = set;
    return () => {
      mine.delete(provider);
      if (!mine.size && inflight.get(reqId) === mine) inflight.delete(reqId);
    };
  };
  const owned = async <T>(req: ChatRequest, provider: LLMProvider, run: () => Promise<T>) => {
    const release = own(req.reqId, provider);
    try {
      return await run();
    } finally {
      release();
    }
  };

  const pick = (opts: ChatStreamOptions, defaultRole: LLMRole): Picked => {
    const reg = ctx.inject(LLMRegistryKey);
    if (!reg) {
      throw new AIClientError(
        ErrorCodes.SEAM_NOT_INJECTED,
        'ctx.llm 未注入；请确认已加载 bundle-ig-base',
      );
    }
    if (opts.provider) {
      const found = reg.get(opts.provider);
      if (!found) {
        throw new AIClientError(
          ErrorCodes.SEAM_NOT_INJECTED,
          `LLM provider '${opts.provider}' 未注册`,
        );
      }
      return { provider: found };
    }
    const routed = reg.resolve?.(opts.role ?? defaultRole);
    if (routed) return routed;
    const providers = reg.list();
    if (providers.length === 0) {
      throw new AIClientError(ErrorCodes.SEAM_NOT_INJECTED, '没有可用的 LLM provider');
    }
    return { provider: providers[0]! };
  };

  const buildRequest = (opts: ChatStreamOptions, picked: Picked): ChatRequest => ({
    reqId: opts.reqId ?? cryptoRandomId(),
    provider: picked.provider.id,
    model: opts.model ?? picked.model ?? 'default',
    messages:
      opts.context === false ? opts.messages : fitMessagesToBudget(opts.messages, opts.context),
    temperature: opts.temperature,
    topP: opts.topP,
    maxTokens: opts.maxTokens,
    stream: false,
    signal: opts.signal,
    extra: opts.extra,
  });

  const listTools = (): ToolDefinition[] => {
    const reg = ctx.inject(ToolRegistryKey);
    return reg ? (reg.list() as ToolDefinition[]) : [];
  };

  const runAgent = (picked: Picked) => {
    const tools = listTools();
    if (hasWithTools(picked.provider) && tools.length > 0) {
      return picked.provider.withTools(tools);
    }
    return picked.provider;
  };

  /**
   * 流式回复结束后发出 `session/assistant-message`（AIClient 桥接为 `message:complete`），
   * 桌面角色气泡据此显示回复摘要。只对 stream / agentStream / regenerate（用户对话）发出；
   * sendMessage（后台摘要等）不发。中途出错 / 中止且没有文本时不发。
   */
  const tap = (
    it: AsyncIterable<ChatChunk>,
    req: ChatRequest,
    provider: LLMProvider,
  ): AsyncIterable<ChatChunk> => ({
    async *[Symbol.asyncIterator]() {
      let text = '';
      let finish: ChatResponse['finishReason'] | undefined;
      const release = own(req.reqId, provider);
      try {
        for await (const c of it) {
          if (c.type === 'delta') text += c.content;
          else if (c.type === 'done') finish = c.finishReason;
          yield c;
        }
      } finally {
        release();
        if (text.trim()) {
          try {
            ctx.emit('session/assistant-message', {
              message: {
                id: req.reqId,
                sessionId: req.reqId,
                role: 'assistant',
                parts: [{ type: 'text', text }],
                createdAt: Date.now(),
                meta: { provider: req.provider, model: req.model, finishReason: finish },
              },
            });
          } catch {
            /* 事件总线异常不影响对话 */
          }
        }
      }
    },
  });

  return {
    async sendMessage(opts) {
      const picked = pick(opts, 'chat');
      const req = buildRequest(opts, picked);
      return owned(req, picked.provider, () => picked.provider.chat(req));
    },
    stream(opts) {
      const picked = pick(opts, 'chat');
      const req = { ...buildRequest(opts, picked), stream: true };
      return tap(picked.provider.stream(req), req, picked.provider);
    },
    async agent(opts) {
      const picked = pick(opts, 'agent-tools');
      const req = buildRequest(opts, picked);
      return owned(req, picked.provider, () => runAgent(picked).chat(req));
    },
    agentStream(opts) {
      const picked = pick(opts, 'agent-tools');
      const req = { ...buildRequest(opts, picked), stream: true };
      return tap(runAgent(picked).stream(req), req, picked.provider);
    },
    abort(reqId) {
      // 先通知实际在跑的实例，再按当前路由兜底（还没开始迭代的流等）
      const targets = new Set(inflight.get(reqId));
      for (const p of ctx.inject(LLMRegistryKey)?.list() ?? []) targets.add(p);
      for (const p of targets) p.abort(reqId);
    },
    regenerate(opts) {
      const picked = pick(opts, 'chat');
      const req = { ...buildRequest(opts, picked), reqId: cryptoRandomId(), stream: true };
      return tap(picked.provider.stream(req), req, picked.provider);
    },
  };
}

function cryptoRandomId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
