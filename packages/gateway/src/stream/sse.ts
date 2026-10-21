/**
 * 增量 SSE 解析/序列化：容忍任意分片边界与 CRLF。
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export class SseParser {
  private buf = '';

  /** 推入一段原始文本，返回已完整的事件 */
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = parseBlock(block);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** 流结束：解析残留的最后一个事件（上游可能不带结尾空行） */
  end(): SseEvent[] {
    const rest = this.buf;
    this.buf = '';
    const ev = rest.trim() ? parseBlock(rest) : null;
    return ev ? [ev] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length && !event) return null;
  return { event, data: data.join('\n') };
}

export function formatSse(event: string | undefined, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}
