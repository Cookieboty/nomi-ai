// 跨环境通用的公共类型：LLM / Tools / Memory
// 仅本 bundle 内部使用；后续可迁移到 @nomi-ai/ai-sdk 的 dto。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  /** 用户消息附带的图片（base64，不含 data: 前缀）；只对支持视觉的模型有意义 */
  images?: Array<{ mime: string; data: string }>;
}

export interface ChatRequest {
  reqId: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: Array<{ name: string; description: string; parametersJsonSchema: unknown }>;
  signal?: AbortSignal;
  extra?: Record<string, unknown>;
}

export interface ChatUsage {
  /** 输入 token 总数（含缓存命中 / 写入部分） */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中缓存的输入 token（上游返回时才有） */
  cacheReadTokens?: number;
  /** 写入缓存的输入 token（上游返回时才有） */
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  reqId: string;
  provider: string;
  model: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage?: ChatUsage;
  raw?: unknown;
}

export type ChatChunk =
  | { type: 'delta'; content: string }
  | {
      type: 'tool_call.delta';
      index: number;
      name?: string;
      argumentsJson?: string;
      /** 工具调用 id（与随后的 tool_call.result 配对） */
      id?: string;
    }
  /** 工具执行结果（MCP / 知识库 / 搜索等 Nomi 自己的工具）；error 有值表示失败 */
  | { type: 'tool_call.result'; id: string; name: string; output?: string; error?: string }
  /** 模型的推理 / 思考文本片段 */
  | { type: 'reasoning'; content: string }
  | { type: 'usage'; usage: ChatUsage; /** 实际使用的上游模型名 */ model?: string }
  | { type: 'done'; finishReason: ChatResponse['finishReason'] }
  | { type: 'error'; error: string };

/** 每个 provider 必须实现的最小接口 */
export interface LLMProvider {
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
  abort(reqId: string): void;
}

/** 工具接口 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** zod schema */
  input: unknown;
  /** 是否属于"破坏性"工具（需 UI 确认） */
  dangerous?: boolean;
  /** 只读工具（例如 MCP annotations.readOnlyHint）；用于宽松的确认策略 */
  readOnly?: boolean;
  execute: (input: TInput, ctx: { signal?: AbortSignal }) => Promise<TOutput>;
}

/** 记忆 - 长期 facts / 摘要 / 用户偏好 */
export interface MemoryFact {
  id: string;
  content: string;
  source: 'user' | 'inferred' | 'system';
  createdAt: number;
  score?: number;
}

export interface SessionSummary {
  sessionId: string;
  summary: string;
  updatedAt: number;
  stepCount: number;
}
