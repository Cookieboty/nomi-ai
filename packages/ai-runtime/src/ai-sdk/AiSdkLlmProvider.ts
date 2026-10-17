/**
 * LLMProvider backed by Vercel AI SDK (`generateText` / `streamText`).
 *
 * 三种上游协议（见 providers/protocol.ts），全部通用、无按厂商的代码路径：
 * - openai-chat       → @ai-sdk/openai-compatible（POST {base}/chat/completions）
 * - openai-responses  → @ai-sdk/openai `.responses()`（POST {base}/responses）
 * - anthropic         → @ai-sdk/anthropic（POST {base}/v1/messages）
 *
 * Keeps the existing ChatFacade / IPC surface: chat() and stream() still speak
 * bundle-ig-base ChatRequest / ChatChunk. Tool loops use `stopWhen: stepCountIs`.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProvider,
  ToolDefinition,
} from '@nomi-ai/bundle-ig-base';
import { ENV_ENDPOINT_DEFAULTS } from '@nomi-ai/bundle-ig-base';
import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';

import {
  fullUrlFetch,
  mapModel,
  sdkBaseURL,
  type ModelMapping,
  type Protocol,
} from '../providers/protocol';

import { toAiSdkToolSet } from './mapTools';

export interface AiSdkLlmProviderOptions {
  id: string;
  /** 上游协议（默认 openai-chat） */
  protocol?: Protocol;
  /** API 请求地址（必填）；fullUrl=true 时为最终端点原样使用 */
  baseURL?: string;
  fullUrl?: boolean;
  apiKey?: string;
  defaultModel?: string;
  requiresApiKey?: boolean;
  /** 请求模型 → 上游模型 */
  modelMap?: ModelMapping[];
  /** 思考 / 推理（anthropic: thinking；openai: reasoningEffort） */
  thinking?: boolean;
  userAgent?: string;
  /** Max agent loop steps when tools are attached (default 5). */
  maxSteps?: number;
  fetchImpl?: typeof fetch;
  /** Extra HTTP headers sent with every request (e.g. gateway routing / org id). */
  headers?: Record<string, string>;
}

/** 每条消息最多带几张图、总 base64 体积上限（约 12 MB 原图） */
const MAX_IMAGES = 6;
const MAX_IMAGE_BASE64 = 16 * 1024 * 1024;

/** AI SDK 7+ rejects role:system in `messages`; fold them into `instructions`. */
export function splitPrompt(messages: ChatMessage[]): {
  instructions: string | undefined;
  messages: ModelMessage[];
} {
  const systems: string[] = [];
  const rest: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      rest.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId ?? 'unknown',
            toolName: m.name ?? 'tool',
            output: { type: 'text', value: m.content },
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      rest.push({ role: 'assistant', content: m.content });
      continue;
    }
    const images = (m.images ?? []).filter(
      (i) => /^image\/(png|jpeg|webp|gif)$/.test(i.mime) && typeof i.data === 'string',
    );
    if (images.length) {
      let budget = MAX_IMAGE_BASE64;
      const parts: Array<
        { type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }
      > = [];
      for (const i of images.slice(0, MAX_IMAGES)) {
        if (i.data.length > budget) break;
        budget -= i.data.length;
        parts.push({ type: 'image', image: i.data, mediaType: i.mime });
      }
      parts.push({ type: 'text', text: m.content });
      rest.push({ role: 'user', content: parts });
      continue;
    }
    rest.push({ role: 'user', content: m.content });
  }
  return {
    instructions: systems.length > 0 ? systems.join('\n\n') : undefined,
    messages: rest,
  };
}

function usageOf(
  u:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      }
    | undefined,
): ChatUsage | undefined {
  if (!u) return undefined;
  const promptTokens = u.inputTokens ?? 0;
  const completionTokens = u.outputTokens ?? 0;
  const cacheReadTokens = u.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.totalTokens ?? promptTokens + completionTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

/** 工具输出 → 展示用字符串（字符串原样，其它序列化；过长截断，避免把整份检索结果塞进 IPC） */
export function stringifyToolOutput(v: unknown, max = 6000): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > max ? `${s.slice(0, max)}\n… (+${s.length - max})` : s;
}

