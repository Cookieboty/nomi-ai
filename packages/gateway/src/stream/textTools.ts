/**
 * 正文里写出的工具调用（docs/design/unified-gateway.md §11.3）。
 * 请求带了工具、上游是 Chat 时，部分模型（Qwen / Hermes 系、DeepSeek、GLM）偶尔不走 tool_calls，
 * 而是把调用用自家模板写进正文。认得三种：
 * - `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`
 * - GLM：`<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>…</tool_call>`（也认不带外层标签的）
 * - DeepSeek：`<｜DSML｜invoke name="..."><｜DSML｜parameter name="k" string="true">v</｜DSML｜parameter>…`
 *
 * 从第一个标记起缓存正文（标记可能跨分片，结尾疑似标记前缀的几个字符先扣住）；
 * 结束时能解析成「已提供的工具名 + 合法 JSON 参数」的块转成工具调用，其余原样按正文输出。
 */

const DSML = '<｜DSML｜';
const DSML_CLOSE = '</｜DSML｜';
const MARKERS = ['<tool_call>', DSML, '<arg_key>'];

export interface TextToolCall {
  name: string;
  /** JSON 对象字符串 */
  args: string;
}

export interface TextToolResult {
  text: string;
  calls: TextToolCall[];
}

type Resolve = (name: string) => string | null;

function parseValue(raw: string, forceString: boolean): unknown {
  if (forceString) return raw;
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    return raw;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** `<tool_call>` 里的内容：JSON 或 GLM 的 arg_key / arg_value */
function parseToolCallBody(body: string, resolve: Resolve): TextToolCall | null {
  const t = body.trim();
  if (t.startsWith('{')) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      return null;
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const o = j as Record<string, unknown>;
    const fn =
      o.function && typeof o.function === 'object' ? (o.function as Record<string, unknown>) : o;
    const name = resolve(typeof fn.name === 'string' ? fn.name : '');
    if (!name) return null;
    let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { name, args: JSON.stringify(args) };
  }
  const i = t.indexOf('<arg_key>');
  return glmCall(i < 0 ? t : t.slice(0, i), i < 0 ? '' : t.slice(i), resolve);
}

/** GLM：名字 + 若干 <arg_key>k</arg_key><arg_value>v</arg_value>，中间只允许空白 */
function glmCall(rawName: string, pairs: string, resolve: Resolve): TextToolCall | null {
  const name = resolve(rawName.trim());
  if (!name) return null;
  const args: Record<string, unknown> = {};
  const re = /\s*<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/y;
  let pos = 0;
  while (pos < pairs.length) {
    re.lastIndex = pos;
    const m = re.exec(pairs);
    if (!m) break;
    args[m[1]!.trim()] = parseValue(m[2]!, false);
    pos = re.lastIndex;
  }
  if (pairs.slice(pos).trim()) return null;
  return { name, args: JSON.stringify(args) };
}

/** DeepSeek DSML 的一个 invoke */
function dsmlCall(name: string, body: string, resolve: Resolve): TextToolCall | null {
  const n = resolve(decodeEntities(name));
  if (!n) return null;
  const args: Record<string, unknown> = {};
  const re =
    /\s*<｜DSML｜parameter\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/｜DSML｜parameter>/y;
  let pos = 0;
  while (pos < body.length) {
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) break;
    args[decodeEntities(m[1]!)] = parseValue(m[3]!, m[2] === 'true');
    pos = re.lastIndex;
  }
  if (body.slice(pos).trim()) return null;
  return { name: n, args: JSON.stringify(args) };
}

interface Block {
  start: number;
  end: number;
  call: TextToolCall | null;
}

