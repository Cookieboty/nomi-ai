/**
 * Chat Completions 流的字段归一（§6.4）：只处理解析层面的不规范写法，不改语义。
 * - finish_reason "" → null；空的 reasoning_content / reasoning 去掉；空的 tool_calls: [] 去掉；
 * - tool_calls 缺 index：带了新 id 的是新调用（编号接在已有调用后面），带了见过的 id 的是那个调用，
 *   都没有的是当前最后一个调用的续写；同一块里的第一个调用之外按位置补；
 * - function.arguments 给成对象：序列化成 JSON 字符串；
 * - content 给成数组（Mistral 等）：正文部分拼成字符串，thinking 部分并到 reasoning_content；
 * - 已开始的工具调用里重复的 / 空的工具名去掉（有的上游每个分片都带一遍）。
 * 就地修改分片，返回是否改过；没改过的分片调用方原样输出（字节不变）。
 */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** content 数组 → 正文与思考 */
function flatten(c: unknown[]): { text: string; think: string } {
  let text = '';
  let think = '';
  for (const p of c) {
    if (!isObj(p)) continue;
    if (p.type === 'text' && typeof p.text === 'string') text += p.text;
    else if (p.type === 'thinking') {
      const t = p.thinking;
      if (typeof t === 'string') think += t;
      else if (Array.isArray(t)) think += flatten(t).text;
    }
  }
  return { text, think };
}

export class ChatChunkNormalizer {
  /** 已开始的工具调用：index → 上游给的工具名 */
  private readonly names = new Map<number, string>();
  /** 缺 index 时按 id 认调用：id → 补上的 index */
  private readonly idIndex = new Map<string, number>();
  /** 已用过的最大 index（-1 = 还没有） */
  private maxIndex = -1;

  /** 缺 index 的工具调用分片该归到哪个调用 */
  private indexFor(tc: Obj, pos: number): number {
    const id = typeof tc.id === 'string' && tc.id ? tc.id : null;
    if (id) {
      const hit = this.idIndex.get(id);
      if (hit !== undefined) return hit;
      const idx = this.maxIndex + 1;
      this.idIndex.set(id, idx);
      return idx;
    }
    // 没有 id：续写当前最后一个调用；还没有调用时按在这一块里的位置
    return this.maxIndex >= 0 ? this.maxIndex + pos : pos;
  }

  normalize(j: Obj): boolean {
    const choices = Array.isArray(j.choices) ? j.choices : [];
    let touched = false;
    for (const c of choices) {
      if (!isObj(c)) continue;
      if (c.finish_reason === '') {
        c.finish_reason = null;
        touched = true;
      }
      const delta = isObj(c.delta) ? c.delta : null;
      if (!delta) continue;
      if (Array.isArray(delta.content)) {
        const f = flatten(delta.content);
        if (f.text) delta.content = f.text;
        else delete delta.content;
        if (
          f.think &&
          typeof delta.reasoning_content !== 'string' &&
          typeof delta.reasoning !== 'string'
        )
          delta.reasoning_content = f.think;
        touched = true;
      }
      for (const k of ['reasoning_content', 'reasoning']) {
        if (delta[k] === '') {
          delete delta[k];
          touched = true;
        }
      }
      if (!Array.isArray(delta.tool_calls)) continue;
      if (!delta.tool_calls.length) {
        delete delta.tool_calls;
        touched = true;
        continue;
      }
      delta.tool_calls.forEach((tc: unknown, pos: number) => {
        if (!isObj(tc)) return;
        if (typeof tc.index !== 'number') {
          tc.index = this.indexFor(tc, pos);
          touched = true;
        }
        this.maxIndex = Math.max(this.maxIndex, tc.index as number);
        if (typeof tc.id === 'string' && tc.id && !this.idIndex.has(tc.id))
          this.idIndex.set(tc.id, tc.index as number);
        if (!isObj(tc.function)) return;
        const fn = tc.function;
        if (
          fn.arguments !== undefined &&
          fn.arguments !== null &&
          typeof fn.arguments === 'object'
        ) {
          fn.arguments = JSON.stringify(fn.arguments);
          touched = true;
        }
        const idx = tc.index as number;
        const seen = this.names.get(idx);
        if (seen !== undefined) {
          if (typeof fn.name === 'string' && (fn.name === '' || fn.name === seen)) {
            delete fn.name;
            touched = true;
          }
          return;
        }
        if (typeof fn.name === 'string' && fn.name) this.names.set(idx, fn.name);
      });
    }
    return touched;
  }
}