function finishOf(raw: string | undefined): ChatResponse['finishReason'] {
  switch (raw) {
    case 'length':
    case 'content-filter':
      return raw === 'content-filter' ? 'content_filter' : 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function buildModelFactory(opts: AiSdkLlmProviderOptions): (modelId: string) => LanguageModel {
  const protocol = opts.protocol ?? 'openai-chat';
  if (!opts.baseURL?.trim()) throw new Error(`[${opts.id}] baseURL is required`);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.userAgent?.trim()) headers['User-Agent'] = opts.userAgent.trim();
  const hdrs = Object.keys(headers).length > 0 ? headers : undefined;
  const baseURL = sdkBaseURL(protocol, opts.baseURL, opts.fullUrl);
  const fetchImpl = (fullUrlFetch(protocol, opts.baseURL, Boolean(opts.fullUrl), opts.fetchImpl) ??
    opts.fetchImpl) as never;
  if (protocol === 'anthropic') {
    const provider = createAnthropic({
      apiKey: opts.apiKey ?? '',
      baseURL,
      headers: hdrs,
      fetch: fetchImpl,
    });
    return (modelId) => provider.messages(modelId);
  }
  if (protocol === 'openai-responses') {
    const provider = createOpenAI({
      apiKey: opts.apiKey ?? '',
      baseURL,
      headers: hdrs,
      fetch: fetchImpl,
      name: opts.id,
    });
    return (modelId) => provider.responses(modelId);
  }
  const provider = createOpenAICompatible({
    name: opts.id,
    baseURL,
    apiKey: opts.apiKey,
    headers: hdrs,
    fetch: fetchImpl,
    includeUsage: true,
  });
  return (modelId) => provider.chatModel(modelId);
}

/** thinking 开关 → 各协议的 providerOptions（同样是通用协议参数，不区分厂商）。 */
function thinkingOptions(
  opts: AiSdkLlmProviderOptions,
): Record<string, Record<string, never>> | undefined {
  if (!opts.thinking) return undefined;
  const protocol = opts.protocol ?? 'openai-chat';
  if (protocol === 'anthropic')
    return { anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } } as never;
  if (protocol === 'openai-responses') return { openai: { reasoningEffort: 'medium' } } as never;
  return { [opts.id]: { reasoningEffort: 'medium' } } as never;
}

export class AiSdkLlmProvider implements LLMProvider {
  readonly id: string;
  private readonly opts: AiSdkLlmProviderOptions;
  private readonly aborts = new Map<string, AbortController>();
  private readonly modelFactory: (modelId: string) => LanguageModel;

  constructor(opts: AiSdkLlmProviderOptions) {
    this.id = opts.id;
    this.opts = opts;
    this.modelFactory = buildModelFactory(opts);
  }

  /** Attach ToolDefinitions for a single request (agent loop). */
  withTools(defs: ToolDefinition[]): { chat: LLMProvider['chat']; stream: LLMProvider['stream'] } {
    const tools = toAiSdkToolSet(defs) as ToolSet;
    return {
      chat: (req) => this.runChat(req, tools),
      stream: (req) => this.runStream(req, tools),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.runChat(request);
  }

  stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    return this.runStream(request);
  }

  abort(reqId: string): void {
    this.aborts.get(reqId)?.abort();
    this.aborts.delete(reqId);
  }

  private resolveModel(request: ChatRequest): string {
    const asked =
      request.model && request.model !== 'default'
        ? request.model
        : (this.opts.defaultModel ?? 'default');
    return mapModel(asked, this.opts.modelMap);
  }

  private assertKey(): void {
    if (this.opts.requiresApiKey !== false && !this.opts.apiKey?.trim()) {
      throw new Error(`[${this.id}] API key is not configured`);
    }
  }

  private bindAbort(request: ChatRequest): AbortSignal | undefined {
    const local = new AbortController();
    this.aborts.set(request.reqId, local);
    if (request.signal) {
      if (request.signal.aborted) local.abort();
      else request.signal.addEventListener('abort', () => local.abort(), { once: true });
    }
    return local.signal;
  }

