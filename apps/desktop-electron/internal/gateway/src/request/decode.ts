/**
 * 入口请求 → IR。
 * 每个解码器保留原 transforms.ts 对应方向的细节（system 的拼接方式、默认值、工具参数的规整化等），
 * 让「解码 → 编码」与原来的两两转换输出一致。
 */
import type { IRMessage, IRPart, IRRequest, IRTool, IRToolChoice } from '../ir';
import { unescapeCallId } from '../models/rules/response/callIds';
import {
  asArr,
  asObj,
  CUSTOM_TOOL_SCHEMA,
  DEFAULT_MAX_TOKENS,
  EMPTY_SCHEMA,
  num,
  parseArgs,
  parseDataUrl,
  str,
  type Obj,
} from '../util';

/* ------------------------------ 公共 ------------------------------ */

/** 工具调用 id：网关回程按协议格式改写过的（§6.9.7）还原成上游原来的 id */
const cid = (v: unknown): string => unescapeCallId(str(v));

/** 合并相邻同角色消息；空的不加 */
function pushMessage(messages: IRMessage[], role: IRMessage['role'], parts: IRPart[]) {
  if (!parts.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else messages.push({ role, parts: [...parts] });
}

/** user 消息里 tool_result 排在最前（Anthropic 要求 tool_result 紧随 tool_use） */
function orderToolResultsFirst(messages: IRMessage[]) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const results = m.parts.filter((p) => p.kind === 'tool_result');
    if (!results.length) continue;
    m.parts = [...results, ...m.parts.filter((p) => p.kind !== 'tool_result')];
  }
}

function imagePart(r: { mediaType?: string; data?: string; url?: string }): IRPart {
  return {
    kind: 'image',
    ...(r.mediaType !== undefined ? { mediaType: r.mediaType } : {}),
    ...(r.data !== undefined ? { data: r.data } : {}),
    ...(r.url !== undefined ? { url: r.url } : {}),
  };
}

/** 没指定工具选择、却禁止了并行时，原实现补的是 auto（Responses / Chat 入口） */
function choiceWithParallel(
  choice: IRToolChoice | undefined,
  parallel: unknown,
): { toolChoice?: IRToolChoice; parallelToolCalls?: boolean } {
  if (parallel === false) return { toolChoice: choice ?? 'auto', parallelToolCalls: false };
  return choice ? { toolChoice: choice } : {};
}

function openAiChoice(tc: unknown, nameOf: (o: Obj) => string): IRToolChoice | undefined {
  if (tc === 'auto' || tc === 'required' || tc === 'none') return tc;
  const name = nameOf(asObj(tc));
  return name ? { name } : undefined;
}

/* ---------------------------- Anthropic Messages ---------------------------- */

function anthropicImage(b: Obj): IRPart | null {
  const src = asObj(b.source);
  if (src.type === 'base64')
    return imagePart({ mediaType: str(src.media_type) || 'image/png', data: str(src.data) });
  if (src.type === 'url') return imagePart({ url: str(src.url) });
  return null;
}

/** tool_result.content → 文本 + 图片；出错时文本加 Error: 前缀 */
function anthropicToolResult(b: Obj): IRPart {
  let text: string;
  const images: IRPart[] = [];
  if (typeof b.content === 'string') text = b.content;
  else {
    const texts: string[] = [];
    for (const c of asArr(b.content)) {
      if (c.type === 'text') texts.push(str(c.text));
      else if (c.type === 'image') {
        const img = anthropicImage(c);
        if (img) images.push(img);
      }
    }
    text = texts.join('\n');
    if (b.is_error === true && text && !/^error/i.test(text)) text = `Error: ${text}`;
  }
  return {
    kind: 'tool_result',
    callId: cid(b.tool_use_id),
    text,
    ...(images.length ? { images } : {}),
    ...(b.is_error === true ? { isError: true } : {}),
  };
}

