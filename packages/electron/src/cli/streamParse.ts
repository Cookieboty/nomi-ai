/** 解析 Claude stream-json / Codex NDJSON 行 → HarnessEvent */
import { t } from '../i18n';

import type { HarnessEvent, HarnessUsage } from './types';

const MAX_INPUT_STR = 2000;
const MAX_OUTPUT = 6000;
const MAX_THINKING = 8000;

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}\n… (+${s.length - n})` : s;

/** 递归裁剪对象里的长字符串（保持 JSON 仍然合法），并限制深度 / 数组长度 */
function clipDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, MAX_INPUT_STR);
  if (depth > 5 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40))
    out[k] = clipDeep(x, depth + 1);
  return out;
}

/** 工具参数 → 字符串（字符串原样裁剪，对象序列化为合法 JSON）；空值返回 undefined */
export function inputText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') return clip(v, MAX_INPUT_STR);
  if (typeof v !== 'object') return String(v);
  if (!Array.isArray(v) && Object.keys(v as object).length === 0) return undefined;
  try {
    return JSON.stringify(clipDeep(v));
  } catch {
    return undefined;
  }
}

/** 工具输出 → 字符串：字符串 / 内容块数组（取 text）/ 其它对象序列化 */
export function outputText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (typeof v === 'string') s = v;
  else if (Array.isArray(v)) {
    s = v
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : typeof c === 'string'
            ? c
            : '',
      )
      .filter(Boolean)
      .join('\n');
    if (!s) return undefined;
  } else if (typeof v === 'object') {
    try {
      s = JSON.stringify(v);
    } catch {
      return undefined;
    }
  } else s = String(v);
  return s ? clip(s, MAX_OUTPUT) : undefined;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * 各 CLI 上报的用量 → HarnessUsage（兼容 snake_case / camelCase；没有任何数据时返回 undefined）。
 * Claude: usage.{input,output,cache_read_input}_tokens + total_cost_usd + duration_ms；
 * Codex: usage.{input,cached_input,output}_tokens；Grok: usage 对象（camelCase）。
 */
export function parseUsage(
  usage: unknown,
  extra: { costUsd?: unknown; durationMs?: unknown } = {},
): HarnessUsage | undefined {
  const u = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = num(u[k]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const out: HarnessUsage = {};
  const input = pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const output = pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  const cache = pick(
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cacheReadTokens',
    'cachedInputTokens',
  );
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cache !== undefined) out.cacheReadTokens = cache;
  const cost = num(extra.costUsd);
  if (cost !== undefined) out.costUsd = cost;
  const dur = num(extra.durationMs);
  if (dur !== undefined) out.durationMs = dur;
  return Object.keys(out).length ? out : undefined;
}

/** 只在有值时附加可选字段，保持事件对象干净 */
function withOpt<T extends object>(ev: T, extra: Record<string, unknown>): T {
  for (const [k, x] of Object.entries(extra))
    if (x !== undefined) (ev as Record<string, unknown>)[k] = x;
  return ev;
}

export function parseClaudeLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const out: HarnessEvent[] = [];
  if (type === 'stream_event') {
    const ev = j.event as { delta?: { type?: string; text?: string } } | undefined;
    if (ev?.delta?.type === 'text_delta' && ev.delta.text) {
      out.push({ type: 'text-delta', text: ev.delta.text });
    }
  } else if (type === 'assistant') {
    const msg = j.message as { content?: unknown } | undefined;
    const text = extractClaudeText(msg?.content);
    if (text) out.push({ type: 'text', text });
  } else if (type === 'result') {
    const text = typeof j.result === 'string' ? j.result : '';
    const sid = typeof j.session_id === 'string' ? j.session_id : undefined;
    const usage = parseUsage(j.usage, { costUsd: j.total_cost_usd, durationMs: j.duration_ms });
    const failed =
      j.is_error === true || (typeof j.subtype === 'string' && j.subtype.startsWith('error'));
    // 失败的一轮（限流 / 上下文超限 / 执行出错）不当作正常回答：按错误处理，界面显示错误卡片并可重试
    if (failed) out.push({ type: 'error', message: text || String(j.subtype ?? t('Claude 错误')) });
    else out.push(withOpt({ type: 'done', text, sessionId: sid } as HarnessEvent, { usage }));
  } else if (type === 'system' && j.subtype === 'api_retry') {
    out.push(
      withOpt({ type: 'status', kind: 'retry' } as HarnessEvent, {
        attempt: num(j.attempt),
        max: num(j.max_retries),
        text: typeof j.error === 'string' ? j.error : undefined,
      }),
    );
  } else if (type === 'system' && j.subtype === 'status') {
    out.push(
      j.status === 'compacting'
        ? { type: 'status', kind: 'compact' }
        : { type: 'status', kind: 'clear' },
    );
  } else if (type === 'system' && j.subtype === 'compact_boundary') {
    out.push({ type: 'status', kind: 'clear' });
  } else if (type === 'error' || (type === 'system' && j.subtype === 'error')) {
    out.push({ type: 'error', message: String(j.error ?? j.message ?? t('Claude 错误')) });
  } else if (type === 'control_request') {
    const reqId = typeof j.request_id === 'string' ? j.request_id : '';
    const req = (j.request ?? {}) as Record<string, unknown>;
    if (reqId && req.subtype === 'can_use_tool') {
      const tool = String(req.tool_name ?? 'tool');
      const input = req.input;
      let detail = '';
      if (input && typeof input === 'object') {
        const o = input as Record<string, unknown>;
        detail = String(o.command ?? o.file_path ?? o.path ?? '').slice(0, 120);
      } else if (typeof input === 'string') {
        detail = input.slice(0, 120);
      }
      out.push({
        type: 'permission',
        id: reqId,
        summary: detail ? `${tool}: ${detail}` : tool,
      });
    }
  }
  // tool_use / tool_result blocks
  if (type === 'assistant' || type === 'user') {
    const msg = j.message as { content?: unknown } | undefined;
    if (Array.isArray(msg?.content)) {
      for (const c of msg.content as Array<Record<string, unknown>>) {
        const parent =
          typeof j.parent_tool_use_id === 'string' && j.parent_tool_use_id
            ? j.parent_tool_use_id
            : undefined;
        if (type === 'assistant' && c.type === 'thinking' && typeof c.thinking === 'string') {
          if (c.thinking.trim())
            out.push({ type: 'thinking', text: clip(c.thinking, MAX_THINKING) });
        }
        if (type === 'assistant' && c.type === 'tool_use') {
          out.push(
            withOpt(
              {
                type: 'tool',
                name: String(c.name ?? 'tool'),
                status: 'start',
                detail: typeof c.id === 'string' ? c.id : undefined,
              } as HarnessEvent,
              { input: inputText(c.input), parentId: parent },
            ),
          );
        }
        if (type === 'user' && c.type === 'tool_result') {
          const id = typeof c.tool_use_id === 'string' ? c.tool_use_id : undefined;
          const err = c.is_error === true || c.is_error === 'true';
          out.push(
            withOpt(
              {
                type: 'tool',
                name: 'tool',
                status: err ? 'error' : 'done',
                detail: id,
              } as HarnessEvent,
              { output: outputText(c.content), parentId: parent },
            ),
          );
        }
      }
    }
  }
  return out;
}

/**
 * 有状态的 Claude 解析器：用先前 tool_use 的 id 给 tool_result 补回工具名。
 * 每次运行新建一个。
 */
export function createClaudeParser(): (line: string) => HarnessEvent[] {
  const names = new Map<string, string>();
  return (line) =>
    parseClaudeLine(line).map((ev) => {
      if (ev.type !== 'tool' || !ev.detail) return ev;
      if (ev.status === 'start') {
        names.set(ev.detail, ev.name);
        return ev;
      }
      const name = names.get(ev.detail);
      if (name) names.delete(ev.detail);
      return name ? { ...ev, name } : ev;
    });
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
        return String((c as { text?: string }).text ?? '');
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

export function parseCodexLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const out: HarnessEvent[] = [];
  if (type === 'item.completed' || type === 'item.started') {
    const item = j.item as Record<string, unknown> | undefined;
    if (!item) return out;
    const itemType = String(item.type ?? '');
    const text = typeof item.text === 'string' ? item.text : '';
    const id = typeof item.id === 'string' ? item.id : undefined;
    const done = type === 'item.completed';
    if (itemType === 'agent_message' && text) {
      out.push({ type: 'text', text });
      if (done) out.push({ type: 'done', text });
    } else if (itemType === 'reasoning' && text && done) {
      out.push({ type: 'thinking', text: clip(text, MAX_THINKING) });
    } else if (itemType === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : undefined;
      const failed =
        item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      out.push(
        withOpt(
          {
            type: 'tool',
            name: 'bash',
            status: done ? (failed ? 'error' : 'done') : 'start',
            detail: command,
          } as HarnessEvent,
          {
            id,
            input: command ? inputText({ command }) : undefined,
            output: done ? outputText(item.aggregated_output) : undefined,
          },
        ),
      );
    } else if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      out.push(
        withOpt(
          {
            type: 'tool',
            name: 'apply_patch',
            status: done ? (item.status === 'failed' ? 'error' : 'done') : 'start',
          } as HarnessEvent,
          { id, input: inputText({ changes }) },
        ),
      );
    } else if (itemType === 'mcp_tool_call') {
      const name = [item.server, item.tool].filter((x) => typeof x === 'string' && x).join('.');
      out.push(
        withOpt(
          {
            type: 'tool',
            name: name || 'mcp',
            status: done ? (item.status === 'failed' ? 'error' : 'done') : 'start',
          } as HarnessEvent,
          {
            id,
            input: inputText(item.arguments),
            output: done ? outputText(item.result) : undefined,
          },
        ),
      );
    } else if (itemType === 'web_search') {
      out.push(
        withOpt(
          { type: 'tool', name: 'web_search', status: done ? 'done' : 'start' } as HarnessEvent,
          { id, input: inputText({ query: item.query }) },
        ),
      );
    }
  } else if (type === 'turn.completed') {
    const usage = parseUsage(j.usage);
    if (usage) out.push({ type: 'done', text: '', usage });
  } else if (type === 'turn.failed' || type === 'error') {
    const message = String(j.error ?? j.message ?? t('Codex 错误'));
    const re = /reconnect\w*[^\d]*(\d+)\s*\/\s*(\d+)/i.exec(message);
    if (type === 'error' && (re || /reconnect/i.test(message)))
      out.push(
        withOpt({ type: 'status', kind: 'reconnect', text: message } as HarnessEvent, {
          attempt: re ? Number(re[1]) : undefined,
          max: re ? Number(re[2]) : undefined,
        }),
      );
    else out.push({ type: 'error', message });
  } else if (type === 'thread.started' && typeof j.thread_id === 'string') {
    out.push({ type: 'done', text: '', sessionId: j.thread_id });
  }
  return out;
}

/**
 * dsh `--profile headless --json` 的 NDJSON 事件：
 * session / status / text / thinking / tool_call / tool_result / final / error。
 * 文本按已提交的步骤整段到达；final 为整轮最终回复。
 */
export function parseDshLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (type) {
    case 'session':
      return str(j.sessionId) ? [{ type: 'done', text: '', sessionId: str(j.sessionId) }] : [];
    case 'text':
      return str(j.text) ? [{ type: 'text', text: str(j.text) }] : [];
    case 'final':
      return [{ type: 'done', text: str(j.text) }];
    case 'thinking':
      return str(j.text) ? [{ type: 'thinking', text: clip(str(j.text), MAX_THINKING) }] : [];
    case 'tool_call':
      return [
        withOpt(
          {
            type: 'tool',
            name: str(j.tool) || 'tool',
            status: 'start',
            detail: str(j.callId),
          } as HarnessEvent,
          { input: inputText(j.input ?? j.args ?? j.arguments) },
        ),
      ];
    case 'tool_result':
      return [
        withOpt(
          {
            type: 'tool',
            name: str(j.tool) || 'tool',
            status: j.status === 'error' ? 'error' : 'done',
            detail: str(j.callId),
          } as HarnessEvent,
          { output: outputText(j.result ?? j.output ?? j.content) },
        ),
      ];
    case 'error':
      return [{ type: 'error', message: str(j.message) || t('dsh 错误') }];
    case 'status': {
      const reason = j.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (j.phase === 'turn_end' && reason?.kind === 'error') {
        return [{ type: 'error', message: reason.error?.message || t('dsh 错误') }];
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * 有状态的 dsh 解析器：tool_result 只带 callId，按先前的 tool_call 补回工具名。
 * 每次运行新建一个。
 */
export function createDshParser(): (line: string) => HarnessEvent[] {
  const names = new Map<string, string>();
  return (line) =>
    parseDshLine(line).map((ev) => {
      if (ev.type !== 'tool' || !ev.detail) return ev;
      if (ev.status === 'start') {
        names.set(ev.detail, ev.name);
        return ev;
      }
      const name = names.get(ev.detail);
      if (name) names.delete(ev.detail);
      return name ? { ...ev, name } : ev;
    });
}

/**
 * Grok Build `--output-format streaming-json`（官方 headless 文档，2026-10）：
 * NDJSON，每行一个 type 字段：text / thought / tool_call / tool_call_update /
 * usage / plan / end / error（其它类型静默跳过）。
 * 字段名按文档：text.data、tool_call.toolName / toolCallId / status、
 * end.sessionId、error.message。无法识别的行静默跳过，不编造格式。
 */
export function parseGrokLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (type) {
    case 'text': {
      const data = str(j.data) || str(j.text);
      return data ? [{ type: 'text-delta', text: data }] : [];
    }
    case 'tool_call': {
      const name = str(j.toolName) || str(j.title) || str(j.kind) || 'tool';
      const id = str(j.toolCallId) || str(j.id);
      const status = str(j.status);
      const input = inputText(j.rawInput ?? j.input ?? j.arguments);
      if (status === 'completed' || status === 'failed' || status === 'error') {
        return [
          withOpt(
            {
              type: 'tool',
              name,
              status: status === 'completed' ? 'done' : 'error',
              detail: id || undefined,
            } as HarnessEvent,
            { input, output: outputText(j.rawOutput ?? j.output ?? j.content) },
          ),
        ];
      }
      return [
        withOpt({ type: 'tool', name, status: 'start', detail: id || undefined } as HarnessEvent, {
          input,
        }),
      ];
    }
    case 'tool_call_update': {
      const id = str(j.toolCallId) || str(j.id);
      const status = str(j.status);
      if (!status) return [];
      if (status === 'in_progress' || status === 'pending') return [];
      return [
        withOpt(
          {
            type: 'tool',
            name: str(j.toolName) || str(j.title) || 'tool',
            status: status === 'completed' ? 'done' : 'error',
            detail: id || undefined,
          } as HarnessEvent,
          {
            input: inputText(j.rawInput ?? j.input),
            output: outputText(j.rawOutput ?? j.output ?? j.content),
          },
        ),
      ];
    }
    case 'end':
      return [{ type: 'done', text: str(j.text), sessionId: str(j.sessionId) || undefined }];
    case 'error':
      return [{ type: 'error', message: str(j.message) || t('Grok 错误') }];
    case 'thought': {
      const data = str(j.data) || str(j.text);
      return data ? [{ type: 'thinking', text: clip(data, MAX_THINKING) }] : [];
    }
    case 'usage': {
      const usage = parseUsage(j.usage ?? j.data ?? j, { costUsd: j.costUsd ?? j.cost });
      return usage ? [{ type: 'done', text: '', usage }] : [];
    }
    case 'plan':
    case 'available_commands':
      return [];
    default:
      return [];
  }
}

/** 有状态的 Grok 解析器：tool_call_update 可能不带 toolName，按 toolCallId 补回。 */
export function createGrokParser(): (line: string) => HarnessEvent[] {
  const names = new Map<string, string>();
  return (line) =>
    parseGrokLine(line).map((ev) => {
      if (ev.type !== 'tool' || !ev.detail) return ev;
      if (ev.status === 'start') {
        names.set(ev.detail, ev.name);
        return ev;
      }
      const name = names.get(ev.detail);
      if (name) names.delete(ev.detail);
      return name && ev.name === 'tool' ? { ...ev, name } : ev;
    });
}
