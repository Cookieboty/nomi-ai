/**
 * IR → 上游请求体。
 * 推理参数（reasoning）与签名 / 加密推理的去留由上游能力和会话归属决定（§9.3、§12.7），
 * 这里只按协议能表达的内容编码：Chat / Responses / Gemini 不下发历史推理（Chat 在厂商要求时写回
 * reasoning_content），Messages 只保留带签名的。
 */
import type { IRMessage, IRPart, IRRequest, IRToolChoice } from '../ir';
import { argsObject, DEFAULT_MAX_TOKENS, toDataUrl, type Json } from '../util';

function systemJoined(ir: IRRequest, sep: string): string {
  return ir.system
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join(sep);
}

function customInput(args: string | undefined): string {
  const v = argsObject(args);
  return v && typeof v === 'object' && !Array.isArray(v) && typeof v.input === 'string'
    ? v.input
    : (args ?? '');
}

/* --------------------------- OpenAI Chat Completions --------------------------- */

export interface EncodeOptions {
  /** Chat：历史推理写回 assistant 消息的 reasoning_content（厂商 quirks.reasoningPassback） */
  reasoningPassback?: boolean;
}

export function encodeChat(ir: IRRequest, model?: string, opts: EncodeOptions = {}): Json {
  const messages: Json[] = [];
  const sys = systemJoined(ir, '\n');
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of ir.messages) {
    if (m.role === 'assistant') {
      const text = m.parts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text ?? '')
        .join('');
      const toolCalls: Json[] = m.parts
        .filter((p) => p.kind === 'tool_call')
        .map((p) => ({
          id: p.id ?? '',
          type: 'function',
          function: { name: p.name ?? '', arguments: p.args ?? '{}' },
        }));
      const msg: Record<string, Json> = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (opts.reasoningPassback) {
        const thinking = m.parts
          .filter((p) => p.kind === 'thinking' && p.text)
          .map((p) => p.text)
          .join('');
        if (thinking) msg.reasoning_content = thinking;
      }
      if (text || toolCalls.length) messages.push(msg);
      continue;
    }
    // user：tool_result 先成为独立的 tool 消息，结果里的图片补到这轮 user 消息末尾
    const parts: Json[] = [];
    const extraImages: IRPart[] = [];
    for (const p of m.parts) {
      if (p.kind === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: p.callId ?? '',
          content: p.text || '(no output)',
        });
        extraImages.push(...(p.images ?? []));
      } else if (p.kind === 'text') {
        parts.push({ type: 'text', text: p.text ?? '' });
      } else if (p.kind === 'image') {
        parts.push({ type: 'image_url', image_url: { url: toDataUrl(p) } });
      }
    }
    for (const img of extraImages)
      parts.push({ type: 'image_url', image_url: { url: toDataUrl(img) } });
    if (!parts.length) continue;
    const onlyText = parts.every((p) => (p as { type: string }).type === 'text');
    messages.push({
      role: 'user',
      content: onlyText ? parts.map((p) => (p as { text: string }).text).join('') : parts,
    });
  }

  const out: Record<string, Json> = {
    model: model || ir.model,
    messages,
    stream: ir.stream,
  };
  if (ir.maxTokens !== undefined) out.max_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.stop?.length) out.stop = ir.stop;
  if (ir.tools.length) {
    out.tools = ir.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.schema as Json,
      },
    }));
    if (ir.toolChoice)
      out.tool_choice =
        typeof ir.toolChoice === 'object'
          ? { type: 'function', function: { name: ir.toolChoice.name } }
          : ir.toolChoice;
    if (ir.parallelToolCalls === false) out.parallel_tool_calls = false;
  }
  return out;
}

/* ------------------------------ OpenAI Responses ------------------------------ */

