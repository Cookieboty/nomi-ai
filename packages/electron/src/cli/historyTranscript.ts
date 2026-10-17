/**
 * 把各 CLI 落盘的会话文件解析成「可见对话」（尽力而为，只取用户 / 助手文本与工具名）。
 * 纯函数、不碰文件系统，便于用真实样本做夹具测试。
 *
 * - Claude Code   ~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl
 * - Codex         ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * - dsh           $DSH_HOME/sessions/<编码后的 cwd>/session-<uuid>/session.v4.jsonl(.zstd)
 */
import { cleanTitle } from '../agents/parsers';

import { inputText, outputText } from './streamParse';
import { buildTrace } from './traceBuilder';
import type { HarnessTabMessage, HarnessTraceEvent, HarnessUsage } from './types';

export const HISTORY_MAX_MESSAGES = 300;
const MAX_TEXT = 20_000;

type Json = Record<string, unknown>;

function lines(text: string): Json[] {
  const out: Json[] = [];
  for (const l of text.split('\n')) {
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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const when = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

/** 取内容块里的文本；返回 text 与工具名 */
function blocks(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] };
  const text: string[] = [];
  const tools: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
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
function injected(text: string): boolean {
  return (
    /^\s*<(environment_context|user_instructions|INSTRUCTIONS|skills_instructions|system-reminder|local-command-caveat|local-command-stdout)/i.test(
      text,
    ) ||
    /^\s*#\s*AGENTS\.md/i.test(text) ||
    /^\s*\[Request interrupted by user/i.test(text) ||
    /^\s*\[Your previous response had no visible output/i.test(text)
  );
}

interface ToolStart {
  id: string;
  name: string;
  input?: unknown;
  at: number;
  parentId?: string;
}
interface ToolEnd {
  id: string;
  output?: unknown;
  error?: boolean;
  at: number;
}

class Builder {
  readonly out: HarnessTabMessage[] = [];
  private n = 0;
  /** 工具调用 id → 名称（结果事件里补回名称） */
  private readonly names = new Map<string, string>();
  /** 当前这一轮的开始时间（最近一条用户消息）：用来算整轮耗时 */
  private turnStart = 0;

  user(text: string, at: number): void {
    const content = text.trim();
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
    if (content) m.content = `${m.content ? `${m.content}\n\n` : ''}${content}`.slice(0, MAX_TEXT);
    if (tools.length) m.tools = [...(m.tools ?? []), ...tools];
    if (usage) m.usage = addUsage(m.usage, usage);
    m.timestamp = at;
  }

  thinking(text: string, at: number): void {
    const t = text.trim();
    if (!t) return;
    const m = this.current(at);
    (m.trace ??= []).push({ type: 'thinking', text: t.slice(0, 8000), at });
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

function addUsage(a: HarnessUsage | undefined, b: HarnessUsage): HarnessUsage {
  const out: HarnessUsage = { ...a };
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens'] as const)
    if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k]!;
  return out;
}

/** 内容块里的 tool_use / tool_result / thinking（Claude / dsh 共用） */
function feedBlocks(b: Builder, content: unknown, at: number, parentId?: string): void {
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

export function parseClaudeTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    if (e.isSidechain === true) continue;
    const msg = (e.message ?? {}) as Json;
    const at = when(e.timestamp, fallbackAt);
    if (e.type === 'user') {
      if (e.isMeta === true) continue;
      const { text: t } = blocks(msg.content);
      // 工具回传（只含 tool_result 的「用户」行）：补全上一条助手消息里对应调用的输出
      feedBlocks(b, msg.content, at);
      if (t) b.user(t, at);
    } else if (e.type === 'assistant') {
      if (e.isApiErrorMessage === true) continue;
      const { text: t, tools } = blocks(msg.content);
      feedBlocks(b, msg.content, at);
      const u = (msg.usage ?? {}) as Json;
      const usage = usageOf(u);
      b.assistant(t, tools, at, usage);
    }
  }
  return b.result();
}

function usageOf(u: Json): HarnessUsage | undefined {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const out: HarnessUsage = {};
  const input = n(u.input_tokens) ?? n(u.inputTokens);
  const output = n(u.output_tokens) ?? n(u.outputTokens);
  const cache = n(u.cache_read_input_tokens) ?? n(u.cacheReadTokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cache !== undefined) out.cacheReadTokens = cache;
  return Object.keys(out).length ? out : undefined;
}

/** Codex 的工具输出常是 `{"output": "...", "metadata": {"exit_code": 0}}` 的 JSON 字符串 */
function codexOutput(raw: unknown): { output?: unknown; error: boolean } {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{')) {
      try {
        v = JSON.parse(s) as unknown;
      } catch {
        /* 保持原文 */
      }
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Json;
    const meta = (o.metadata ?? {}) as Json;
    const code = typeof meta.exit_code === 'number' ? meta.exit_code : undefined;
    const out = o.output ?? o.content ?? o.result;
    return { output: out ?? JSON.stringify(o), error: code !== undefined && code !== 0 };
  }
  return { output: v, error: false };
}

export function parseCodexTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    if (e.type !== 'response_item') continue;
    const p = (e.payload ?? {}) as Json;
    const at = when(e.timestamp, fallbackAt);
    if (p.type === 'message') {
      const { text: t } = blocks(p.content);
      if (p.role === 'user') b.user(t, at);
      else if (p.role === 'assistant') b.assistant(t, [], at);
    } else if (p.type === 'reasoning') {
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const t = summary
        .map((x) => str(((x ?? {}) as Json).text))
        .filter(Boolean)
        .join('\n');
      if (t) b.thinking(t, at);
    } else if (
      p.type === 'function_call' ||
      p.type === 'local_shell_call' ||
      p.type === 'custom_tool_call'
    ) {
      const name = str(p.name) ?? (p.type === 'local_shell_call' ? 'shell' : 'tool');
      const action = (p.action ?? {}) as Json;
      const input =
        p.type === 'local_shell_call'
          ? { command: Array.isArray(action.command) ? action.command.join(' ') : action.command }
          : (p.arguments ?? p.input);
      const id = str(p.call_id) ?? str(p.id) ?? `c-${at}-${name}`;
      b.assistant('', [name], at);
      b.toolStart({ id, name, input, at });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const id = str(p.call_id);
      if (id) {
        const r = codexOutput(p.output);
        b.toolEnd({ id, output: r.output, error: r.error, at });
      }
    }
  }
  return b.result();
}

export function parseDshTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    const data = (e.data ?? {}) as Json;
    const at = when(e.time, fallbackAt);
    if (e.type === 'user/message') {
      const src = (data.source ?? {}) as Json;
      if (src.kind !== 'user') continue; // runtime-context 等注入内容
      b.user(blocks(data.content).text, at);
    } else if (e.type === 'assistant/message') {
      const m = (data.message ?? {}) as Json;
      const { text: t, tools } = blocks(m.content);
      // 工具调用 / 思考块（dsh 的块形态与 Claude 相近；真实工具样本缺失，尽力而为）
      feedBlocks(b, m.content, at);
      b.assistant(t, tools, at, usageOf((data.usage ?? {}) as Json));
    } else if (typeof e.type === 'string' && /^tool[/_-]?(result|end|output)/i.test(e.type)) {
      const id = str(data.toolCallId) ?? str(data.callId) ?? str(data.id);
      if (id)
        b.toolEnd({
          id,
          output: data.output ?? data.result ?? data.content,
          error: data.isError === true || data.error !== undefined,
          at,
        });
    }
  }
  return b.result();
}

export type HistoryBackend = 'claude' | 'codex' | 'dsh';

export function parseTranscript(
  backend: HistoryBackend,
  text: string,
  fallbackAt = 0,
): HarnessTabMessage[] {
  if (backend === 'claude') return parseClaudeTranscript(text, fallbackAt);
  if (backend === 'codex') return parseCodexTranscript(text, fallbackAt);
  return parseDshTranscript(text, fallbackAt);
}

/** 标题兜底：把第一条用户消息当标题（元信息解析不到标题时用） */
export function titleFromMessages(msgs: HarnessTabMessage[]): string | undefined {
  const first = msgs.find((m) => m.role === 'user');
  return first ? cleanTitle(first.content) : undefined;
}
