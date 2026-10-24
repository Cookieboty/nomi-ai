/**
 * 用量采集：用上游协议的解码器旁路读一遍 SSE（同协议透传时也能拿到用量），不改动转发的字节。
 */
import type { Wire } from './ir';
import { jsonToEvents, mergeUsage, SseParser, type NormEvent, type StreamUsage } from './stream';
import {
  ChatCompletionsDecoder,
  GeminiDecoder,
  MessagesDecoder,
  ResponsesDecoder,
} from './stream/decoders';
import type { StreamDecoder } from './stream/events';

function decoderFor(w: Wire): StreamDecoder {
  switch (w) {
    case 'chat':
      return new ChatCompletionsDecoder();
    case 'responses':
      return new ResponsesDecoder();
    case 'gemini':
      return new GeminiDecoder();
    case 'messages':
      return new MessagesDecoder();
  }
}

export class UsageTap {
  private readonly parser = new SseParser();
  private readonly dec: StreamDecoder;
  usage: StreamUsage = {};
  error: string | null = null;
  /** 上游流里的错误事件类型（解码器给出） */
  errorType: string | undefined;
  /** 模型质量（docs/design/model-quality.md §4.1）：内容事件的时间点（epoch ms） */
  firstContentAt: number | undefined;
  firstTextAt: number | undefined;
  lastContentAt: number | undefined;
  /** 上游是否发了结束标记（或明确的错误）：end() 之前读取 */
  get terminated(): boolean {
    return this.dec.terminated;
  }

  constructor(wire: Wire) {
    this.dec = decoderFor(wire);
  }

  private take(evs: NormEvent[]) {
    for (const e of evs) {
      switch (e.type) {
        case 'start':
        case 'finish':
        case 'usage':
          this.usage = mergeUsage(this.usage, e.usage);
          break;
        case 'error':
          // 第一个错误为准（解码器在 end() 里补的「没有结束标记」不覆盖上游明确给的错误）
          if (this.error === null) {
            this.error = e.message;
            this.errorType = e.errorType;
          }
          break;
        case 'text':
          if (!e.text) break;
          this.content();
          this.firstTextAt ??= this.lastContentAt;
          break;
        case 'think':
          if (e.text) this.content();
          break;
        case 'tool_start':
        case 'tool_args':
          this.content();
          break;
        default:
      }
    }
  }

  /** 一个内容事件：一次 Date.now()，热路径上不做别的 */
  private content() {
    const now = Date.now();
    this.firstContentAt ??= now;
    this.lastContentAt = now;
  }

  push(text: string): void {
    for (const ev of this.parser.push(text)) this.take(this.dec.push(ev));
  }

  end(): StreamUsage {
    for (const ev of this.parser.end()) this.take(this.dec.push(ev));
    this.take(this.dec.end());
    return this.usage;
  }
}

/** 非流式响应的用量 */
export function usageOfJson(wire: Wire, body: unknown): StreamUsage {
  let u: StreamUsage = {};
  for (const e of jsonToEvents(wire, body))
    if (e.type === 'start' || e.type === 'finish') u = mergeUsage(u, e.usage);
  return u;
}