export function encodeResponses(ir: IRRequest, model?: string): Json {
  const input: Json[] = [];
  for (const m of ir.messages) {
    const role = m.role;
    let parts: Json[] = [];
    const flush = () => {
      if (!parts.length) return;
      input.push({ type: 'message', role, content: parts });
      parts = [];
    };
    for (const p of m.parts) {
      if (p.kind === 'text') {
        parts.push({
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: p.text ?? '',
        });
      } else if (p.kind === 'image' && role === 'user') {
        parts.push({ type: 'input_image', image_url: toDataUrl(p) });
      } else if (p.kind === 'tool_call') {
        flush();
        input.push(
          p.custom
            ? {
                type: 'custom_tool_call',
                call_id: p.id ?? '',
                name: p.name ?? '',
                input: customInput(p.args),
              }
            : {
                type: 'function_call',
                call_id: p.id ?? '',
                name: p.name ?? '',
                arguments: p.args ?? '{}',
              },
        );
      } else if (p.kind === 'tool_result') {
        flush();
        input.push({ type: 'function_call_output', call_id: p.callId ?? '', output: p.text ?? '' });
        for (const img of p.images ?? [])
          parts.push({ type: 'input_image', image_url: toDataUrl(img) });
      }
    }
    flush();
  }
  const out: Record<string, Json> = {
    model: model || ir.model,
    input,
    stream: ir.stream,
    store: false,
  };
  const sys = systemJoined(ir, '\n');
  if (sys) out.instructions = sys;
  if (ir.maxTokens !== undefined) out.max_output_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.tools.length) {
    out.tools = ir.tools.map((t) =>
      t.kind === 'custom'
        ? { type: 'custom', name: t.name, ...(t.description ? { description: t.description } : {}) }
        : {
            type: 'function',
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.schema as Json,
          },
    );
    if (ir.toolChoice)
      out.tool_choice =
        typeof ir.toolChoice === 'object'
          ? { type: 'function', name: ir.toolChoice.name }
          : ir.toolChoice;
    if (ir.parallelToolCalls === false) out.parallel_tool_calls = false;
  }
  return out;
}

/* ------------------------------- Gemini ------------------------------- */

function geminiChoice(c: IRToolChoice): Json {
  if (typeof c === 'object') return { mode: 'ANY', allowedFunctionNames: [c.name] };
  return { mode: c === 'required' ? 'ANY' : c === 'none' ? 'NONE' : 'AUTO' };
}

function geminiMedia(p: IRPart): Json | null {
  if (p.data !== undefined)
    return { inlineData: { mimeType: p.mediaType ?? 'image/png', data: p.data } };
  if (p.url) return { fileData: { fileUri: p.url, mimeType: p.mediaType ?? 'image/png' } };
  return null;
}

/** 不含 model：Gemini 的模型放在请求路径里 */
export function encodeGemini(ir: IRRequest): Json {
  const contents: Array<{ role: string; parts: Json[] }> = [];
  const toolNames = new Map<string, string>();
  const push = (role: string, parts: Json[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of ir.messages) {
    const parts: Json[] = [];
    for (const p of m.parts) {
      if (p.kind === 'text') {
        if (p.text) parts.push({ text: p.text });
      } else if (p.kind === 'image' || p.kind === 'file') {
        const media = geminiMedia(p);
        if (media) parts.push(media);
      } else if (p.kind === 'tool_call') {
        toolNames.set(p.id ?? '', p.name ?? '');
        parts.push({ functionCall: { name: p.name ?? '', args: argsObject(p.args) } });
      } else if (p.kind === 'tool_result') {
        const id = p.callId ?? '';
        parts.push({
          functionResponse: {
            name: toolNames.get(id) ?? id,
            response: p.isError ? { error: p.text ?? '' } : { content: p.text ?? '' },
          },
        });
        for (const img of p.images ?? []) {
          if (img.data !== undefined)
            parts.push({ inlineData: { mimeType: img.mediaType ?? 'image/png', data: img.data } });
        }
      }
    }
    push(m.role === 'assistant' ? 'model' : 'user', parts);
  }
  const out: Record<string, Json> = { contents: contents as unknown as Json };
  const sys = systemJoined(ir, '\n');
  if (sys) out.systemInstruction = { parts: [{ text: sys }] };
  const gen: Record<string, Json> = {};
  if (ir.maxTokens !== undefined) gen.maxOutputTokens = ir.maxTokens;
  if (ir.temperature !== undefined) gen.temperature = ir.temperature;
  if (ir.topP !== undefined) gen.topP = ir.topP;
  if (ir.stop?.length) gen.stopSequences = ir.stop;
  if (Object.keys(gen).length) out.generationConfig = gen;
  if (ir.tools.length) {
    out.tools = [
      {
        functionDeclarations: ir.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          // 完整 JSON Schema（Gemini 的 parameters 只接受 OpenAPI 子集）
          parametersJsonSchema: t.schema as Json,
        })),
      },
    ];
    if (ir.toolChoice) out.toolConfig = { functionCallingConfig: geminiChoice(ir.toolChoice) };
  }
  return out;
}

