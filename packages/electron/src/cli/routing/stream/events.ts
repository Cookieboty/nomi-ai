/**
 * 协议无关的流式中间事件。各上游解码器产出它，各下游编码器消费它。
 */

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';

export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type NormEvent =
  | { type: 'start'; id?: string; model?: string; usage?: StreamUsage }
  | { type: 'text'; text: string }
  /** key：上游内唯一的工具调用标识（下标或 item id），用于关联参数增量 */
  | { type: 'tool_start'; key: string; id: string; name: string }
  | { type: 'tool_args'; key: string; delta: string }
  /** 上游明确说这个工具的参数已完整（Messages content_block_stop / Responses arguments.done 等）。
   *  没有这个事件的上游（Chat Completions 并行 tool_calls）在整轮 finish 时才结束工具。 */
  | { type: 'tool_end'; key: string }
  | { type: 'finish'; reason: StopReason; usage?: StreamUsage }
  | { type: 'error'; message: string; errorType?: string };

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
