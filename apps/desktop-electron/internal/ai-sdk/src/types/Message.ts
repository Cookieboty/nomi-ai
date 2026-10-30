/**
 * 业务 Message DTO —— 跨端 IPC 契约的一等公民。
 *
 * 约束（对齐 P5 计划 §P5-2）：
 * - **structuredClone-safe**：仅包含 JSON-safe 原语 / 数组 / 纯对象 + Uint8Array（Uint8Array 可 structuredClone）；
 * - **不含函数、AbortSignal、Promise、Symbol、Map/Set** 等不可克隆值；
 * - 时间统一使用 epoch ms（number）。
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** data URL 或已加密/持久化后的 asset id */
  url: string;
  mime?: string;
  altText?: string;
}

export interface AudioPart {
  type: 'audio';
  /** 音频引用（asset id 或 data URL） */
  url?: string;
  /** 或者内联 PCM/编码后的字节 */
  bytes?: Uint8Array;
  mime?: string;
  durationMs?: number;
}

export interface ToolCallPart {
  type: 'toolCall';
  toolCallId: string;
  name: string;
  /** 已序列化的参数 JSON 字符串（IPC-safe） */
  argumentsJson: string;
}

export interface ToolResultPart {
  type: 'toolResult';
  toolCallId: string;
  ok: boolean;
  /** 结果 JSON 字符串；错误时置 error */
  resultJson?: string;
  error?: string;
}

export type SensoryKind = 'touch' | 'screen' | 'clipboard' | 'wake-word' | string;

export interface SensoryPart {
  type: 'sensory';
  kind: SensoryKind;
  /** 传感器载荷 JSON 字符串（IPC-safe） */
  payloadJson: string;
  at: number;
}

export type MessagePart =
  TextPart | ImagePart | AudioPart | ToolCallPart | ToolResultPart | SensoryPart;

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: number;
  /** 可选：模型 / 提供商信息，用于回放与审计 */
  meta?: {
    provider?: string;
    model?: string;
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  };
}