  private async runChat(request: ChatRequest, tools?: ToolSet): Promise<ChatResponse> {
    this.assertKey();
    const signal = this.bindAbort(request);
    try {
      const prompt = splitPrompt(request.messages);
      const result = await generateText({
        model: this.modelFactory(this.resolveModel(request)),
        ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
        messages: prompt.messages,
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        abortSignal: signal,
        ...(thinkingOptions(this.opts) ? { providerOptions: thinkingOptions(this.opts) } : {}),
        ...(tools ? { tools, stopWhen: stepCountIs(this.opts.maxSteps ?? 5) } : {}),
      });
      const toolCalls =
        result.toolCalls?.length > 0
          ? result.toolCalls.map((t) => ({
              id: t.toolCallId,
              name: t.toolName,
              argumentsJson: JSON.stringify(t.input ?? {}),
            }))
          : undefined;
      return {
        reqId: request.reqId,
        provider: this.id,
        model: this.resolveModel(request),
        content: result.text,
        toolCalls,
        finishReason: finishOf(result.finishReason),
        usage: usageOf(result.usage),
      };
    } finally {
      this.aborts.delete(request.reqId);
    }
  }

  private async *runStream(request: ChatRequest, tools?: ToolSet): AsyncIterable<ChatChunk> {
    this.assertKey();
    const signal = this.bindAbort(request);
    try {
      const prompt = splitPrompt(request.messages);
      const result = streamText({
        model: this.modelFactory(this.resolveModel(request)),
        ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
        messages: prompt.messages,
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        abortSignal: signal,
        ...(thinkingOptions(this.opts) ? { providerOptions: thinkingOptions(this.opts) } : {}),
        ...(tools ? { tools, stopWhen: stepCountIs(this.opts.maxSteps ?? 5) } : {}),
      });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          yield { type: 'delta', content: part.text };
        } else if (part.type === 'reasoning-delta') {
          if (part.text) yield { type: 'reasoning', content: part.text };
        } else if (part.type === 'tool-call') {
          yield {
            type: 'tool_call.delta',
            index: 0,
            name: part.toolName,
            argumentsJson: JSON.stringify(part.input ?? {}),
            id: part.toolCallId,
          };
        } else if (part.type === 'tool-result') {
          if (!part.preliminary)
            yield {
              type: 'tool_call.result',
              id: part.toolCallId,
              name: part.toolName,
              output: stringifyToolOutput(part.output),
            };
        } else if (part.type === 'tool-error') {
          yield {
            type: 'tool_call.result',
            id: part.toolCallId,
            name: part.toolName,
            error: part.error instanceof Error ? part.error.message : String(part.error),
          };
        } else if (part.type === 'finish') {
          const u = usageOf(part.totalUsage);
          if (u) yield { type: 'usage', usage: u, model: this.resolveModel(request) };
          yield { type: 'done', finishReason: finishOf(part.finishReason) };
        } else if (part.type === 'error') {
          yield {
            type: 'error',
            error: part.error instanceof Error ? part.error.message : String(part.error),
          };
        }
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.aborts.delete(request.reqId);
    }
  }
}

/**
 * 环境变量 provider（DEEPSEEK_* / OPENAI_* / ANTHROPIC_* / GEMINI_* / OLLAMA_*）→ 同一套通用配置。
 * 只有 claude 用 Anthropic Messages 协议，其余都是 OpenAI Chat Completions（Gemini 走其 OpenAI 兼容端点）。
 */
export const ENV_PROTOCOL: Readonly<Record<string, Protocol>> = { claude: 'anthropic' };

export function envProviderConfig(entry: {
  id: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
}): AiSdkLlmProviderOptions {
  const d = ENV_ENDPOINT_DEFAULTS[entry.id];
  return {
    id: entry.id,
    protocol: ENV_PROTOCOL[entry.id] ?? 'openai-chat',
    apiKey: entry.apiKey,
    baseURL: entry.baseURL ?? d?.baseURL ?? 'http://127.0.0.1',
    defaultModel: entry.model ?? d?.model ?? 'default',
    requiresApiKey: d?.requiresApiKey ?? Boolean(entry.apiKey),
  };
}

export function createAiSdkProviderFromEntry(entry: {
  id: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
}): AiSdkLlmProvider {
  return new AiSdkLlmProvider(envProviderConfig(entry));
}
