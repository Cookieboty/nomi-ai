/**
 * 同协议 Chat 透传时的事件级修正（docs/design/unified-gateway.md §9.2、§11.3）。
 * 按 SSE 事件逐个处理：没有触发任何修正的事件原样输出（字节不变），触发了才重新序列化。
 * - Chat 字段归一（规范化层 canonical/chat.ts）：空 reasoning、finish_reason ""、空 tool_calls、
 *   缺 index、对象形式的 arguments、数组形式的 content、重复的工具名；
 * - 工具名还原（§12.7.3）；
 * - 正文里写出的工具调用：从标记起扣住正文，在 finish_reason 那一块之前补发正文剩余与 tool_calls；
 * - 复读检测：发 `data: {"error":…}` 与 [DONE] 后停止。
 */
import { ChatChunkNormalizer } from '../canonical/chat';

import {
  CallIds,
  addNote,
  NOTE_CHAT_STREAM,
  NOTE_REPETITION,
  NOTE_TEXT_TOOLS,
  NOTE_TOOL_NAMES,
  toolResolver,
  type ResponseFixOptions,
} from './fixer';
import { REPETITION_MESSAGE, RepetitionGuard } from './repetition';
import { TextToolExtractor } from './textTools';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ChatPatchOptions extends ResponseFixOptions {
  /** Chat 流修正（默认开） */
  chatStream?: boolean;
}

export class ChatStreamPatcher {
  private buf = '';
  private readonly guard: RepetitionGuard | null;
  private readonly extractor: TextToolExtractor | null;
  /** 已开始的工具调用：index → 工具名 */
  private readonly tools = new Map<number, string>();
  /** 合成分片用的 id / model / created */
  private template: Obj = {};
  /** 字段归一（规范化层，§6.4） */
  private readonly norm = new ChatChunkNormalizer();
  /** 正文里识别出的工具调用的 id */
  private readonly ids: CallIds;
  stopped = false;

  constructor(private readonly o: ChatPatchOptions = {}) {
    this.ids = o.callIds ?? new CallIds();
    this.guard = o.repetition ? new RepetitionGuard() : null;
    this.extractor = o.textTools?.size
      ? new TextToolExtractor(toolResolver(o.textTools, o.toolNames))
      : null;
  }

