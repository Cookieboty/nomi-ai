/**
 * 响应方向结构修复的唯一实现（§6.5、§6.9.7）：工具名还原、正文里写出的工具调用、复读检测、
 * 确定性的工具调用 id。转换路径（EventFixer，作用在 NormEvent 上）与同协议 Chat 透传
 * （ChatStreamPatcher，作用在 Chat 分片上）都只调用这里，规则与备注不会分叉。
 */
import { CallIds } from './callIds';
import { RepetitionGuard } from './repetition';
import { TextToolExtractor } from './textTools';

export interface ResponseFixOptions {
  /** 上游名 → 原名（工具名映射的回程） */
  toolNames?: ReadonlyMap<string, string> | null;
  /** 请求里提供的工具名（原名）；非空时识别正文里写出的工具调用 */
  textTools?: ReadonlySet<string> | null;
  /** 复读检测 */
  repetition?: boolean;
  /** 实际做了的修正追加到这里（去重） */
  notes?: string[];
  /** 工具调用 id 序列（不给时每条响应随机一个种子；服务端按对话历史给确定的种子） */
  callIds?: CallIds;
}

export const NOTE_TEXT_TOOLS = '正文里写出的工具调用已转成工具调用';
export const NOTE_REPETITION = '检测到模型复读，已中断';
export const NOTE_TOOL_NAMES = '工具名已按映射还原';
export const NOTE_CHAT_STREAM = '已修正 Chat 流里的不规范字段';

export function addNote(notes: string[] | undefined, note: string): void {
  if (notes && !notes.includes(note)) notes.push(note);
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

/** 识别出的一个工具调用 */
export interface FoundCall {
  id: string;
  name: string;
  args: string;
}

/** 工具名还原：映射过的名字还原成原名并记备注；没映射过返回 null */
export function restoreToolName(name: string, o: ResponseFixOptions): string | null {
  const orig = o.toolNames?.get(name);
  if (!orig) return null;
  addNote(o.notes, NOTE_TOOL_NAMES);
  return orig;
}

/**
 * 一条响应的规则状态。调用方负责把各自格式的数据喂进来、把结果写回各自的格式。
 */
export class ResponseRules {
  private readonly guard: RepetitionGuard | null;
  private readonly extractor: TextToolExtractor | null;
  readonly ids: CallIds;
  /** 复读检测触发 */
  tripped = false;

  constructor(private readonly o: ResponseFixOptions) {
    this.ids = o.callIds ?? new CallIds();
    this.guard = o.repetition ? new RepetitionGuard() : null;
    this.extractor = o.textTools?.size
      ? new TextToolExtractor(toolResolver(o.textTools, o.toolNames))
      : null;
  }

  /** 推理片段；返回 true = 判定为复读，调用方发错误并结束 */
  reasoning(text: string): boolean {
    return Boolean(text) && this.check('think', text);
  }

  /**
   * 正文片段 → 现在可以输出的正文（可能被扣住一部分，等工具调用标记结束）。
   * 判定为复读时返回 null。
   */
  text(text: string): string | null {
    if (this.check('text', text)) return null;
    return this.extractor ? this.extractor.push(text) : text;
  }

  /** 正在扣住正文（识别到工具调用标记的开头） */
  get holding(): boolean {
    return this.extractor?.active === true;
  }

  /** 模型开始了真正的工具调用：扣住的正文原样放出（不再当成工具调用解析） */
  releaseRaw(): string {
    return this.extractor?.active ? this.extractor.raw() : '';
  }

  /** 结束（或出错）前：把扣住的正文解析掉，给出剩余正文与识别出的工具调用 */
  flush(): { text: string; calls: FoundCall[] } {
    if (!this.extractor?.active) return { text: '', calls: [] };
    const r = this.extractor.flush();
    const calls = r.calls.map((c) => ({ id: this.ids.next(), name: c.name, args: c.args }));
    if (calls.length) addNote(this.o.notes, NOTE_TEXT_TOOLS);
    return { text: r.text, calls };
  }

  /** 工具名还原 */
  toolName(name: string): string | null {
    return restoreToolName(name, this.o);
  }

  private check(kind: 'think' | 'text', text: string): boolean {
    if (!this.guard?.push(kind, text)) return false;
    this.tripped = true;
    addNote(this.o.notes, NOTE_REPETITION);
    return true;
  }
}

/**
 * 非流式整段正文：识别里面写出的工具调用。没识别出时返回 null。
 */
export function extractTextCalls(
  content: string,
  o: ResponseFixOptions,
): { text: string; calls: FoundCall[] } | null {
  if (!o.textTools?.size || !content) return null;
  const rules = new ResponseRules({ ...o, repetition: false });
  const head = rules.text(content) ?? '';
  const r = rules.flush();
  if (!r.calls.length) return null;
  return { text: head + r.text, calls: r.calls };
}
