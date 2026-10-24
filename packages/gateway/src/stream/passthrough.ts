/**
 * 同协议流式透传（§9.2）：按 SSE 事件整块转发，只在需要时修改事件。
 * - Chat：ChatStreamPatcher（Chat 流修正、工具名还原、正文里的工具调用、复读检测）；
 * - 其它协议：只做复读检测——旁路解码出推理 / 正文，判定为复读时发入口协议的错误事件并停止。
 * 没有触发修正时输出与上游字节一致。
 */
import { REPETITION_MESSAGE } from '../models/rules/response/repetition';
import { ResponseRules } from '../models/rules/response/rules';

import { ChatStreamPatcher, type ChatPatchOptions } from './chatPatch';
import { createDecoder } from './decoders';
import type { StreamDecoder } from './events';
import { formatSse, SseParser } from './sse';

export { TerminalWatch } from '../canonical/terminal';

import { createStreamConverter, type UpstreamStreamFormat } from './index';

export interface Passthrough {
  push(chunk: string): string;
  end(): string;
  /** 修正决定提前结束（复读）：调用方停止读上游并结束响应 */
  readonly stopped: boolean;
}

const decoderFor = (w: UpstreamStreamFormat): StreamDecoder => createDecoder(w);

class RepetitionPassthrough implements Passthrough {
  private buf = '';
  private readonly parser = new SseParser();
  private readonly dec: StreamDecoder;
  /** 复读检测用同一份规则（§6.9.7） */
  private readonly rules: ResponseRules;
  stopped = false;

  constructor(
    private readonly wire: UpstreamStreamFormat,
    notes?: string[],
  ) {
    this.dec = decoderFor(wire);
    this.rules = new ResponseRules({ repetition: true, ...(notes ? { notes } : {}) });
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
        if (n.type === 'think' && this.rules.reasoning(n.text)) return true;
        if (n.type === 'text' && this.rules.text(n.text) === null) return true;
      }
    return false;
  }

  private fail(): string {
    this.stopped = true;
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
