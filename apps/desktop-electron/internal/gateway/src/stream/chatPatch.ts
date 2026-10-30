/**
 * 同协议 Chat 透传时的事件级修正（docs/design/unified-gateway.md §9.2、§11.3）。
 * 按 SSE 事件逐个处理：没有触发任何修正的事件原样输出（字节不变），触发了才重新序列化。
 * - Chat 字段归一（规范化层 canonical/chat.ts）：空 reasoning、finish_reason ""、空 tool_calls、
 *   缺 index、对象形式的 arguments、数组形式的 content、重复的工具名；
 * - 结构修复（工具名还原、正文里写出的工具调用、复读检测）只调用 models/rules/response 的同一份规则，
 *   这里只负责把 Chat 分片喂进去、把结果写回 Chat 分片：正文里的工具调用从标记起扣住正文，
 *   在 finish_reason 那一块之前补发正文剩余与 tool_calls；复读时发 `data: {"error":…}` 与 [DONE] 后停止；
 * - 没有工具名的调用：名字到之前扣住参数，到了补进带名字的那一片；整轮都没等到名字就丢掉
 *   （原样转下去客户端 SDK 会整轮报错，如 AI SDK 的 Expected 'function.name' to be a string.）。
 */
import { ChatChunkNormalizer } from '../canonical/chat';
import { REPETITION_MESSAGE } from '../models/rules/response/repetition';
import {
  addNote,
  extractTextCalls,
  NOTE_CHAT_STREAM,
  ResponseRules,
  restoreToolName,
  type ResponseFixOptions,
} from '../models/rules/response/rules';

import { SseSplitter } from './sse';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** 带非空工具名的调用 */
const hasToolName = (tc: unknown): boolean =>
  isObj(tc) && isObj(tc.function) && typeof tc.function.name === 'string' && !!tc.function.name;

/** 还没等到工具名的调用：index → 已收到的 id 与参数 */
interface HeldCall {
  id?: string;
  args: string;
}

export interface ChatPatchOptions extends ResponseFixOptions {
  /** Chat 流修正（默认开） */
  chatStream?: boolean;
}

export class ChatStreamPatcher {
  private readonly split = new SseSplitter();
  private readonly rules: ResponseRules;
  /** 已开始的工具调用：index → 工具名 */
  private readonly tools = new Map<number, string>();
  /** 还没等到工具名的调用 */
  private readonly held = new Map<number, HeldCall>();
  /** 丢过没有工具名的调用 */
  private droppedNameless = false;
  /** 合成分片用的 id / model / created */
  private template: Obj = {};
  /** 字段归一（规范化层，§6.4） */
  private readonly norm = new ChatChunkNormalizer();
  stopped = false;

  constructor(private readonly o: ChatPatchOptions = {}) {
    this.rules = new ResponseRules(o);
  }

  push(text: string): string {
    if (this.stopped) return '';
    let out = '';
    for (const b of this.split.push(text)) {
      out += this.block(b.body + b.sep, b.sep);
      if (this.stopped) {
        this.split.take();
        break;
      }
    }
    return out;
  }

