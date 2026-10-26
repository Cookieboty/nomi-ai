/** Nomi 流式 chunk → 与编程助手同构的轨迹事件（工具调用 / 思考），让两边走同一套渲染 */
import type { HarnessTraceEvent } from '../services/harnessClient';

export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** 最后一步请求的上下文占用（多步工具循环时 < inputTokens） */
  contextTokens?: number;
  /** 隐私模式在这一轮发给第三方供应商的内容里隐藏了几个密钥（统一网关报回） */
  redacted?: number;
}

type Chunk = { type: string; [k: string]: unknown };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

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
      status: error !== undefined ? 'error' : 'done',
      ...(str(c.id) ? { id: str(c.id) } : {}),
      ...(output !== undefined ? { output } : {}),
      at: now,
    };
  }
  if (c.type === 'reasoning' && str(c.content)) {
    return { type: 'thinking', text: str(c.content)!, at: now };
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
  return Object.keys(out).length ? out : null;
}