function anthropicBlock(c: Obj): IRPart | null {
  switch (c.type) {
    case 'text':
      return { kind: 'text', text: str(c.text) };
    case 'image':
      return anthropicImage(c);
    case 'tool_use':
      return {
        kind: 'tool_call',
        id: cid(c.id),
        name: str(c.name),
        args: JSON.stringify(c.input ?? {}),
      };
    case 'tool_result':
      return anthropicToolResult(c);
    case 'thinking':
      return {
        kind: 'thinking',
        text: str(c.thinking),
        ...(str(c.signature) ? { signature: str(c.signature) } : {}),
      };
    case 'redacted_thinking':
      return { kind: 'thinking', sealed: { by: 'messages', raw: c } };
    default:
      return null;
  }
}

export function decodeMessages(body: unknown): IRRequest {
  const b = asObj(body);
  const system: IRPart[] =
    typeof b.system === 'string'
      ? b.system
        ? [{ kind: 'text', text: b.system }]
        : []
      : asArr(b.system)
          .map((x) => str(x.text))
          .filter(Boolean)
          .map((text) => ({ kind: 'text' as const, text }));
  // 不合并相邻消息：原实现逐条处理 Messages 的消息
  const messages: IRMessage[] = asArr(b.messages).map((m) => {
    const blocks =
      typeof m.content === 'string'
        ? m.content
          ? [{ type: 'text', text: m.content }]
          : []
        : asArr(m.content);
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      parts: blocks.map(anthropicBlock).filter((p): p is IRPart => p !== null),
    };
  });
  // 服务端工具（web_search 等）没有 input_schema，原样丢弃
  const tools: IRTool[] = asArr(b.tools)
    .filter(
      (t) =>
        str(t.name) &&
        (t.input_schema !== undefined || t.type === undefined || t.type === 'custom'),
    )
    .map((t) => ({
      name: str(t.name),
      ...(str(t.description) ? { description: str(t.description) } : {}),
      schema: t.input_schema ?? EMPTY_SCHEMA,
      kind: 'function' as const,
    }));
  const tc = asObj(b.tool_choice);
  let toolChoice: IRToolChoice | undefined;
  if (tc.type === 'auto') toolChoice = 'auto';
  else if (tc.type === 'any') toolChoice = 'required';
  else if (tc.type === 'none') toolChoice = 'none';
  else if (tc.type === 'tool') toolChoice = { name: str(tc.name) };
  const thinking = asObj(b.thinking);
  const out: IRRequest = {
    model: str(b.model),
    system,
    messages,
    tools,
    stream: Boolean(b.stream),
    ...(toolChoice ? { toolChoice } : {}),
    ...(tc.disable_parallel_tool_use === true ? { parallelToolCalls: false } : {}),
  };
  if (typeof b.max_tokens === 'number') out.maxTokens = b.max_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.topP = b.top_p;
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length)
    out.stop = b.stop_sequences as string[];
  if (thinking.type === 'enabled' && num(thinking.budget_tokens) !== undefined)
    out.reasoning = { budget: num(thinking.budget_tokens) };
  else if (thinking.type === 'disabled') out.reasoning = { off: true };
  return out;
}

/* ------------------------------ OpenAI Responses ------------------------------ */

function responsesContent(content: unknown): IRPart[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  const out: IRPart[] = [];
  for (const c of asArr(content)) {
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
      if (str(c.text)) out.push({ kind: 'text', text: str(c.text) });
    } else if (c.type === 'input_image') {
      const url = str(c.image_url) || str(asObj(c.image_url).url);
      if (url) out.push(imagePart(parseDataUrl(url)));
    } else if (c.type === 'refusal' && str(c.refusal)) {
      out.push({ kind: 'text', text: str(c.refusal) });
    }
  }
  return out;
}

function outputToText(o: unknown): string {
  if (typeof o === 'string') return o;
  const parts = asArr(o);
  if (parts.length) return parts.map((p) => str(p.text)).join('');
  return o === undefined || o === null ? '' : JSON.stringify(o);
}

