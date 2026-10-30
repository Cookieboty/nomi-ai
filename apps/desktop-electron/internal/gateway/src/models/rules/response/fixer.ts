/**
 * 响应方向的结构修复在 NormEvent 上的适配（docs/design/cli-plugin-architecture.md §6.9.7；
 * 原 unified-gateway.md §11.3），用于转换路径（流式与非流式）。规则本身在 rules.ts，
 * 同协议 Chat 透传（chatPatch.ts）调用的是同一份实现。
 */
import type { NormEvent } from '../../../stream/events';

import { REPETITION_MESSAGE } from './repetition';
import { ResponseRules, type ResponseFixOptions } from './rules';

export { CallIds } from './callIds';
export {
  addNote,
  fixesEnabled,
  NOTE_CHAT_STREAM,
  NOTE_REPETITION,
  NOTE_TEXT_TOOLS,
  NOTE_TOOL_NAMES,
  toolResolver,
  type ResponseFixOptions,
} from './rules';

/** 各项修正的开关（默认开） */
export interface ResponseFixSwitches {
  chatStream?: boolean;
  textToolCalls?: boolean;
  repetition?: boolean;
  toolNames?: boolean;
}

export class EventFixer {
  private readonly rules: ResponseRules;
  private injected = 0;
  /** finish / error 之后不再输出 */
  stopped = false;

  constructor(o: ResponseFixOptions) {
    this.rules = new ResponseRules(o);
  }

  /** 复读检测触发 */
  get tripped(): boolean {
    return this.rules.tripped;
  }

  push(ev: NormEvent): NormEvent[] {
    if (this.stopped) return [];
    switch (ev.type) {
      case 'think':
        return this.rules.reasoning(ev.text) ? this.trip() : [ev];
      case 'text': {
        const t = this.rules.text(ev.text);
        if (t === null) return this.trip();
        return t ? [t === ev.text ? ev : { type: 'text', text: t }] : [];
      }
      case 'tool_start': {
        const out = this.flush();
        const orig = this.rules.toolName(ev.name);
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
        const raw = this.rules.releaseRaw();
        const out: NormEvent[] = raw ? [{ type: 'text', text: raw }] : [];
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
    return [{ type: 'error', message: REPETITION_MESSAGE, errorType: 'api_error' }];
  }

  /** 把扣住的正文解析掉：剩余正文 + 识别出的工具调用 */
  private flush(): NormEvent[] {
    const r = this.rules.flush();
    const out: NormEvent[] = [];
    if (r.text) out.push({ type: 'text', text: r.text });
    for (const c of r.calls) {
      const key = `text_call_${this.injected++}`;
      out.push(
        { type: 'tool_start', key, id: c.id, name: c.name },
        { type: 'tool_args', key, delta: c.args },
        { type: 'tool_end', key },
      );
    }
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
