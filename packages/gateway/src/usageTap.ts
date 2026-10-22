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

  constructor(wire: Wire) {
    this.dec = decoderFor(wire);
  }

  private take(evs: NormEvent[]) {
    for (const e of evs) {
      if (e.type === 'start' || e.type === 'finish' || e.type === 'usage')
        this.usage = mergeUsage(this.usage, e.usage);
      else if (e.type === 'error') this.error = e.message;
    }
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