export function decodeResponses(body: unknown): IRRequest {
  const b = asObj(body);
  const sys: string[] = [];
  if (str(b.instructions)) sys.push(str(b.instructions));
  const messages: IRMessage[] = [];
  const items: Obj[] =
    typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : asArr(b.input);
  for (const it of items) {
    const type = str(it.type) || 'message';
    if (type === 'message') {
      const role = str(it.role) || 'user';
      const parts = responsesContent(it.content);
      if (role === 'system' || role === 'developer') {
        const t = parts.map((p) => p.text ?? '').join('');
        if (t) sys.push(t);
        continue;
      }
      pushMessage(messages, role === 'assistant' ? 'assistant' : 'user', parts);
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const custom = type === 'custom_tool_call';
      pushMessage(messages, 'assistant', [
        {
          kind: 'tool_call',
          id: cid(it.call_id) || cid(it.id),
          name: str(it.name),
          // 先解析再序列化：与原实现经 Messages 中转时的参数规整化一致
          args: JSON.stringify(custom ? { input: str(it.input) } : parseArgs(it.arguments)),
          ...(custom ? { custom: true } : {}),
        },
      ]);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      pushMessage(messages, 'user', [
        { kind: 'tool_result', callId: cid(it.call_id), text: outputToText(it.output) },
      ]);
    } else if (type === 'reasoning') {
      const summary = asArr(it.summary)
        .map((s) => str(s.text))
        .filter(Boolean)
        .join('\n');
      const sealed = str(it.encrypted_content) ? { by: 'responses' as const, raw: it } : undefined;
      if (summary || sealed)
        pushMessage(messages, 'assistant', [
          { kind: 'thinking', text: summary, ...(sealed ? { sealed } : {}) },
        ]);
    }
    // web_search_call 等没有对应项，丢弃
  }
  orderToolResultsFirst(messages);
  const tools: IRTool[] = [];
  for (const t of asArr(b.tools)) {
    if (t.type === 'function' && str(t.name)) {
      tools.push({
        name: str(t.name),
        ...(str(t.description) ? { description: str(t.description) } : {}),
        schema: t.parameters ?? EMPTY_SCHEMA,
        kind: 'function',
      });
    } else if (t.type === 'custom' && str(t.name)) {
      tools.push({
        name: str(t.name),
        ...(str(t.description) ? { description: str(t.description) } : {}),
        schema: CUSTOM_TOOL_SCHEMA,
        kind: 'custom',
      });
    }
  }
  const choice = openAiChoice(b.tool_choice, (o) =>
    o.type === 'function' || o.type === 'custom' ? str(o.name) : '',
  );
  const out: IRRequest = {
    model: str(b.model),
    system: sys.length ? [{ kind: 'text', text: sys.join('\n\n') }] : [],
    messages,
    tools,
    stream: Boolean(b.stream),
    ...choiceWithParallel(choice, b.parallel_tool_calls),
  };
  if (typeof b.max_output_tokens === 'number') out.maxTokens = b.max_output_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.topP = b.top_p;
  const effort = str(asObj(b.reasoning).effort);
  if (effort) out.reasoning = effort === 'none' ? { off: true } : { effort };
  return out;
}

/* --------------------------- OpenAI Chat Completions --------------------------- */

function chatContent(content: unknown): IRPart[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  const out: IRPart[] = [];
  for (const c of asArr(content)) {
    if (c.type === 'text' && str(c.text)) out.push({ kind: 'text', text: str(c.text) });
    else if (c.type === 'image_url') {
      const url = str(asObj(c.image_url).url) || str(c.image_url);
      if (url) out.push(imagePart(parseDataUrl(url)));
    }
  }
  return out;
}

const textOf = (parts: IRPart[]) =>
  parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text ?? '')
    .join('');

