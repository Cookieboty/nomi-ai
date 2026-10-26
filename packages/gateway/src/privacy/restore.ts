/**
 * 回程还原（docs/design/secret-privacy.md §8）：写给客户端之前，把回复里的占位符换回原值，
 * 正文和工具调用参数都换，编程助手执行的命令、写出的文件里是真值。
 *
 * - 只还原这个请求遮掉的占位符（模型只见过这些）；表里没有的原样留着；
 * - 流式按 SSE 事件处理：事件以「可能是占位符开头」的片段结尾时扣住，下一个事件是同一段文本的增量时
 *   把尾巴挪过去拼完整再还原，不是的话原样放出扣住的事件。不增不减字符；
 * - 值写进 JSON 字符串里的 JSON（工具参数增量）时再转义一层；
 * - 任何一步出错都退回原样写出：回程出错只会让客户端看到占位符，不会泄露什么。
 */
import { PLACEHOLDER_RE } from './placeholder';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 值是「JSON 字符串里的 JSON」的字段：工具参数（整段或增量） */
function escapedField(key: string, eventType: string): boolean {
  return (
    key === 'arguments' ||
    key === 'partial_json' ||
    (key === 'delta' && eventType.includes('function_call_arguments'))
  );
}

/** 一个 SSE 事件里的字符串叶子 */
interface Leaf {
  holder: Obj | unknown[];
  key: string | number;
  ctx: string;
  escaped: boolean;
}

/** 区分「同一段文本」用的字段：内容块 / 条目 / 工具调用的编号 */
const CTX_FIELDS = ['type', 'index', 'item_id', 'output_index', 'content_index'];