  end(): string {
    if (this.stopped) return '';
    const rest = this.split.take();
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
    if (data === '[DONE]') {
      this.dropHeld();
      return this.flushChunks().text + raw;
    }
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
      if (reasoning && this.rules.reasoning(reasoning)) return this.trip();
      if (Array.isArray(delta.tool_calls)) {
        const kept: unknown[] = [];
        for (const tc of delta.tool_calls) {
          kept.push(tc);
          if (!isObj(tc) || !isObj(tc.function)) continue;
          const fn = tc.function;
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (this.tools.has(idx)) continue;
          const name = typeof fn.name === 'string' ? fn.name : '';
          if (!name) {
            kept.pop();
            const h = this.held.get(idx) ?? { args: '' };
            if (!h.id && typeof tc.id === 'string' && tc.id) h.id = tc.id;
            if (typeof fn.arguments === 'string') h.args += fn.arguments;
            this.held.set(idx, h);
            res.changed = true;
            continue;
          }
          const h = this.held.get(idx);
          if (h) {
            this.held.delete(idx);
            if (h.id && !(typeof tc.id === 'string' && tc.id)) tc.id = h.id;
            if (tc.type === undefined) tc.type = 'function';
            fn.arguments = h.args + (typeof fn.arguments === 'string' ? fn.arguments : '');
            res.changed = true;
          }
          const orig = this.rules.toolName(name);
          if (orig) {
            fn.name = orig;
            res.changed = true;
          }
          this.tools.set(idx, name);
          // 模型已经在用真正的 tool_calls：扣住的正文原样补发（不再转换，避免和上游的 index 冲突）
          const raw = this.rules.releaseRaw();
          if (raw) res.prefix += this.chunk({ content: raw });
        }
        if (kept.length !== delta.tool_calls.length) {
          if (kept.length) delta.tool_calls = kept;
          else delete delta.tool_calls;
        }
      }
      if (typeof delta.content === 'string' && delta.content) {
        const t = this.rules.text(delta.content);
        if (t === null) return this.trip();
        if (t !== delta.content) {
          res.changed = true;
          if (t) delta.content = t;
          else delete delta.content;
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
      if (this.dropHeld() && !this.tools.size && c.finish_reason === 'tool_calls') {
        c.finish_reason = 'stop';
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

  /** 整轮结束还没等到工具名的调用丢掉；返回这一轮是否丢过 */
  private dropHeld(): boolean {
    if (this.held.size) this.droppedNameless = true;
    this.held.clear();
    return this.droppedNameless;
  }

  private trip() {
    this.stopped = true;
    const text =
      this.data({ error: { message: REPETITION_MESSAGE, type: 'api_error' } }) +
      this.data('[DONE]');
    return { changed: false, drop: true, prefix: '', text };
  }

  private chunk(delta: Obj): string {
    return this.data({ ...this.template, choices: [{ index: 0, delta, finish_reason: null }] });
  }

  /** 扣住的正文 → 正文分片 + tool_calls 分片 */
  private flushChunks(): { text: string; calls: number } {
    if (!this.rules.holding) return { text: '', calls: 0 };
    const r = this.rules.flush();
    let text = r.text ? this.chunk({ content: r.text }) : '';
    let index = this.tools.size ? Math.max(...this.tools.keys()) + 1 : 0;
    for (const call of r.calls) {
      this.tools.set(index, call.name);
      text += this.chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.args },
          },
        ],
      });
      index++;
    }
    return { text, calls: r.calls.length };
  }
}

/**
 * 非流式 Chat 响应（同协议）：丢掉没有工具名的调用、工具名还原、正文里的工具调用。返回新对象；没有改动时返回原对象。
 */
export function patchChatJson(body: unknown, o: ResponseFixOptions): unknown {
  if (!isObj(body) || !Array.isArray(body.choices)) return body;
  let changed = false;
  const choices = body.choices.map((c) => {
    if (!isObj(c) || !isObj(c.message)) return c;
    let msg: Obj = c.message;
    let finish = c.finish_reason;
    if (Array.isArray(msg.tool_calls) && !msg.tool_calls.every(hasToolName)) {
      const named = msg.tool_calls.filter(hasToolName);
      const { tool_calls: _dropped, ...rest } = msg;
      msg = named.length ? { ...msg, tool_calls: named } : rest;
      if (!named.length && finish === 'tool_calls') finish = 'stop';
    }
    if (Array.isArray(msg.tool_calls) && o.toolNames?.size) {
      const calls = msg.tool_calls.map((tc) => {
        if (!isObj(tc) || !isObj(tc.function) || typeof tc.function.name !== 'string') return tc;
        const orig = restoreToolName(tc.function.name, o);
        return orig ? { ...tc, function: { ...tc.function, name: orig } } : tc;
      });
      if (calls.some((x, i) => x !== (msg.tool_calls as unknown[])[i]))
        msg = { ...msg, tool_calls: calls };
    }
    const found = typeof msg.content === 'string' ? extractTextCalls(msg.content, o) : null;
    if (found) {
      const prev = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      msg = {
        ...msg,
        content: found.text.replace(/\s+$/, '') || null,
        tool_calls: [
          ...prev,
          ...found.calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.args },
          })),
        ],
      };
      if (finish === 'stop' || !finish) finish = 'tool_calls';
    }
    if (msg === c.message) return c;
    changed = true;
    return { ...c, message: msg, finish_reason: finish };
  });
  return changed ? { ...body, choices } : body;
}
