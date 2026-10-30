/**
 * 复读检测（docs/design/unified-gateway.md §11.3）：最近 N 个句子里不同的句子不超过 K 个，
 * 判定为复读。推理和正文分别统计。太短的「句子」（如代码里的 `}`、`});`）不计，避免误判。
 */

export const REPEAT_WINDOW = 40;
export const REPEAT_DISTINCT = 3;
/** 计入统计的句子最短长度（去掉首尾空白后的字符数） */
const MIN_SENTENCE = 5;

export const REPETITION_MESSAGE = 'Nomi 网关：模型陷入重复输出，已中断这一轮';

class Channel {
  private partial = '';
  private readonly recent: string[] = [];

  constructor(
    private readonly n: number,
    private readonly k: number,
  ) {}

  /** 推入一段文本；判定为复读时返回 true */
  push(text: string): boolean {
    this.partial += text;
    const re = /[.!?。！？\n]+/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let hit = false;
    while ((m = re.exec(this.partial))) {
      const end = m.index + m[0].length;
      // 结尾的终止符可能还没写完（如 "..."），等下一段
      if (end === this.partial.length) break;
      if (this.add(this.partial.slice(last, m.index))) hit = true;
      last = end;
    }
    this.partial = this.partial.slice(last);
    // 没有标点的长文本不无限累积
    if (this.partial.length > 4000) this.partial = this.partial.slice(-2000);
    return hit;
  }

  private add(sentence: string): boolean {
    const s = sentence.trim();
    if (s.length < MIN_SENTENCE) return false;
    this.recent.push(s);
    if (this.recent.length > this.n) this.recent.shift();
    return this.recent.length >= this.n && new Set(this.recent).size <= this.k;
  }
}

export class RepetitionGuard {
  private readonly think: Channel;
  private readonly text: Channel;
  tripped = false;

  constructor(n = REPEAT_WINDOW, k = REPEAT_DISTINCT) {
    this.think = new Channel(n, k);
    this.text = new Channel(n, k);
  }

  push(kind: 'think' | 'text', s: string): boolean {
    if (this.tripped || !s) return this.tripped;
    if ((kind === 'think' ? this.think : this.text).push(s)) this.tripped = true;
    return this.tripped;
  }
}