function leaves(root: unknown, eventType: string): Leaf[] {
  const out: Leaf[] = [];
  const visit = (
    v: unknown,
    path: string,
    holder: Obj | unknown[] | null,
    key: string | number,
  ) => {
    if (typeof v === 'string') {
      if (holder)
        out.push({
          holder,
          key,
          ctx: `${eventType}|${path}`,
          escaped: escapedField(String(key), eventType),
        });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${path}.${i}`, v, i));
      return;
    }
    if (!isObj(v)) return;
    let here = path;
    for (const f of CTX_FIELDS) if (f in v && typeof v[f] !== 'object') here += `[${f}=${v[f]}]`;
    for (const k of Object.keys(v)) visit(v[k], `${here}.${k}`, v, k);
  };
  visit(root, '', null, '');
  return out;
}

function get(l: Leaf): string {
  return (l.holder as Record<string | number, unknown>)[l.key] as string;
}

function set(l: Leaf, s: string): void {
  (l.holder as Record<string | number, unknown>)[l.key] = s;
}

interface SseEvent {
  /** 原样的事件文本（不含结尾空行） */
  raw: string;
  /** data 以外的行（event: / id: / retry: / 注释） */
  lines: string[];
  data: string | null;
}

function parseEvent(raw: string): SseEvent {
  const lines: string[] = [];
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    else lines.push(line);
  }
  return { raw, lines, data: data.length ? data.join('\n') : null };
}

function eventName(ev: SseEvent): string {
  for (const l of ev.lines) if (l.startsWith('event:')) return l.slice(6).trim();
  return '';
}

function serialize(ev: SseEvent, json: unknown): string {
  const head = ev.lines.filter((l) => l !== '');
  return [...head, `data: ${JSON.stringify(json)}`].join('\n') + '\n\n';
}

interface Held {
  ctx: string;
  tail: string;
  /** 扣住的事件：整个（放弃拼接时）/ 去掉尾巴（尾巴挪给下一个事件时） */
  full: string;
  cut: string;
}

export class Restorer {
  /** 每个占位符还原了几处 */
  readonly counts = new Map<string, number>();
  private buf = '';
  private held: Held | null = null;
  private readonly prefixes: string[];

  constructor(private readonly map: ReadonlyMap<string, string>) {
    this.prefixes = [...map.keys()];
  }

  /** 文本里的占位符换回原值 */
  text(s: string, escaped = false): string {
    if (!s.includes('{{')) return s;
    return s.replace(PLACEHOLDER_RE, (p) => {
      const v = this.map.get(p);
      if (v === undefined) return p;
      this.counts.set(p, (this.counts.get(p) ?? 0) + 1);
      return escaped ? JSON.stringify(v).slice(1, -1) : v;
    });
  }

  /** 非流式 JSON 响应体 */
  json(v: unknown): unknown {
    try {
      return this.walkJson(v, '');
    } catch {
      return v;
    }
  }

  private walkJson(v: unknown, key: string): unknown {
    if (typeof v === 'string') return this.text(v, key === 'arguments' || key === 'partial_json');
    if (Array.isArray(v)) return v.map((x) => this.walkJson(x, key));
    if (!isObj(v)) return v;
    const out: Obj = {};
    for (const k of Object.keys(v)) out[k] = this.walkJson(v[k], k);
    return out;
  }

  /** 流式：喂进一段 SSE 文本，返回可以写给客户端的部分 */
  push(chunk: string): string {
    if (!chunk) return '';
    this.buf += chunk.includes('\r') ? chunk.replace(/\r\n/g, '\n') : chunk;
    let out = '';
    for (;;) {
      const i = this.buf.indexOf('\n\n');
      if (i < 0) break;
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      out += this.event(raw);
    }
    return out;
  }

  /** 流结束：放出扣住的事件和残留文本 */
  end(): string {
    let out = this.release();
    if (this.buf) {
      out += this.text(this.buf);
      this.buf = '';
    }
    return out;
  }

  private release(): string {
    const h = this.held;
    this.held = null;
    return h ? h.full : '';
  }

  private event(raw: string): string {
    const ev = parseEvent(raw);
    let json: unknown;
    if (ev.data !== null && ev.data.trimStart().startsWith('{')) {
      try {
        json = JSON.parse(ev.data);
      } catch {
        json = undefined;
      }
    }
    if (json === undefined) return this.release() + raw + '\n\n';
    try {
      return this.jsonEvent(ev, json);
    } catch {
      return this.release() + raw + '\n\n';
    }
  }

  private jsonEvent(ev: SseEvent, json: unknown): string {
    const type = (isObj(json) && typeof json.type === 'string' ? json.type : '') || eventName(ev);
    const ls = leaves(json, type);
    let out = '';
    let changed = false;
    // 上一个事件扣住的尾巴：同一段文本的下一个增量接着写，就挪过来
    if (this.held) {
      const h = this.held;
      const next = ls.find((l) => l.ctx === h.ctx);
      this.held = null;
      if (next) {
        out += h.cut;
        set(next, h.tail + get(next));
        changed = true;
      } else out += h.full;
    }
    for (const l of ls) {
      const s = get(l);
      const r = this.text(s, l.escaped);
      if (r !== s) {
        set(l, r);
        changed = true;
      }
    }
    // 结尾是占位符的开头：扣住，等下一个增量
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]!;
      const s = get(l);
      const tail = this.partialTail(s);
      if (!tail) continue;
      const full = serialize(ev, json);
      set(l, s.slice(0, s.length - tail.length));
      this.held = { ctx: l.ctx, tail, full, cut: serialize(ev, json) };
      return out;
    }
    return out + (changed ? serialize(ev, json) : ev.raw + '\n\n');
  }

  /** 文本结尾是某个本次占位符的开头（不完整）时返回这段尾巴 */
  private partialTail(s: string): string {
    const i = s.lastIndexOf('{');
    if (i < 0) return '';
    const start = i > 0 && s[i - 1] === '{' ? i - 1 : i;
    const tail = s.slice(start);
    if (tail.includes('}}')) return '';
    return this.prefixes.some((p) => p.length > tail.length && p.startsWith(tail)) ? tail : '';
  }
}
