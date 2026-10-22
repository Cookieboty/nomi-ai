/**
 * 协议无关的流式中间事件。各上游解码器产出它，各下游编码器消费它（docs/design/unified-gateway.md §9.1）。
 * 推理相关事件（think / think_sig / sealed / text_sig）目前由解码器产出、Messages / Responses / Chat
 * 编码器暂不输出，保持现有 CLI 看到的内容不变；Gemini 编码器把推理文本输出为 thought 部分。
 */

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal';

export interface StreamUsage {
  /** 沿用各协议上游给的输入数（OpenAI 含缓存部分，Anthropic 不含），统一口径见 §9.4 */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type NormEvent =
  | { type: 'start'; id?: string; model?: string; usage?: StreamUsage }
  | { type: 'text'; text: string }
  /** 新的一段推理开始 */
  | { type: 'think_start'; id?: string }
  | { type: 'think'; text: string }
  /** Anthropic signature_delta；Gemini 推理部分的 thoughtSignature */
  | { type: 'think_sig'; signature: string }
  /** redacted_thinking / 带 encrypted_content 的 reasoning item：只能原样发回原协议 */
  | { type: 'sealed'; by: 'messages' | 'responses'; raw: unknown }
  /** Gemini 正文部分的 thoughtSignature */
  | { type: 'text_sig'; signature: string }
  /** key：上游内唯一的工具调用标识（下标或 item id），用于关联参数增量 */
  | { type: 'tool_start'; key: string; id: string; name: string }
  | { type: 'tool_args'; key: string; delta: string }
  /** 上游明确说这个工具的参数已完整（Messages content_block_stop / Responses arguments.done 等）。
   *  没有这个事件的上游（Chat Completions 并行 tool_calls）在整轮 finish 时才结束工具。 */
  | { type: 'tool_end'; key: string }
  /** 流中途更新的用量（不结束流） */
  | { type: 'usage'; usage: StreamUsage }
  | { type: 'finish'; reason: StopReason; usage?: StreamUsage }
  | { type: 'error'; message: string; errorType?: string; status?: number; retryAfterMs?: number }
  /** 心跳：编码器按协议输出（SSE 注释或 ping） */
  | { type: 'alive' };

export interface StreamDecoder {
  /** 一个完整 SSE 事件 → 中间事件 */
  push(ev: { event?: string; data: string }): NormEvent[];
  /** 上游流结束：补齐未发出的 finish */
  end(): NormEvent[];
}

export interface StreamEncoder {
  encode(ev: NormEvent): string;
  /** 下游流结束前的收尾（如 [DONE]） */
  end(): string;
}

/** 合并用量：后来的已知值覆盖先前的，未知值不覆盖 */
export function mergeUsage(a: StreamUsage, b: StreamUsage | undefined): StreamUsage {
  const o: StreamUsage = { ...a };
  if (!b) return o;
  for (const k of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const) {
    if (b[k] !== undefined) o[k] = b[k];
  }
  return o;
}
