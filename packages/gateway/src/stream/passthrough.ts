/**
 * 同协议流式透传（§9.2）：按 SSE 事件整块转发，只在需要时修改事件。
 * - Chat：ChatStreamPatcher（Chat 流修正、工具名还原、正文里的工具调用、复读检测）；
 * - 其它协议：只做复读检测——旁路解码出推理 / 正文，判定为复读时发入口协议的错误事件并停止。
 * 没有触发修正时输出与上游字节一致。
 */
import { ChatStreamPatcher, type ChatPatchOptions } from './chatPatch';
import {
  ChatCompletionsDecoder,
  GeminiDecoder,
  MessagesDecoder,
  ResponsesDecoder,
} from './decoders';
import type { StreamDecoder } from './events';
import { addNote, NOTE_REPETITION } from './fixer';
import { REPETITION_MESSAGE, RepetitionGuard } from './repetition';
import { formatSse, SseParser } from './sse';

import { createStreamConverter, type UpstreamStreamFormat } from './index';

export interface Passthrough {
  push(chunk: string): string;
  end(): string;
  /** 修正决定提前结束（复读）：调用方停止读上游并结束响应 */
  readonly stopped: boolean;
}

function decoderFor(w: UpstreamStreamFormat): StreamDecoder {
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

class RepetitionPassthrough implements Passthrough {
  private buf = '';
  private readonly parser = new SseParser();
  private readonly dec: StreamDecoder;
  private readonly guard = new RepetitionGuard();
  stopped = false;

  constructor(
    private readonly wire: UpstreamStreamFormat,
    private readonly notes?: string[],
  ) {
    this.dec = decoderFor(wire);
  }

  push(chunk: string): string {
    if (this.stopped) return '';
    this.buf += chunk;
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index + m[0].length);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (this.watch(block)) {
        this.buf = '';
        return out + this.fail();
      }
      out += block;
    }
    return out;
  }

  end(): string {
    if (this.stopped) return '';
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  private watch(block: string): boolean {
    for (const ev of this.parser.push(block))
      for (const n of this.dec.push(ev)) {
        if (n.type === 'think' && this.guard.push('think', n.text)) return true;
        if (n.type === 'text' && this.guard.push('text', n.text)) return true;
      }
    return false;
  }

  private fail(): string {
    this.stopped = true;
    addNote(this.notes, NOTE_REPETITION);
    return createStreamConverter(this.wire, this.wire).fail(REPETITION_MESSAGE);
  }
}

/**
 * 同协议透传的事件级修正；Chat 以外的协议关掉复读检测时返回 null（直接写原始字节）。
 */
export function createPassthrough(
  wire: UpstreamStreamFormat,
  opts: ChatPatchOptions,
): Passthrough | null {
  if (wire === 'chat') return new ChatStreamPatcher(opts);
  return opts.repetition ? new RepetitionPassthrough(wire, opts.notes) : null;
}

/**
 * 同协议透传时旁路看上游有没有发结束标记（各协议的判定见 BaseDecoder.terminated）。
 * 透传不经过解码，上游被掐断时客户端只会看到流突然结束：调用方据此补一个入口协议的错误事件。
 */
export class TerminalWatch {
  private readonly parser = new SseParser();
  private readonly dec: StreamDecoder;

  constructor(wire: UpstreamStreamFormat) {
    this.dec = decoderFor(wire);
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

/**
 * 同协议透传中途出错时补给客户端的错误事件。流已经开始了（客户端收到过上游的开头），
 * 不能像转换器那样再发一次 response.created / message_start；Responses 的 sequence_number
 * 交给 ResponsesUsagePatcher 接着上游的编号补。
 */
export function passthroughFail(wire: UpstreamStreamFormat, message: string): string {
  if (wire !== 'responses') return createStreamConverter(wire, wire).fail(message);
  return formatSse('response.failed', {
    type: 'response.failed',
    response: {
      object: 'response',
      status: 'failed',
      output: [],
      error: { code: 'api_error', message },
    },
  });
}
