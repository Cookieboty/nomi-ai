/**
 * 上游非流式 JSON 响应 → 中间事件。
 * 用于：客户端请求流式但上游返回了普通 JSON 时，合成目标 SSE。
 */
import type { NormEvent, StopReason, StreamUsage } from './events';

import type { UpstreamStreamFormat } from './index';

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
function asArr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v as unknown[]).map(asObj) : [];
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** 只在有值时带上这个字段（中间事件里不出现 undefined 键） */
function defined<K extends string>(k: K, v: number | undefined): Partial<Record<K, number>> {
  return v === undefined ? {} : ({ [k]: v } as Record<K, number>);
}
/** 上游没给工具调用 id 时的确定性 id（§6.9.7；与流式解码器同一规则） */
function fid(seed: string, prefix: string, key: string | number): string {
  return seed ? `${prefix}_${seed}_${key}` : `${prefix}_${key}`;
}
function argsString(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v ?? {});
}

function errorEvents(e: unknown, fallbackType: string): NormEvent[] {
  const o = asObj(e);
  return [
    {
      type: 'error',
      message: str(o.message) || (typeof e === 'string' ? e : 'upstream error'),
      errorType: str(o.type) || str(o.code) || str(o.status) || fallbackType,
    },
  ];
}

function chatJson(j: Obj, seed: string): NormEvent[] {
  if (j.error) return errorEvents(j.error, 'api_error');
  const out: NormEvent[] = [];
  const u = asObj(j.usage);
  const usage: StreamUsage = {
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    ...defined('cacheReadTokens', num(asObj(u.prompt_tokens_details).cached_tokens)),
    ...defined('reasoningTokens', num(asObj(u.completion_tokens_details).reasoning_tokens)),
  };
  out.push({ type: 'start', id: str(j.id) || undefined, model: str(j.model) || undefined, usage });
  const c = asArr(j.choices)[0] ?? {};
  const msg = asObj(c.message);
  const reasoning = str(msg.reasoning_content) || str(msg.reasoning);
  if (reasoning) out.push({ type: 'think_start' }, { type: 'think', text: reasoning });
  if (str(msg.content)) out.push({ type: 'text', text: str(msg.content) });
  asArr(msg.tool_calls).forEach((tc, i) => {
    const fn = asObj(tc.function);
    const key = String(i);
    out.push({
      type: 'tool_start',
      key,
      id: str(tc.id) || fid(seed, 'call', i),
      name: str(fn.name),
    });
    out.push({ type: 'tool_args', key, delta: argsString(fn.arguments) });
    out.push({ type: 'tool_end', key });
  });
  const fr = c.finish_reason;
  const reason: StopReason =
    fr === 'length'
      ? 'max_tokens'
      : fr === 'tool_calls' || asArr(msg.tool_calls).length
        ? 'tool_use'
        : 'end_turn';
  out.push({ type: 'finish', reason, usage });
  return out;
}

function responsesJson(j: Obj): NormEvent[] {
  if (j.error && j.status !== 'completed') return errorEvents(j.error, 'api_error');
  const out: NormEvent[] = [];
  const u = asObj(j.usage);
  const usage: StreamUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    ...defined('cacheReadTokens', num(asObj(u.input_tokens_details).cached_tokens)),
    ...defined('reasoningTokens', num(asObj(u.output_tokens_details).reasoning_tokens)),
  };
  out.push({ type: 'start', id: str(j.id) || undefined, model: str(j.model) || undefined, usage });
  let sawTool = false;
  asArr(j.output).forEach((item, i) => {
    if (item.type === 'reasoning') {
      out.push({ type: 'think_start', ...(str(item.id) ? { id: str(item.id) } : {}) });
      const summary = asArr(item.summary)
        .map((s) => str(s.text))
        .filter(Boolean)
        .join('\n');
      if (summary) out.push({ type: 'think', text: summary });
      if (str(item.encrypted_content)) out.push({ type: 'sealed', by: 'responses', raw: item });
    } else if (item.type === 'message') {
      const text = asArr(item.content)
        .map((c) =>
          c.type === 'output_text' ? str(c.text) : c.type === 'refusal' ? str(c.refusal) : '',
        )
        .join('');
      if (text) out.push({ type: 'text', text });
    } else if (item.type === 'function_call') {
      sawTool = true;
      const key = str(item.id) || String(i);
      out.push({ type: 'tool_start', key, id: str(item.call_id) || key, name: str(item.name) });
      out.push({ type: 'tool_args', key, delta: argsString(item.arguments) });
      out.push({ type: 'tool_end', key });
    }
  });
  const incomplete = asObj(j.incomplete_details).reason === 'max_output_tokens';
  out.push({
    type: 'finish',
    reason: incomplete ? 'max_tokens' : sawTool ? 'tool_use' : 'end_turn',
    usage,
  });
  return out;
}

