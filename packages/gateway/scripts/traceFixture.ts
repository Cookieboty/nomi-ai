/**
 * 诊断追踪 → 回放夹具（docs/design/cli-plugin-architecture.md §8 诊断追踪 / 录制回放）。
 *
 * 输入是网关写的追踪文件（userData/gateway/trace/*.json，src/trace.ts 的 version 2 格式：
 * 入口请求体、各次上游尝试、上游原始响应全文、给客户端输出的差异）；输出是
 * tests/fixtures/replay/<name>.json，tests/replay.test.ts 用它把上游原文按事件逐块回放给网关。
 *
 * - 再脱敏一遍（redactText / redactJson），不带任何请求头；
 * - 默认去掉对话正文：正文类字段的非空字符串换成 TEXT_PLACEHOLDER，结构不变（空字符串保留，
 *   保活事件靠 delta: '' 识别）；工具参数（arguments / partial_json / input / args）保留但脱敏，
 *   里面可能有文件内容，提交前请自己看一遍；--keep-text 保留正文。
 */
import { redactJson, redactText } from '../src/trace';

export const TEXT_PLACEHOLDER = '[text]';

export type ReplayWire = 'messages' | 'responses' | 'chat' | 'gemini';

export interface ReplayFixture {
  version: 1;
  name: string;
  /** 人工合成的夹具（不是从真实追踪转来的） */
  synthetic?: boolean;
  description?: string;
  /** 来源追踪的 traceId（真实追踪才有） */
  traceId?: string;
  client: string;
  ingress: ReplayWire;
  /** 入口路径（Gemini 的模型名与是否流式在路径里） */
  path: string;
  request: unknown;
  upstream: {
    wire: ReplayWire;
    /** 上游请求里的模型名（回放时给客户端配的默认模型） */
    model: string;
    status: number;
    contentType: string;
    /** 上游原文，按 SSE 事件切块（非 SSE 为整段一块）；回放时逐块写出 */
    chunks: string[];
  };
}

interface TraceAttempt {
  wire?: string;
  body?: unknown;
  status?: number;
}

interface TraceDoc {
  version?: number;
  traceId?: string;
  client?: string;
  ingress?: string;
  path?: string;
  request?: { body?: unknown };
  upstream?: TraceAttempt[];
  response?: { status?: number; body?: string };
}

const WIRES: readonly ReplayWire[] = ['messages', 'responses', 'chat', 'gemini'];
const isWire = (w: unknown): w is ReplayWire =>
  typeof w === 'string' && (WIRES as readonly string[]).includes(w);

/** 正文类字段：对话内容、推理、系统提示 */
const TEXT_KEYS = new Set([
  'text',
  'content',
  'thinking',
  'refusal',
  'instructions',
  'system',
  'summary',
  'output',
]);
/** 工具参数：保留（结构要能解析），只脱敏 */
const ARG_KEYS = new Set(['arguments', 'partial_json', 'input', 'args']);

const isPlainObj = (v: unknown) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 正文字段的值：字符串换成占位符（空字符串保留）；字符串数组逐个换；对象 / 对象数组继续往下找 */
function stripValue(x: unknown, type: string): unknown {
  if (typeof x === 'string') return x ? TEXT_PLACEHOLDER : x;
  if (Array.isArray(x))
    return x.map((e) => (typeof e === 'string' ? stripValue(e, type) : stripText(e, type)));
  return stripText(x, type);
}

/**
 * 去掉正文：只换「直接挂在 TEXT_KEYS 下」的字符串，type / role / id / name 等结构字段不动。
 * delta 是字符串时看事件类型：工具参数增量（*arguments* / input_json）保留，其余（正文 / 推理增量）替换。
 */
export function stripText(v: unknown, eventType = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => stripText(x, eventType));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : eventType;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    // 工具参数：字符串（arguments / partial_json）与参数对象（Messages input、Gemini args）保留；
    // Responses 的 input 是对话（数组 / 字符串），照常去正文
    if (ARG_KEYS.has(k) && (k === 'input' ? isPlainObj(x) : true)) out[k] = x;
    else if (k === 'input') out[k] = stripValue(x, type);
    else if (k === 'delta' && typeof x === 'string')
      out[k] = /arguments|input_json/.test(type) || !x ? x : TEXT_PLACEHOLDER;
    else out[k] = TEXT_KEYS.has(k) ? stripValue(x, type) : stripText(x, type);
  }
  return out;
}