/* ---------------------------- Anthropic Messages ---------------------------- */

function anthropicImage(p: IRPart): Json {
  return p.data !== undefined
    ? {
        type: 'image',
        source: { type: 'base64', media_type: p.mediaType ?? 'image/png', data: p.data },
      }
    : { type: 'image', source: { type: 'url', url: p.url ?? '' } };
}

function anthropicBlock(p: IRPart): Json | null {
  switch (p.kind) {
    case 'text':
      return p.text ? { type: 'text', text: p.text } : null;
    case 'image':
      return anthropicImage(p);
    case 'tool_call':
      return { type: 'tool_use', id: p.id ?? '', name: p.name ?? '', input: argsObject(p.args) };
    case 'tool_result': {
      const images = (p.images ?? []).map(anthropicImage);
      return {
        type: 'tool_result',
        tool_use_id: p.callId ?? '',
        content: images.length
          ? [...(p.text ? [{ type: 'text', text: p.text }] : []), ...images]
          : (p.text ?? ''),
        ...(p.isError ? { is_error: true } : {}),
      };
    }
    case 'thinking':
      // 只有 Anthropic 签过名的推理能发回去；签名与供应商的匹配由网关在编码前处理（§9.3）
      if (p.sealed?.by === 'messages') return p.sealed.raw as Json;
      if (p.signature && !p.sealed)
        return { type: 'thinking', thinking: p.text ?? '', signature: p.signature };
      return null;
    default:
      return null;
  }
}

export function encodeMessages(ir: IRRequest, model?: string): Json {
  // 按编码结果合并：丢掉的部分（无签名推理等）不能让 user / assistant 失去交替
  const messages: Array<{ role: IRMessage['role']; content: Json[] }> = [];
  for (const m of ir.messages) {
    const blocks = m.parts.map(anthropicBlock).filter((b): b is Json => b !== null);
    if (!blocks.length) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks);
    else messages.push({ role: m.role, content: blocks });
  }
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const isResult = (b: Json) => (b as { type?: unknown }).type === 'tool_result';
    if (m.content.some(isResult))
      m.content = [...m.content.filter(isResult), ...m.content.filter((b) => !isResult(b))];
  }
  const out: Record<string, Json> = {
    model: model || ir.model,
    messages: messages as unknown as Json,
    max_tokens: ir.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: ir.stream,
  };
  const sys = systemJoined(ir, '\n\n');
  if (sys) out.system = sys;
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.stop?.length) out.stop_sequences = ir.stop;
  if (ir.tools.length) {
    out.tools = ir.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.schema as Json,
    }));
    const c = ir.toolChoice;
    let choice: Record<string, Json> | undefined =
      c === undefined
        ? undefined
        : typeof c === 'object'
          ? { type: 'tool', name: c.name }
          : { type: c === 'required' ? 'any' : c };
    if (ir.parallelToolCalls === false)
      choice = { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
    if (choice) out.tool_choice = choice;
  }
  return out;
}
