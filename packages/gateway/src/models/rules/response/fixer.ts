/**
 * 响应方向的结构修复（docs/design/cli-plugin-architecture.md §6.9.7；原 unified-gateway.md §11.3），
 * 只作用在 NormEvent 上，用于转换路径（流式与非流式）：
 * - 工具名还原：Chat 上游的工具名映射（§12.7.3）在回程还原为原名；
 * - 正文里写出的工具调用 → 真正的工具调用（只在上游是 Chat、请求带了工具时）；
 * - 复读检测：判定为复读时发错误事件并结束。
 * 同协议 Chat 透传用 chatPatch.ts，规则相同。
 */
import { randomBytes } from 'node:crypto';

import type { NormEvent } from '../../../stream/events';
import { REPETITION_MESSAGE, RepetitionGuard } from '../../../stream/repetition';
import { TextToolExtractor } from '../../../stream/textTools';

/** 各项修正的开关（默认开） */
export interface ResponseFixSwitches {
  chatStream?: boolean;
  textToolCalls?: boolean;
  repetition?: boolean;
  toolNames?: boolean;
}

export interface ResponseFixOptions {
  /** 上游名 → 原名（工具名映射的回程） */
  toolNames?: ReadonlyMap<string, string> | null;
  /** 请求里提供的工具名（原名）；非空时识别正文里写出的工具调用 */
  textTools?: ReadonlySet<string> | null;
  /** 复读检测 */
  repetition?: boolean;
  /** 实际做了的修正追加到这里（去重） */
  notes?: string[];
  /** 从正文里识别出的工具调用用的 id 序列（不给时每条响应随机一个种子） */
  callIds?: CallIds;
}

export const NOTE_TEXT_TOOLS = '正文里写出的工具调用已转成工具调用';
export const NOTE_REPETITION = '检测到模型复读，已中断';
export const NOTE_TOOL_NAMES = '工具名已按映射还原';
export const NOTE_CHAT_STREAM = '已修正 Chat 流里的不规范字段';

export function addNote(notes: string[] | undefined, note: string): void {
  if (notes && !notes.includes(note)) notes.push(note);
}

/**
 * 确定性的工具调用 id（§6.9.7）：同一条响应里按出现顺序编号，前缀是这条响应的种子。
 * 同一个种子总是给出同一组 id，便于对照诊断记录与跨协议回传时还原。
 */
export class CallIds {
  private n = 0;
  constructor(readonly seed: string = randomBytes(8).toString('hex')) {}
  next(): string {
    return `call_${this.seed}_${this.n++}`;
  }
}

/** 模型写出的名字 → 请求里提供的原名 */
export function toolResolver(
  provided: ReadonlySet<string>,
  reverse?: ReadonlyMap<string, string> | null,
): (name: string) => string | null {
  return (name) => {
    const orig = reverse?.get(name) ?? name;
    return provided.has(orig) ? orig : null;
  };
}

export function fixesEnabled(o: ResponseFixOptions): boolean {
  return Boolean(o.toolNames?.size || o.textTools?.size || o.repetition);
}

export class EventFixer {
  private readonly guard: RepetitionGuard | null;
  private readonly extractor: TextToolExtractor | null;
  private readonly ids: CallIds;
  private injected = 0;
  /** finish / error 之后不再输出 */
  stopped = false;
  /** 复读检测触发 */
  tripped = false;

  constructor(private readonly o: ResponseFixOptions) {
    this.ids = o.callIds ?? new CallIds();
    this.guard = o.repetition ? new RepetitionGuard() : null;
    this.extractor = o.textTools?.size
      ? new TextToolExtractor(toolResolver(o.textTools, o.toolNames))
      : null;
  }

  push(ev: NormEvent): NormEvent[] {
    if (this.stopped) return [];
    switch (ev.type) {
      case 'think':
        if (this.guard?.push('think', ev.text)) return this.trip();
        return [ev];
      case 'text': {
        if (this.guard?.push('text', ev.text)) return this.trip();
        if (!this.extractor) return [ev];
        const t = this.extractor.push(ev.text);
        return t ? [{ type: 'text', text: t }] : [];
      }
      case 'tool_start': {
        const orig = this.o.toolNames?.get(ev.name);
        const out = this.flush();
        if (orig) addNote(this.o.notes, NOTE_TOOL_NAMES);
        out.push(orig ? { ...ev, name: orig } : ev);
        return out;
      }
      case 'finish': {
        const out = this.flush();
        const reason = this.injected && ev.reason === 'end_turn' ? 'tool_use' : ev.reason;
        out.push(reason === ev.reason ? ev : { ...ev, reason });
        this.stopped = true;
        return out;
      }
      case 'error': {
        const out = this.flush(true);
        out.push(ev);
        this.stopped = true;
        return out;
      }
      default:
        return [ev];
    }
  }

  private trip(): NormEvent[] {
    this.stopped = true;
    this.tripped = true;
    addNote(this.o.notes, NOTE_REPETITION);
    return [{ type: 'error', message: REPETITION_MESSAGE, errorType: 'api_error' }];
  }

  /** 把缓存的正文解析掉：剩余正文 + 识别出的工具调用 */
  private flush(textOnly = false): NormEvent[] {
    if (!this.extractor?.active) return [];
    if (textOnly) {
      const raw = this.extractor.raw();
      return raw ? [{ type: 'text', text: raw }] : [];
    }
    const r = this.extractor.flush();
    const out: NormEvent[] = [];
    if (r.text) out.push({ type: 'text', text: r.text });
    for (const c of r.calls) {
      const key = `text_call_${this.injected++}`;
      out.push(
        { type: 'tool_start', key, id: this.ids.next(), name: c.name },
        { type: 'tool_args', key, delta: c.args },
        { type: 'tool_end', key },
      );
    }
    if (r.calls.length) addNote(this.o.notes, NOTE_TEXT_TOOLS);
    return out;
  }
}

/** 非流式：整组事件过一遍 */
export function fixEvents(events: NormEvent[], o: ResponseFixOptions): NormEvent[] {
  const f = new EventFixer(o);
  const out: NormEvent[] = [];
  for (const e of events) out.push(...f.push(e));
  return out;
}