export function decodeChat(body: unknown): IRRequest {
  const b = asObj(body);
  const sys: string[] = [];
  const messages: IRMessage[] = [];
  for (const m of asArr(b.messages)) {
    const role = str(m.role) || 'user';
    if (role === 'system' || role === 'developer') {
      const t = textOf(chatContent(m.content));
      if (t) sys.push(t);
    } else if (role === 'assistant') {
      const parts: IRPart[] = [];
      // DeepSeek / Kimi 等思考模式的推理文本（回传规则见 §9.3）
      const reasoning = str(m.reasoning_content) || str(m.reasoning);
      if (reasoning) parts.push({ kind: 'thinking', text: reasoning });
      parts.push(...chatContent(m.content));
      for (const tc of asArr(m.tool_calls)) {
        const fn = asObj(tc.function);
        parts.push({
          kind: 'tool_call',
          id: cid(tc.id),
          name: str(fn.name),
          args: JSON.stringify(parseArgs(fn.arguments)),
        });
      }
      pushMessage(messages, 'assistant', parts);
    } else if (role === 'tool') {
      pushMessage(messages, 'user', [
        { kind: 'tool_result', callId: cid(m.tool_call_id), text: textOf(chatContent(m.content)) },
      ]);
    } else {
      pushMessage(messages, 'user', chatContent(m.content));
    }
  }
  orderToolResultsFirst(messages);
  const tools: IRTool[] = asArr(b.tools)
    .filter((t) => t.type === 'function' && str(asObj(t.function).name))
    .map((t) => {
      const fn = asObj(t.function);
      return {
        name: str(fn.name),
        ...(str(fn.description) ? { description: str(fn.description) } : {}),
        schema: fn.parameters ?? EMPTY_SCHEMA,
        kind: 'function' as const,
      };
    });
  const choice = openAiChoice(b.tool_choice, (o) =>
    o.type === 'function' ? str(asObj(o.function).name) : '',
  );
  const out: IRRequest = {
    model: str(b.model),
    system: sys.length ? [{ kind: 'text', text: sys.join('\n\n') }] : [],
    messages,
    tools,
    stream: Boolean(b.stream),
    // Chat 入口没给上限时按 Messages 的默认值补（原实现经 Messages 中转，结果相同）
    maxTokens: num(b.max_completion_tokens) ?? num(b.max_tokens) ?? DEFAULT_MAX_TOKENS,
    ...choiceWithParallel(choice, b.parallel_tool_calls),
  };
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.topP = b.top_p;
  if (typeof b.stop === 'string') out.stop = [b.stop];
  else if (Array.isArray(b.stop) && b.stop.length) out.stop = b.stop as string[];
  const effort = str(b.reasoning_effort);
  if (effort) out.reasoning = effort === 'none' ? { off: true } : { effort };
  return out;
}

/* ------------------------------- Gemini ------------------------------- */

function geminiFunctionResponse(fr: Obj, callId: string): IRPart {
  const resp = asObj(fr.response);
  const isError = resp.error !== undefined;
  const v = isError ? resp.error : (resp.content ?? resp.output ?? resp.result);
  const text =
    typeof v === 'string'
      ? v
      : v === undefined
        ? JSON.stringify(fr.response ?? {})
        : JSON.stringify(v);
  return { kind: 'tool_result', callId, text, ...(isError ? { isError: true } : {}) };
}

/**
 * Gemini generateContent 请求 → IR。模型名在路径里，由调用方传入；
 * functionResponse 没有 id 时，按工具名对应到最近一次同名调用。
 */
