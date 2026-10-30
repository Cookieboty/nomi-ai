/**
 * 结束检测（§6.4）：旁路看上游有没有发结束标记（各协议的判定见 BaseDecoder.terminated）。
 * 透传不经过解码，上游被掐断时客户端只会看到流突然结束：调用方据此补一个入口协议的失败事件。
 */
import { createDecoder } from '../stream/decoders';
import type { StreamDecoder } from '../stream/events';
import { SseParser } from '../stream/sse';

export type CanonicalWire = 'chat' | 'responses' | 'gemini' | 'messages';

export class TerminalWatch {
  private readonly parser = new SseParser();
  private readonly dec: StreamDecoder;

  constructor(wire: CanonicalWire) {
    this.dec = createDecoder(wire);
  }

  push(chunk: string): void {
    if (this.dec.terminated) return;
    for (const ev of this.parser.push(chunk)) this.dec.push(ev);
  }

  /** 上游流已经读完：残留的最后一个事件也算进去 */
  get terminated(): boolean {
    if (!this.dec.terminated) for (const ev of this.parser.end()) this.dec.push(ev);
    return this.dec.terminated;
  }
}
