/**
 * 各 CLI 会话文件解析成「可见对话」的共用部分（尽力而为，只取用户 / 助手文本、工具与用量）。
 * 纯函数、不碰文件系统；从主进程 cli/historyTranscript.ts 搬来（§5.7）。
 */
import {
  buildTrace,
  stripCarriedContext,
  type HarnessTabMessage,
  type HarnessTraceEvent,
  type HarnessUsage,
  type HistoryFileRef,
  type HistoryParse,
} from '@nomi-ai/cli-sdk';

import { inputText, outputText } from './stream';
import { cleanTitle } from './text';

export const HISTORY_MAX_MESSAGES = 300;
export const MAX_TEXT = 20_000;

export type Json = Record<string, unknown>;

export function lines(text: string): Json[] {
  const out: Json[] = [];
  for (const l of text.replace(/^\uFEFF/, '').split('\n')) {
    const s = l.trim();
    if (!s.startsWith('{')) continue;
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === 'object') out.push(v as Json);
    } catch {
      /* 被截断的首行 / 正在写入的半行 */
    }
  }
  return out;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export const when = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

/** 取内容块里的文本；返回 text 与工具名 */
export function blocks(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] };
  const text: string[] = [];
  const tools: string[] = [];
  // ACP（Grok）的 content 是单个块：{ type: 'text', text }
  const list = Array.isArray(content)
    ? content
    : content && typeof content === 'object'
      ? [content]
      : null;
  if (list) {
    for (const c of list) {
      const o = (c ?? {}) as Json;
      const type = String(o.type ?? '');
      if ((type === 'text' || type === 'input_text' || type === 'output_text') && str(o.text))
        text.push(String(o.text));
      else if (type === 'tool_use' || type === 'tool-call' || type === 'tool_call') {
        const n = str(o.name) ?? str(o.tool);
        if (n) tools.push(n);
      }
    }
  }
  return { text: text.join('\n\n'), tools };
}

