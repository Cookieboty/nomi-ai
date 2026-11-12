/** Nomi 流式 chunk → 与编程助手同构的轨迹事件（工具调用 / 思考），让两边走同一套渲染 */
import type { ContextBreakdown, HarnessTraceEvent } from '../services/harnessClient';

export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** 最后一步请求的上下文占用（多步工具循环时 < inputTokens） */
  contextTokens?: number;
  /** 隐私模式在这一轮发给第三方供应商的内容里隐藏了几个密钥（统一网关报回） */
  redacted?: number;
  /** 实际回答的模型（统一网关报回的 `供应商/模型`；故障转移后与选中的不同） */
  model?: string;
  /** 上游响应里的模型名（和请求的不是同一个时才有） */
  responseModel?: string;
  /** contextTokens 的分项（内核按实际请求拆、按真实用量校准） */
  breakdown?: ContextBreakdown;
}

type Chunk = { type: string; [k: string]: unknown };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * 工具自己返回的失败（`{ ok: false, error }`：用户拒绝、计划档拦下、超时等）也按失败显示，
 * 不打 ✓。只解析看起来像这种结果的输出（以 `{` 开头且带 `"ok":false`），避免每次都 JSON.parse。
 */
function refused(output: string | undefined): boolean {
  if (!output || output[0] !== '{' || !/"ok"\s*:\s*false/.test(output)) return false;
  try {
    const j = JSON.parse(output) as { ok?: unknown };
    return j?.ok === false;
  } catch {
    return false;
  }
}

export function chunkToTrace(c: Chunk, now = Date.now()): HarnessTraceEvent | null {
  if (c.type === 'tool_call.delta') {
    const name = str(c.name);
    if (!name) return null;
    return {
      type: 'tool',
      name,
      status: 'start',
      ...(str(c.id) ? { id: str(c.id) } : {}),
      ...(str(c.argumentsJson) ? { input: str(c.argumentsJson) } : {}),
      at: now,
    };
  }
  if (c.type === 'tool_call.result') {
    const error = str(c.error);
    const output = error ?? str(c.output);
    return {
      type: 'tool',
      name: str(c.name) ?? 'tool',
      status: error !== undefined || refused(output) ? 'error' : 'done',
      ...(str(c.id) ? { id: str(c.id) } : {}),
      ...(output !== undefined ? { output } : {}),
      at: now,
    };
  }
  if (c.type === 'reasoning' && c.phase !== 'end' && typeof c.content === 'string') {
    return { type: 'thinking', text: c.content, at: now };
  }
  return null;
}

export function chunkToUsage(c: Chunk): StreamUsage | null {
  if (c.type !== 'usage' || !c.usage || typeof c.usage !== 'object') return null;
  const u = c.usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out: StreamUsage = {};
  const i = n(u.promptTokens);
  const o = n(u.completionTokens);
  const cr = n(u.cacheReadTokens);
  const ctx = n(u.contextTokens);
  if (ctx !== undefined) out.contextTokens = ctx;
  if (i !== undefined) out.inputTokens = i;
  if (o !== undefined) out.outputTokens = o;
  if (cr !== undefined) out.cacheReadTokens = cr;
  const red = n(u.redacted);
  if (red !== undefined && red > 0) out.redacted = Math.trunc(red);
  const model = str(c.model);
  if (model) out.model = model;
  const responseModel = str(c.responseModel);
  if (responseModel) out.responseModel = responseModel;
  const bd = u.breakdown as Record<string, unknown> | undefined;
  if (bd && typeof bd === 'object') {
    const keys = [
      'system',
      'toolDefs',
      'memory',
      'user',
      'assistant',
      'tools',
      'thinking',
    ] as const;
    const vals = keys.map((k) => n(bd[k]) ?? 0);
    if (vals.some((v) => v > 0)) {
      const [system, toolDefs, memory, user, assistant, tools, thinking] = vals as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      out.breakdown = { system, toolDefs, memory, user, assistant, tools, thinking };
    }
  }
  return Object.keys(out).length ? out : null;
}