/** 在缓存的正文里找出所有块；解析不了的块 call 为 null（按正文输出） */
function findBlocks(s: string, resolve: Resolve, leadName?: string): Block[] {
  const out: Block[] = [];
  let pos = 0;
  for (;;) {
    const hits = [...MARKERS, DSML_CLOSE].map((m) => s.indexOf(m, pos)).filter((i) => i >= 0);
    if (!hits.length) break;
    const at = Math.min(...hits);
    if (s.startsWith('<tool_call>', at)) {
      const close = s.indexOf('</tool_call>', at);
      const bodyEnd = close < 0 ? s.length : close;
      const end = close < 0 ? s.length : close + '</tool_call>'.length;
      out.push({ start: at, end, call: parseToolCallBody(s.slice(at + 11, bodyEnd), resolve) });
      pos = end;
    } else if (s.startsWith(`${DSML}invoke`, at)) {
      const m = /^<｜DSML｜invoke\s+name="([^"]*)"\s*>/.exec(s.slice(at));
      const close = s.indexOf('</｜DSML｜invoke>', at);
      if (!m || close < 0) {
        out.push({ start: at, end: s.length, call: null });
        break;
      }
      const end = close + '</｜DSML｜invoke>'.length;
      out.push({
        start: at,
        end,
        call: dsmlCall(m[1]!, s.slice(at + m[0].length, close), resolve),
      });
      pos = end;
    } else if (s.startsWith(DSML, at) || s.startsWith(DSML_CLOSE, at)) {
      // 外层 <｜DSML｜function_calls> / </｜DSML｜function_calls>：所有 invoke 都成功时一并去掉
      const m = /^<\/?｜DSML｜function_calls>/.exec(s.slice(at));
      const end = m ? at + m[0].length : at + (s.startsWith(DSML, at) ? DSML : DSML_CLOSE).length;
      out.push({ start: at, end, call: m ? { name: '', args: '' } : null });
      pos = end;
    } else {
      // 不带 <tool_call> 的 GLM：名字是标记前的最后一个词（只认缓存里有的部分）
      const close = s.lastIndexOf('</arg_value>');
      const end = close < at ? s.length : close + '</arg_value>'.length;
      const before = /([A-Za-z0-9_.:-]+)\s*$/.exec(s.slice(pos, at));
      const start = before ? pos + before.index : at;
      // 名字已经在缓存之前输出了：用记下来的名字
      const name = before?.[1] ?? (at === 0 ? leadName : undefined);
      out.push({ start, end, call: name ? glmCall(name, s.slice(at, end), resolve) : null });
      pos = end;
    }
  }
  return out;
}

export class TextToolExtractor {
  /** 已进入缓存（遇到过标记） */
  private buffering = false;
  private buf = '';
  /** 未缓存时扣住的疑似标记前缀 */
  private hold = '';
  /** 已输出正文的末尾（找不带外层标签的 GLM 调用名） */
  private tail = '';
  private leadName: string | undefined;
  private readonly maxMarker = Math.max(...MARKERS.map((m) => m.length));

  /** @param resolve 模型写出的名字 → 已提供的工具名；认不出返回 null */
  constructor(private readonly resolve: Resolve) {}

  get active(): boolean {
    return this.buffering || this.hold.length > 0;
  }

  /** 推入一段正文，返回现在可以输出的部分 */
  push(text: string): string {
    if (this.buffering) {
      this.buf += text;
      return '';
    }
    const s = this.hold + text;
    this.hold = '';
    const hits = MARKERS.map((m) => s.indexOf(m)).filter((i) => i >= 0);
    if (hits.length) {
      let at = Math.min(...hits);
      if (s.startsWith('<arg_key>', at)) {
        const pre = this.tail + s.slice(0, at);
        const m = /([A-Za-z0-9_.:-]+)\s*$/.exec(pre);
        if (m && m.index >= this.tail.length) at = m.index - this.tail.length;
        else if (m) this.leadName = m[1];
      }
      this.buffering = true;
      this.buf = s.slice(at);
      return this.emit(s.slice(0, at));
    }
    // 结尾可能是被切开的标记：扣住
    const from = Math.max(0, s.length - this.maxMarker + 1);
    for (let i = s.indexOf('<', from); i >= 0; i = s.indexOf('<', i + 1)) {
      const tail = s.slice(i);
      if (MARKERS.some((m) => m.startsWith(tail))) {
        this.hold = tail;
        return this.emit(s.slice(0, i));
      }
    }
    return this.emit(s);
  }

  private emit(s: string): string {
    this.tail = (this.tail + s).slice(-128);
    return s;
  }

  /** 放弃解析：原样取回缓存的正文 */
  raw(): string {
    const s = this.buffering ? this.buf : this.hold;
    this.buffering = false;
    this.buf = '';
    this.hold = '';
    this.leadName = undefined;
    return s;
  }

  /** 结束：解析缓存，返回剩余正文与识别出的调用 */
  flush(): TextToolResult {
    const s = this.buffering ? this.buf : this.hold;
    const wasBuffering = this.buffering;
    this.buffering = false;
    this.buf = '';
    this.hold = '';
    if (!wasBuffering) return { text: s, calls: [] };
    const blocks = findBlocks(s, this.resolve, this.leadName);
    this.leadName = undefined;
    const invokesOk = blocks.every((b) => b.call !== null);
    const calls: TextToolCall[] = [];
    let text = '';
    let pos = 0;
    for (const b of blocks) {
      text += s.slice(pos, b.start);
      const wrapper = b.call !== null && b.call.name === '';
      if (b.call && !wrapper) calls.push(b.call);
      else if (!(wrapper && invokesOk)) text += s.slice(b.start, b.end);
      pos = b.end;
    }
    text += s.slice(pos);
    if (calls.length) text = text.replace(/\s+$/, '');
    return { text, calls };
  }
}
