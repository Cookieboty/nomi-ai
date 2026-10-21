/**
 * 统一中间表示（IR，docs/design/unified-gateway.md §9.1）。
 * 只用于跨协议的请求转换；同协议路径不经过 IR（§9.2），避免丢掉协议的新字段。
 */

/** 四种上游 / 入口协议 */
export type Wire = 'messages' | 'responses' | 'chat' | 'gemini';

export const WIRES: readonly Wire[] = ['messages', 'responses', 'chat', 'gemini'];

export type IRPartKind = 'text' | 'image' | 'file' | 'tool_call' | 'tool_result' | 'thinking';

export interface IRPart {
  kind: IRPartKind;
  /** text / thinking / tool_result 的文本 */
  text?: string;
  /** image / file：base64（mediaType + data）或 URL */
  mediaType?: string;
  data?: string;
  url?: string;
  /** tool_call：调用 id、工具名、JSON 字符串形式的参数 */
  id?: string;
  name?: string;
  args?: string;
  /** tool_result：对应的调用 id */
  callId?: string;
  isError?: boolean;
  /** tool_result 里带的图片 */
  images?: IRPart[];
  /** Anthropic thinking 签名；Gemini thoughtSignature */
  signature?: string;
  /** 加密推理原文（redacted_thinking / 带 encrypted_content 的 reasoning item），只能发回原协议 */
  sealed?: { by: 'messages' | 'responses'; raw: unknown };
  /** 来自 Codex 自由文本（custom）工具的调用 */
  custom?: boolean;
}

export interface IRMessage {
  role: 'user' | 'assistant';
  parts: IRPart[];
}

export interface IRTool {
  name: string;
  description?: string;
  schema: unknown;
  /** custom：Codex 自由文本工具，非 Responses 上游转成参数为 {input:string} 的函数 */
  kind: 'function' | 'custom';
}

export type IRToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface IRReasoning {
  effort?: string;
  budget?: number;
  off?: boolean;
}

export interface IRRequest {
  model: string;
  /** 分段保留（Messages 的 system 数组每段一项） */
  system: IRPart[];
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice?: IRToolChoice;
  /** 只有明确禁止并行时为 false */
  parallelToolCalls?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  /** 入口带的推理设置（编码器是否下发由上游能力决定，见 §12.7） */
  reasoning?: IRReasoning;
}
