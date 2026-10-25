/**
 * 增量 SSE 解析/序列化：容忍任意分片边界与 CRLF。
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/** 一个完整事件的原文：body 不含结尾空行，sep 是结尾空行本身（LF / CRLF 原样） */
export interface SseBlock {
  body: string;
  sep: string;
}

/**
 * 按结尾空行增量切分 SSE 原文。记住已扫描到的位置：一个大事件（图片 base64、整段工具参数）分几百片
 * 到达时不再每片都从头扫一遍、每个事件都重新拷贝剩余缓冲（原来是 O(n²)，4MB 事件分 16KB 到达要
 * 上百毫秒）。各层的透传 / 修正 / 校验共用它。
 */
export class SseSplitter {
  /** 还没凑成完整事件的原文：分片存放，拼接推迟到出现结尾空行时（大事件不反复拼接整串） */
  private parts: string[] = [];
  /** parts 末尾的几个字符（结尾空行可能跨片） */
  private tail = '';
  private readonly re = /\r?\n\r?\n/g;

  /** 推入一段原文，返回新凑齐的事件 */
  push(chunk: string): SseBlock[] {
    if (!chunk) return [];
    // 结尾空行最长 4 个字符：可能有 3 个落在之前的分片末尾；先只看新片 + 这几个字符
    this.re.lastIndex = 0;
    if (this.parts.length && !this.re.test(this.tail + chunk)) {
      this.parts.push(chunk);
      this.tail = (this.tail + chunk).slice(-3);
      return [];
    }
    const prev = this.parts.length ? this.parts.join('') : '';
    const buf = prev + chunk;
    const out: SseBlock[] = [];
    this.re.lastIndex = Math.max(0, prev.length - 3);
    let start = 0;
    for (let m = this.re.exec(buf); m; m = this.re.exec(buf)) {
      out.push({ body: buf.slice(start, m.index), sep: m[0] });
      start = m.index + m[0].length;
    }
    const rest = start ? buf.slice(start) : buf;
    this.parts = rest ? [rest] : [];
    this.tail = rest.slice(-3);
    return out;
  }

  /** 推入一段原文，返回到最后一个结尾空行为止的全部原文（没有完整事件时为空串） */
  pushRaw(chunk: string): string {
    const blocks = this.push(chunk);
    let out = '';
    for (const b of blocks) out += b.body + b.sep;
    return out;
  }

  /** 取走还没凑成完整事件的残留并清空 */
  take(): string {
    const rest = this.parts.join('');
    this.parts = [];
    this.tail = '';
    return rest;
  }
}

export class SseParser {
  private readonly split = new SseSplitter();

  /** 推入一段原始文本，返回已完整的事件 */
  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (const b of this.split.push(chunk)) {
      const ev = parseBlock(b.body);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** 流结束：解析残留的最后一个事件（上游可能不带结尾空行） */
  end(): SseEvent[] {
    const rest = this.split.take();
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