/** 注入类内容（环境 / 指令 / 命令包装）不当作对话 */
export function injected(text: string): boolean {
  return (
    /^\s*<(environment_context|user_instructions|INSTRUCTIONS|skills_instructions|system-reminder|local-command-caveat|local-command-stdout)/i.test(
      text,
    ) ||
    /^\s*#\s*AGENTS\.md/i.test(text) ||
    /^\s*\[Request interrupted by user/i.test(text) ||
    /^\s*\[Your previous response had no visible output/i.test(text)
  );
}

export interface ToolStart {
  id: string;
  name: string;
  input?: unknown;
  at: number;
  parentId?: string;
}
export interface ToolEnd {
  id: string;
  output?: unknown;
  error?: boolean;
  at: number;
}

export class Builder {
  readonly out: HarnessTabMessage[] = [];
  private n = 0;
  /** 工具调用 id → 名称（结果事件里补回名称） */
  private readonly names = new Map<string, string>();
  /** 当前这一轮的开始时间（最近一条用户消息）：用来算整轮耗时 */
  private turnStart = 0;

  user(text: string, at: number): void {
    const content = stripCarriedContext(text).trim();
    if (!content || injected(content)) return;
    this.turnStart = at;
    this.out.push({
      id: `hist-${this.n++}`,
      role: 'user',
      content: content.slice(0, MAX_TEXT),
      timestamp: at,
    });
  }

  private current(at: number): HarnessTabMessage {
    const last = this.out[this.out.length - 1];
    if (last && last.role === 'assistant') return last;
    const m: HarnessTabMessage = {
      id: `hist-${this.n++}`,
      role: 'assistant',
      content: '',
      timestamp: at,
    };
    this.out.push(m);
    return m;
  }

  /** 连续的助手片段（文本 / 工具 / 思考）并成一条 */
  assistant(text: string, tools: string[], at: number, usage?: HarnessUsage): void {
    const content = text.trim();
    if (!content && !tools.length && !usage) return;
    const m = this.current(at);
    if (content) {
      if (m.content) {
        const atBreak = m.content.length + 2;
        m.content = `${m.content}\n\n${content}`.slice(0, MAX_TEXT);
        if (atBreak < m.content.length) (m.textBreaks ??= []).push(atBreak);
      } else m.content = content.slice(0, MAX_TEXT);
    }
    if (tools.length) m.tools = [...(m.tools ?? []), ...tools];
    if (usage) m.usage = addUsage(m.usage, usage);
    m.timestamp = at;
  }

  thinking(text: string, at: number): void {
    const t = text.trim();
    if (!t) return;
    const m = this.current(at);
    (m.trace ??= []).push({
      type: 'thinking',
      text: t.slice(0, 8000),
      at,
      textAt: m.content.length,
    });
    m.timestamp = at;
  }

  toolStart(c: ToolStart): void {
    const m = this.current(c.at);
    this.names.set(c.id, c.name);
    const input = inputText(c.input);
    (m.trace ??= []).push({
      type: 'tool',
      name: c.name,
      status: 'start',
      id: c.id,
      ...(input !== undefined ? { input } : {}),
      ...(c.parentId ? { parentId: c.parentId } : {}),
      at: c.at,
      textAt: m.content.length,
    });
    m.timestamp = c.at;
  }

  toolEnd(e: ToolEnd): void {
    const m = this.current(e.at);
    const output = outputText(e.output);
    (m.trace ??= []).push({
      type: 'tool',
      name: this.names.get(e.id) ?? 'tool',
      status: e.error ? 'error' : 'done',
      id: e.id,
      ...(output !== undefined ? { output } : {}),
      at: e.at,
    });
    m.timestamp = e.at;
  }

  result(): HarnessTabMessage[] {
    let userAt = 0;
    for (const m of this.out) {
      if (m.role === 'user') userAt = m.timestamp;
      else {
        if (m.trace) {
          const trace = buildTrace(m.trace as unknown as Parameters<typeof buildTrace>[0]);
          if (trace.length) m.trace = trace as HarnessTraceEvent[];
          else delete m.trace;
        }
        // 整轮耗时：用户提问 → 该轮最后一个事件
        if (userAt && m.timestamp > userAt) m.durationMs = m.timestamp - userAt;
      }
    }
    return this.out.slice(-HISTORY_MAX_MESSAGES);
  }
}

export function addUsage(a: HarnessUsage | undefined, b: HarnessUsage): HarnessUsage {
  // 同轮多步：input/cache 取最后一步（当前上下文大小），output 累加（计费与工具环）
  const out: HarnessUsage = { ...a };
  if (b.inputTokens !== undefined) out.inputTokens = b.inputTokens;
  if (b.cacheReadTokens !== undefined) out.cacheReadTokens = b.cacheReadTokens;
  if (b.outputTokens !== undefined) out.outputTokens = (out.outputTokens ?? 0) + b.outputTokens;
  // 当前上下文：最后一次请求（逐请求的 usage 才有，见 usageOf）
  if (b.contextTokens !== undefined) out.contextTokens = b.contextTokens;
  return out;
}

/** 内容块里的 tool_use / tool_result / thinking（Claude / dsh 共用） */
export function feedBlocks(b: Builder, content: unknown, at: number, parentId?: string): void {
  if (!Array.isArray(content)) return;
  for (const c of content) {
    const o = (c ?? {}) as Json;
    const type = String(o.type ?? '');
    if (type === 'thinking' && str(o.thinking)) b.thinking(String(o.thinking), at);
    else if (type === 'reasoning' && str(o.text)) b.thinking(String(o.text), at);
    else if (type === 'tool_use' || type === 'tool-call' || type === 'tool_call') {
      const name = str(o.name) ?? str(o.tool) ?? str(o.toolName);
      if (!name) continue;
      const id = str(o.id) ?? str(o.toolCallId) ?? str(o.call_id) ?? `t-${at}-${name}`;
      b.toolStart({ id, name, input: o.input ?? o.args ?? o.arguments, at, parentId });
    } else if (type === 'tool_result' || type === 'tool-result') {
      const id = str(o.tool_use_id) ?? str(o.toolCallId) ?? str(o.call_id);
      if (id)
        b.toolEnd({
          id,
          output: o.content ?? o.output ?? o.result,
          error: o.is_error === true || o.isError === true,
          at,
        });
    }
  }
}

/** 按内容块的原顺序写入：文字、思考、工具交错，后一段文字另起一段 */
export function walkAssistant(
  b: Builder,
  content: unknown,
  at: number,
  usage?: HarnessUsage,
): void {
  if (!Array.isArray(content)) {
    b.assistant(typeof content === 'string' ? content : '', [], at, usage);
    return;
  }
  const names: string[] = [];
  for (const c of content) {
    const o = (c ?? {}) as Json;
    const type = String(o.type ?? '');
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && str(o.text))
      b.assistant(String(o.text), [], at);
    else if (type === 'thinking' && str(o.thinking)) b.thinking(String(o.thinking), at);
    else if (type === 'reasoning' && str(o.text)) b.thinking(String(o.text), at);
    else if (type === 'tool_use' || type === 'tool-call' || type === 'tool_call') {
      const name = str(o.name) ?? str(o.tool) ?? str(o.toolName);
      if (!name) continue;
      const id = str(o.id) ?? str(o.toolCallId) ?? str(o.call_id) ?? `t-${at}-${name}`;
      b.toolStart({ id, name, input: o.input ?? o.args ?? o.arguments, at });
      names.push(name);
    } else if (type === 'tool_result' || type === 'tool-result') {
      const id = str(o.tool_use_id) ?? str(o.toolCallId) ?? str(o.call_id);
      if (id)
        b.toolEnd({
          id,
          output: o.content ?? o.output ?? o.result,
          error: o.is_error === true || o.isError === true,
          at,
        });
    }
  }
  if (names.length) b.assistant('', names, at);
  if (usage) b.assistant('', [], at, usage);
}

export function usageOf(u: Json): HarnessUsage | undefined {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const out: HarnessUsage = {};
  const input = n(u.input_tokens) ?? n(u.inputTokens);
  const output = n(u.output_tokens) ?? n(u.outputTokens);
  const cache = n(u.cache_read_input_tokens) ?? n(u.cacheReadTokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cache !== undefined) out.cacheReadTokens = cache;
  // Anthropic 风格（Claude transcript 每条 assistant 即一次请求）：input / cache_read / cache_creation 互斥
  const creation = n(u.cache_creation_input_tokens);
  if (
    u.input_tokens !== undefined ||
    u.cache_read_input_tokens !== undefined ||
    creation !== undefined
  )
    out.contextTokens = (input ?? 0) + (cache ?? 0) + (creation ?? 0) + (output ?? 0);
  return Object.keys(out).length ? out : undefined;
}

/** 标题兜底：把第一条用户消息当标题（元信息解析不到标题时用） */
export function titleFromMessages(msgs: HarnessTabMessage[]): string | undefined {
  const first = msgs.find((m) => m.role === 'user');
  return first ? cleanTitle(first.content) : undefined;
}

/** 会话 id 的兜底：文件名（Claude / Codex）或会话目录名（Grok / dsh 的 dirId） */
function sessionIdOf(f: HistoryFileRef): string {
  // 不用 node:path（shared/ 也可能被纯数据入口引用）：按两种分隔符取文件名
  const base = f.path.slice(Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\')) + 1);
  return f.dirId ?? base.replace(/\.jsonl(?:\.zstd?)?$/, '');
}

/** 插件的 history.parse：转录解析 → 契约的 HistoryParse（元数据只给会话 id 与标题兜底） */
export function historyParse(
  formatHint: string,
  parse: (text: string, fallbackAt: number) => HarnessTabMessage[],
): (text: string, f: HistoryFileRef) => HistoryParse {
  return (text, f) => {
    const messages = parse(text, f.mtime);
    if (!messages.length && text.trim()) return { error: 'no messages recognised', formatHint };
    const title = titleFromMessages(messages);
    return {
      meta: { sessionId: sessionIdOf(f), ...(title ? { title } : {}) },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
  };
}