export function decodeGemini(
  body: unknown,
  opts: { model?: string; stream?: boolean } = {},
): IRRequest {
  const b = asObj(body);
  const messages: IRMessage[] = [];
  const pending = new Map<string, string[]>();
  let n = 0;
  for (const c of asArr(b.contents)) {
    const role: IRMessage['role'] = c.role === 'model' ? 'assistant' : 'user';
    const parts: IRPart[] = [];
    for (const p of asArr(asObj(c).parts)) {
      const sig = str(p.thoughtSignature) || undefined;
      if (typeof p.text === 'string') {
        if (p.thought === true)
          parts.push({ kind: 'thinking', text: p.text, ...(sig ? { signature: sig } : {}) });
        else if (p.text)
          parts.push({ kind: 'text', text: p.text, ...(sig ? { signature: sig } : {}) });
      } else if (p.inlineData) {
        const d = asObj(p.inlineData);
        const mediaType = str(d.mimeType) || 'application/octet-stream';
        parts.push({
          kind: mediaType.startsWith('image/') ? 'image' : 'file',
          mediaType,
          data: str(d.data),
        });
      } else if (p.fileData) {
        const d = asObj(p.fileData);
        const mediaType = str(d.mimeType) || undefined;
        parts.push({
          kind: !mediaType || mediaType.startsWith('image/') ? 'image' : 'file',
          ...(mediaType ? { mediaType } : {}),
          url: str(d.fileUri),
        });
      } else if (p.functionCall) {
        const fc = asObj(p.functionCall);
        const name = str(fc.name);
        const id = cid(fc.id) || `call_gemini_${n++}`;
        pending.set(name, [...(pending.get(name) ?? []), id]);
        parts.push({
          kind: 'tool_call',
          id,
          name,
          args: JSON.stringify(fc.args ?? {}),
          ...(sig ? { signature: sig } : {}),
        });
      } else if (p.functionResponse) {
        const fr = asObj(p.functionResponse);
        const name = str(fr.name);
        const queue = pending.get(name) ?? [];
        const callId = cid(fr.id) || queue.shift() || name;
        pending.set(name, queue);
        parts.push(geminiFunctionResponse(fr, callId));
      }
    }
    pushMessage(messages, role, parts);
  }
  orderToolResultsFirst(messages);
  const system: IRPart[] = asArr(asObj(b.systemInstruction).parts)
    .map((p) => str(p.text))
    .filter(Boolean)
    .map((text) => ({ kind: 'text' as const, text }));
  const tools: IRTool[] = [];
  for (const t of asArr(b.tools)) {
    for (const fd of asArr(t.functionDeclarations)) {
      if (!str(fd.name)) continue;
      tools.push({
        name: str(fd.name),
        ...(str(fd.description) ? { description: str(fd.description) } : {}),
        schema: fd.parametersJsonSchema ?? fd.parameters ?? EMPTY_SCHEMA,
        kind: 'function',
      });
    }
  }
  const fcc = asObj(asObj(b.toolConfig).functionCallingConfig);
  const allowed = Array.isArray(fcc.allowedFunctionNames)
    ? (fcc.allowedFunctionNames as unknown[])
    : [];
  let toolChoice: IRToolChoice | undefined;
  if (fcc.mode === 'ANY')
    toolChoice = allowed.length === 1 ? { name: str(allowed[0]) } : 'required';
  else if (fcc.mode === 'NONE') toolChoice = 'none';
  else if (fcc.mode === 'AUTO') toolChoice = 'auto';
  const gen = asObj(b.generationConfig);
  const out: IRRequest = {
    model: opts.model ?? '',
    system,
    messages,
    tools,
    stream: Boolean(opts.stream),
    ...(toolChoice ? { toolChoice } : {}),
  };
  if (num(gen.maxOutputTokens) !== undefined) out.maxTokens = num(gen.maxOutputTokens);
  if (num(gen.temperature) !== undefined) out.temperature = num(gen.temperature);
  if (num(gen.topP) !== undefined) out.topP = num(gen.topP);
  if (Array.isArray(gen.stopSequences) && gen.stopSequences.length)
    out.stop = gen.stopSequences as string[];
  const tcfg = asObj(gen.thinkingConfig);
  const budget = num(tcfg.thinkingBudget);
  if (budget === 0) out.reasoning = { off: true };
  else if (budget !== undefined && budget > 0) out.reasoning = { budget };
  else if (str(tcfg.thinkingLevel))
    out.reasoning = { effort: str(tcfg.thinkingLevel).toLowerCase() };
  return out;
}