function geminiJson(j: Obj, seed: string): NormEvent[] {
  if (j.error) return errorEvents(j.error, 'api_error');
  const out: NormEvent[] = [];
  const um = asObj(j.usageMetadata);
  const usage: StreamUsage = {
    inputTokens: num(um.promptTokenCount),
    outputTokens: num(um.candidatesTokenCount),
    ...defined('cacheReadTokens', num(um.cachedContentTokenCount)),
    ...defined('reasoningTokens', num(um.thoughtsTokenCount)),
  };
  out.push({
    type: 'start',
    id: str(j.responseId) || undefined,
    model: str(j.modelVersion) || undefined,
    usage,
  });
  const c = asArr(j.candidates)[0];
  if (!c) {
    const block = asObj(j.promptFeedback).blockReason;
    return [
      {
        type: 'error',
        message: `prompt blocked: ${String(block ?? 'no candidates')}`,
        errorType: 'invalid_request_error',
      },
    ];
  }
  let n = 0;
  let thinking = false;
  for (const p of asArr(asObj(c.content).parts)) {
    const sig = str(p.thoughtSignature);
    if (p.thought === true) {
      if (!thinking) out.push({ type: 'think_start' });
      thinking = true;
      if (str(p.text)) out.push({ type: 'think', text: str(p.text) });
      if (sig) out.push({ type: 'think_sig', signature: sig });
      continue;
    }
    thinking = false;
    if (str(p.text)) out.push({ type: 'text', text: str(p.text) });
    if (sig) out.push({ type: 'text_sig', signature: sig });
    if (p.functionCall) {
      const fc = asObj(p.functionCall);
      const key = String(n++);
      out.push({
        type: 'tool_start',
        key,
        id: str(fc.id) || fid(seed, 'call_gemini', key),
        name: str(fc.name),
      });
      out.push({ type: 'tool_args', key, delta: argsString(fc.args) });
      out.push({ type: 'tool_end', key });
    }
  }
  const reason: StopReason =
    c.finishReason === 'MAX_TOKENS' ? 'max_tokens' : n ? 'tool_use' : 'end_turn';
  out.push({ type: 'finish', reason, usage });
  return out;
}

function messagesJson(j: Obj): NormEvent[] {
  if (j.type === 'error' || j.error) return errorEvents(j.error, 'api_error');
  const out: NormEvent[] = [];
  const u = asObj(j.usage);
  const usage: StreamUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    ...defined('cacheReadTokens', num(u.cache_read_input_tokens)),
    ...defined('cacheWriteTokens', num(u.cache_creation_input_tokens)),
  };
  out.push({ type: 'start', id: str(j.id) || undefined, model: str(j.model) || undefined, usage });
  asArr(j.content).forEach((b, i) => {
    if (b.type === 'thinking') {
      out.push({ type: 'think_start' });
      if (str(b.thinking)) out.push({ type: 'think', text: str(b.thinking) });
      if (str(b.signature)) out.push({ type: 'think_sig', signature: str(b.signature) });
    } else if (b.type === 'redacted_thinking') out.push({ type: 'sealed', by: 'messages', raw: b });
    else if (b.type === 'text' && str(b.text)) out.push({ type: 'text', text: str(b.text) });
    else if (b.type === 'tool_use') {
      const key = String(i);
      out.push({ type: 'tool_start', key, id: str(b.id), name: str(b.name) });
      out.push({ type: 'tool_args', key, delta: argsString(b.input) });
      out.push({ type: 'tool_end', key });
    }
  });
  const sr = j.stop_reason;
  const reason: StopReason =
    sr === 'max_tokens' || sr === 'tool_use' || sr === 'stop_sequence' || sr === 'refusal'
      ? sr
      : 'end_turn';
  out.push({ type: 'finish', reason, usage });
  return out;
}

export function jsonToEvents(from: UpstreamStreamFormat, body: unknown, seed = ''): NormEvent[] {
  const j = asObj(body);
  switch (from) {
    case 'chat':
      return chatJson(j, seed);
    case 'responses':
      return responsesJson(j);
    case 'gemini':
      return geminiJson(j, seed);
    case 'messages':
      return messagesJson(j);
  }
}