  push(text: string): string {
    if (this.stopped) return '';
    this.buf += text;
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index + m[0].length);
      this.buf = this.buf.slice(m.index + m[0].length);
      out += this.block(block, m[0]);
      if (this.stopped) {
        this.buf = '';
        break;
      }
    }
    return out;
  }

  end(): string {
    if (this.stopped) return '';
    const rest = this.buf;
    this.buf = '';
    let out = rest.trim() ? this.block(rest, '') : rest;
    // 上游没发 finish_reason 也没发 [DONE]：补发缓存
    if (!this.stopped) out += this.flushChunks().text;
    return out;
  }

  private data(payload: unknown, sep = '\n\n'): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}${sep}`;
  }

  private block(raw: string, sep: string): string {
    const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (lines.length !== 1) return raw;
    const data = lines[0]!.slice(5).trim();
    if (data === '[DONE]') return this.flushChunks().text + raw;
    let j: unknown;
    try {
      j = JSON.parse(data);
    } catch {
      return raw;
    }
    if (!isObj(j) || j.error) return raw;
    const out = this.patch(j);
    if (this.stopped) return out.text;
    if (out.drop) return out.prefix;
    return out.prefix + (out.changed ? this.data(j, sep || '\n\n') : raw);
  }

  private patch(j: Obj): { changed: boolean; drop: boolean; prefix: string; text: string } {
    const res = { changed: false, drop: false, prefix: '', text: '' };
    for (const k of ['id', 'object', 'created', 'model'])
      if (j[k] !== undefined) this.template[k] = j[k];
    const choices = Array.isArray(j.choices) ? j.choices : [];
    const c = choices[0];
    if (!isObj(c)) return res;
    const fixStream = this.o.chatStream !== false;
    const touched = fixStream && this.norm.normalize(j);
    const delta = isObj(c.delta) ? c.delta : null;
    if (delta) {
      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      if (reasoning && this.guard?.push('think', reasoning)) return this.trip();
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!isObj(tc) || !isObj(tc.function)) continue;
          const fn = tc.function;
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (this.tools.has(idx)) continue;
          const name = typeof fn.name === 'string' ? fn.name : '';
          if (!name) continue;
          const orig = this.o.toolNames?.get(name);
          if (orig) {
            fn.name = orig;
            res.changed = true;
            addNote(this.o.notes, NOTE_TOOL_NAMES);
          }
          this.tools.set(idx, name);
          // 模型已经在用真正的 tool_calls：缓存的正文原样补发（不再转换，避免和上游的 index 冲突）
          const raw = this.extractor?.active ? this.extractor.raw() : '';
          if (raw) res.prefix += this.chunk({ content: raw });
        }
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (this.guard?.push('text', delta.content)) return this.trip();
        if (this.extractor) {
          const t = this.extractor.push(delta.content);
          if (t !== delta.content) {
            res.changed = true;
            if (t) delta.content = t;
            else delete delta.content;
          }
        }
      }
    }
    if (c.finish_reason !== null && c.finish_reason !== undefined) {
      const f = this.flushChunks();
      res.prefix += f.text;
      if (f.calls && c.finish_reason === 'stop') {
        c.finish_reason = 'tool_calls';
        res.changed = true;
      }
    }
    if (touched) {
      res.changed = true;
      addNote(this.o.notes, NOTE_CHAT_STREAM);
    }
    // 修正后什么都不剩的分片（只有空 delta）整个去掉
    if (
      res.changed &&
      delta &&
      !Object.keys(delta).length &&
      (c.finish_reason === null || c.finish_reason === undefined) &&
      j.usage === undefined &&
      choices.length === 1
    )
      res.drop = true;
    return res;
  }

  private trip() {
    this.stopped = true;
    addNote(this.o.notes, NOTE_REPETITION);
    const text =
      this.data({ error: { message: REPETITION_MESSAGE, type: 'api_error' } }) +
      this.data('[DONE]');
    return { changed: false, drop: true, prefix: '', text };
  }

  private chunk(delta: Obj): string {
    return this.data({ ...this.template, choices: [{ index: 0, delta, finish_reason: null }] });
  }

  /** 缓存的正文 → 正文分片 + tool_calls 分片 */
  private flushChunks(): { text: string; calls: number } {
    if (!this.extractor?.active) return { text: '', calls: 0 };
    const r = this.extractor.flush();
    const chunk = (delta: Obj) => this.chunk(delta);
    let text = r.text ? chunk({ content: r.text }) : '';
    if (r.calls.length) {
      let index = this.tools.size ? Math.max(...this.tools.keys()) + 1 : 0;
      for (const call of r.calls) {
        this.tools.set(index, call.name);
        text += chunk({
          tool_calls: [
            {
              index,
              id: this.ids.next(),
              type: 'function',
              function: { name: call.name, arguments: call.args },
            },
          ],
        });
        index++;
      }
      addNote(this.o.notes, NOTE_TEXT_TOOLS);
    }
    return { text, calls: r.calls.length };
  }
}

/**
 * 非流式 Chat 响应（同协议）：工具名还原、正文里的工具调用。返回新对象；没有改动时返回原对象。
 */
export function patchChatJson(body: unknown, o: ResponseFixOptions): unknown {
  if (!isObj(body) || !Array.isArray(body.choices)) return body;
  const ids = o.callIds ?? new CallIds();
  let changed = false;
  const choices = body.choices.map((c) => {
    if (!isObj(c) || !isObj(c.message)) return c;
    let msg: Obj = c.message;
    let finish = c.finish_reason;
    if (Array.isArray(msg.tool_calls) && o.toolNames?.size) {
      const calls = msg.tool_calls.map((tc) => {
        if (!isObj(tc) || !isObj(tc.function) || typeof tc.function.name !== 'string') return tc;
        const orig = o.toolNames!.get(tc.function.name);
        return orig ? { ...tc, function: { ...tc.function, name: orig } } : tc;
      });
      if (calls.some((x, i) => x !== (msg.tool_calls as unknown[])[i])) {
        msg = { ...msg, tool_calls: calls };
        addNote(o.notes, NOTE_TOOL_NAMES);
      }
    }
    if (o.textTools?.size && typeof msg.content === 'string' && msg.content) {
      const ex = new TextToolExtractor(toolResolver(o.textTools, o.toolNames));
      const head = ex.push(msg.content);
      const r = ex.flush();
      if (r.calls.length) {
        const prev = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        msg = {
          ...msg,
          content: (head + r.text).replace(/\s+$/, '') || null,
          tool_calls: [
            ...prev,
            ...r.calls.map((call) => ({
              id: ids.next(),
              type: 'function',
              function: { name: call.name, arguments: call.args },
            })),
          ],
        };
        if (finish === 'stop' || !finish) finish = 'tool_calls';
        addNote(o.notes, NOTE_TEXT_TOOLS);
      }
    }
    if (msg === c.message) return c;
    changed = true;
    return { ...c, message: msg, finish_reason: finish };
  });
  return changed ? { ...body, choices } : body;
}