/** SSE 原文按事件切块（每块带上结尾的空行）；不是 SSE 的整段一块 */
export function splitChunks(raw: string): string[] {
  if (!/\r?\n\r?\n/.test(raw)) return raw ? [raw] : [];
  const out: string[] = [];
  const re = /[\s\S]*?\r?\n\r?\n/g;
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    out.push(m[0]);
    last = re.lastIndex;
  }
  // 结尾没有空行的半截事件（截断的流）原样保留
  if (last < raw.length) out.push(raw.slice(last));
  return out;
}

/** 一个 SSE 事件块：data 是 JSON 时去掉正文并脱敏，其余行原样（只做文本脱敏） */
function cleanChunk(chunk: string, keepText: boolean): string {
  return chunk
    .split(/(\r?\n)/)
    .map((line) => {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m) return redactText(line);
      let data: unknown;
      try {
        data = JSON.parse(m[1]!);
      } catch {
        // 截断在半截的 JSON：解析不了，按字段名把正文字符串（到结尾引号或行尾）换掉
        return redactText(keepText ? line : stripFragment(line));
      }
      const cleaned = redactJson(keepText ? data : stripText(data));
      return `data: ${JSON.stringify(cleaned)}`;
    })
    .join('');
}

const FRAGMENT_TEXT =
  /("(?:text|content|thinking|refusal|delta|output_text)"\s*:\s*")((?:[^"\\]|\\.)*)("?)/g;

/** 半截 JSON 里的正文字符串换成占位符（空字符串保留） */
export function stripFragment(line: string): string {
  return line.replace(FRAGMENT_TEXT, (_m, head: string, body: string, close: string) =>
    body ? `${head}${TEXT_PLACEHOLDER}${close}` : `${head}${close}`,
  );
}

/** 非 SSE 的整段 JSON 响应 */
function cleanBody(raw: string, keepText: boolean): string {
  try {
    const data: unknown = JSON.parse(raw);
    return JSON.stringify(redactJson(keepText ? data : stripText(data)));
  } catch {
    return redactText(raw);
  }
}

/** 把追踪文件的内容转成回放夹具；格式不对抛错（说明缺了什么） */
export function traceToFixture(
  doc: unknown,
  o: { name: string; keepText?: boolean; synthetic?: boolean; description?: string },
): ReplayFixture {
  const t = (doc ?? {}) as TraceDoc;
  if (t.version !== 2) throw new Error(`unsupported trace version ${String(t.version)} (need 2)`);
  if (!isWire(t.ingress)) throw new Error(`trace has no valid ingress wire`);
  const attempts = Array.isArray(t.upstream) ? t.upstream : [];
  // 回放最后一次尝试（就是给客户端那份响应的来源）
  const last = attempts[attempts.length - 1];
  if (!last || !isWire(last.wire)) throw new Error('trace has no upstream attempt');
  const raw = typeof t.response?.body === 'string' ? t.response.body : '';
  const sse = /^(event|data):/m.test(raw);
  const keepText = o.keepText === true;
  const reqBody = t.request?.body;
  const upModel = isPlainObj(last.body) ? (last.body as Record<string, unknown>).model : undefined;
  return {
    version: 1,
    name: o.name,
    ...(o.synthetic ? { synthetic: true } : {}),
    ...(o.description ? { description: o.description } : {}),
    ...(t.traceId && !o.synthetic ? { traceId: t.traceId } : {}),
    client: typeof t.client === 'string' ? t.client : 'claude',
    ingress: t.ingress,
    path: redactText(typeof t.path === 'string' && t.path ? t.path : defaultPath(t.ingress)),
    request: redactJson(keepText ? reqBody : stripText(reqBody)),
    upstream: {
      wire: last.wire,
      model: typeof upModel === 'string' && upModel ? upModel : 'm',
      status: t.response?.status ?? last.status ?? 200,
      contentType: sse ? 'text/event-stream' : 'application/json',
      chunks: sse
        ? splitChunks(raw).map((c) => cleanChunk(c, keepText))
        : raw
          ? [cleanBody(raw, keepText)]
          : [],
    },
  };
}

export function defaultPath(w: ReplayWire): string {
  switch (w) {
    case 'messages':
      return '/v1/messages';
    case 'responses':
      return '/v1/responses';
    case 'chat':
      return '/v1/chat/completions';
    case 'gemini':
      return '/v1beta/models/m:streamGenerateContent?alt=sse';
  }
}
