/**
 * 把「可能交错」的文本 / 工具调用事件整理成「串行内容块」输出。
 *
 * Messages（content block）与 Responses（output item）都要求一个块完整结束后才能开始下一个块；
 * 但上游（尤其 Chat Completions 的并行 tool_calls）可能出现 A-start / B-start / A-args / B-args。
 * 不能把「下一个工具开始」当作「上一个工具结束」，否则 A 的后续参数会落到已关闭的块上，
 * 结束事件里的参数也会和最终快照不一致。
 *
 * 规则：
 * - 同一时刻最多一个块处于打开状态（active），它的增量实时下发；
 * - 其它块先缓存（pending，按开始顺序），等 active 关闭后依次打开、一次性补发缓存内容；
 * - 块只在「明确结束」（tool_end）、被后续文本 / 工具顶替（文本块）或整轮 finish 时关闭；
 * - finish：按顺序把所有未结束的块关闭，所以 done / stop 里的参数一定是最终完整值。
 */

export interface SerialBlock {
  kind: 'text' | 'tool';
  /** 工具的上游标识（text 块没有） */
  key?: string;
  id?: string;
  name?: string;
  /** 文本内容 / 工具参数（累积，含尚未下发的缓存） */
  content: string;
  /** 已经向下游发出 start */
  opened: boolean;
  /** 上游已明确该块结束（工具）或已被后续内容顶替（文本） */
  ended: boolean;
  /** 已向下游发出 stop */
  closed: boolean;
}

export interface SerialSink {
  /** 打开块（下游 content_block_start / output_item.added 等） */
  open(b: SerialBlock): string;
  /** 向已打开的块追加内容（实时增量或打开时补发的缓存） */
  delta(b: SerialBlock, delta: string): string;
  /** 关闭块；此时 b.content 已是完整内容 */
  close(b: SerialBlock): string;
}

export class SerialBlocks {
  private active: SerialBlock | null = null;
  private queue: SerialBlock[] = [];
  private tools = new Map<string, SerialBlock>();

  constructor(private readonly sink: SerialSink) {}

  /** 文本：当前是文本块就继续追加；有工具块在写时缓存，等它关闭后再输出 */
  text(t: string): string {
    if (!t) return '';
    if (this.active?.kind === 'text') {
      this.active.content += t;
      return this.sink.delta(this.active, t);
    }
    const last = this.queue[this.queue.length - 1];
    if (last?.kind === 'text' && !last.ended) {
      last.content += t;
      return '';
    }
    const b = this.newBlock('text');
    b.content = t;
    return this.enqueue(b);
  }

  toolStart(key: string, id: string, name: string): string {
    // 文本块不会再有交错：工具开始时先结束它
    let s = this.active?.kind === 'text' ? this.endBlock(this.active) : '';
    const b = this.newBlock('tool');
    b.key = key;
    b.id = id;
    b.name = name;
    this.tools.set(key, b);
    // 排在前面的文本块（缓存中的）同样不会再追加
    for (const q of this.queue) if (q.kind === 'text') q.ended = true;
    s += this.enqueue(b);
    return s;
  }

  toolArgs(key: string, delta: string): string {
    const b = this.tools.get(key);
    if (!b || b.closed || b.ended || !delta) return '';
    b.content += delta;
    return b.opened ? this.sink.delta(b, delta) : '';
  }

  /** 上游明确说这个工具的参数已完整 */
  toolEnd(key: string): string {
    const b = this.tools.get(key);
    if (!b || b.ended) return '';
    return this.endBlock(b);
  }

  /** 整轮结束：按顺序关闭所有块（含缓存中的）；缓存块打开时补发的内容就是最终完整内容 */
  finish(): string {
    for (const q of this.queue) q.ended = true;
    return this.active ? this.endBlock(this.active) : '';
  }

  private newBlock(kind: 'text' | 'tool'): SerialBlock {
    return { kind, content: '', opened: false, ended: false, closed: false };
  }

  private enqueue(b: SerialBlock): string {
    if (this.active || this.queue.length) {
      this.queue.push(b);
      return '';
    }
    return this.activate(b);
  }

  /** 把 b 变成 active：发 start，再补发缓存内容；若已结束就立刻关闭并推进队列 */
  private activate(b: SerialBlock): string {
    this.active = b;
    b.opened = true;
    let s = this.sink.open(b);
    if (b.content) s += this.sink.delta(b, b.content);
    if (b.ended) s += this.closeActive();
    return s;
  }

  private endBlock(b: SerialBlock): string {
    if (b.ended && b.closed) return '';
    b.ended = true;
    if (this.active === b) return this.closeActive();
    return ''; // 缓存中的块：等轮到它时一次性发出并关闭
  }

  private closeActive(): string {
    const b = this.active;
    if (!b) return '';
    this.active = null;
    b.closed = true;
    let s = this.sink.close(b);
    const next = this.queue.shift();
    if (next) s += this.activate(next);
    return s;
  }
}
