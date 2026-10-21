/**
 * 本地路由：CLI 原生协议 ↔ 上游协议 的请求体与非流式响应转换。
 * 流式（SSE）转换见 ./stream。
 *
 * 请求方向以 Anthropic Messages 为中间形态：
 *   Messages → Chat / Responses / Gemini
 *   Responses → Messages（→ Chat）
 *   Chat → Messages
 * 覆盖：system、文本、图片、工具定义、tool_choice、历史工具调用与结果、max tokens、采样参数。
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

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

function parseArgs(v: unknown): Json {
  if (v && typeof v === 'object') return v as Json;
  if (typeof v !== 'string' || !v.trim()) return {};
  try {
    const p: unknown = JSON.parse(v);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Json) : { value: p as Json };
  } catch {
    return { _raw: v };
  }
}

const EMPTY_SCHEMA: Json = { type: 'object', properties: {} };

/* ------------------------------ 图片 ------------------------------ */

interface ImageRef {
  mediaType?: string;
  data?: string;
  url?: string;
}

function parseDataUrl(u: string): ImageRef {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/.exec(u);
  if (m) return { mediaType: m[1] || 'image/png', data: m[2] };
  return { url: u };
}

function anthropicImageToRef(b: Obj): ImageRef | null {
  const src = asObj(b.source);
  if (src.type === 'base64')
    return { mediaType: str(src.media_type) || 'image/png', data: str(src.data) };
  if (src.type === 'url') return { url: str(src.url) };
  return null;
}

function refToDataUrl(r: ImageRef): string {
  return r.data !== undefined
    ? `data:${r.mediaType ?? 'image/png'};base64,${r.data}`
    : (r.url ?? '');
}

function refToAnthropic(r: ImageRef): Json {
  return r.data !== undefined
    ? {
        type: 'image',
        source: { type: 'base64', media_type: r.mediaType ?? 'image/png', data: r.data },
      }
    : { type: 'image', source: { type: 'url', url: r.url ?? '' } };
}

/* ------------------------- Anthropic 公共读取 ------------------------- */

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  return asArr(system)
    .map((b) => str(b.text))
    .filter(Boolean)
    .join('\n');
}

function blocksOf(content: unknown): Obj[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return asArr(content);
}

/** tool_result.content → 纯文本 + 图片 */
function toolResultParts(b: Obj): { text: string; images: ImageRef[] } {
  if (typeof b.content === 'string') return { text: b.content, images: [] };
  const images: ImageRef[] = [];
  const texts: string[] = [];
  for (const c of asArr(b.content)) {
    if (c.type === 'text') texts.push(str(c.text));
    else if (c.type === 'image') {
      const r = anthropicImageToRef(c);
      if (r) images.push(r);
    }
  }
  let text = texts.join('\n');
  if (b.is_error === true && text && !/^error/i.test(text)) text = `Error: ${text}`;
  return { text, images };
}

interface AnthropicTool {
  name: string;
  description?: string;
  schema: Json;
}

function anthropicTools(tools: unknown): AnthropicTool[] {
  return asArr(tools)
    .filter(
      (t) =>
        str(t.name) &&
        (t.input_schema !== undefined || t.type === undefined || t.type === 'custom'),
    )
    .map((t) => ({
      name: str(t.name),
      description: str(t.description) || undefined,
      schema: (t.input_schema as Json) ?? EMPTY_SCHEMA,
    }));
}

type ChoiceKind = { mode: 'auto' | 'required' | 'none' } | { mode: 'tool'; name: string };

function anthropicChoice(tc: unknown): { choice?: ChoiceKind; parallel?: boolean } {
  const c = asObj(tc);
  const parallel = c.disable_parallel_tool_use === true ? false : undefined;
  switch (c.type) {
    case 'auto':
      return { choice: { mode: 'auto' }, parallel };
    case 'any':
      return { choice: { mode: 'required' }, parallel };
    case 'none':
      return { choice: { mode: 'none' }, parallel };
    case 'tool':
      return { choice: { mode: 'tool', name: str(c.name) }, parallel };
    default:
      return { parallel };
  }
}

/* ------------------------ Messages → Chat Completions ------------------------ */

export function messagesToChatCompletions(body: unknown, model?: string): Json {
  const b = asObj(body);
  const messages: Json[] = [];
  const sys = systemText(b.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of asArr(b.messages)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksOf(m.content);
    if (role === 'assistant') {
      const text = blocks
        .filter((c) => c.type === 'text')
        .map((c) => str(c.text))
        .join('');
      const toolCalls: Json[] = blocks
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({
          id: str(c.id),
          type: 'function',
          function: { name: str(c.name), arguments: JSON.stringify(c.input ?? {}) },
        }));
      const msg: Record<string, Json> = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (text || toolCalls.length) messages.push(msg);
      continue;
    }
    // user：tool_result 必须先于其他内容成为独立 tool 消息
    const parts: Json[] = [];
    const extraImages: ImageRef[] = [];
    for (const c of blocks) {
      if (c.type === 'tool_result') {
        const r = toolResultParts(c);
        messages.push({
          role: 'tool',
          tool_call_id: str(c.tool_use_id),
          content: r.text || '(no output)',
        });
        extraImages.push(...r.images);
      } else if (c.type === 'text') {
        parts.push({ type: 'text', text: str(c.text) });
      } else if (c.type === 'image') {
        const r = anthropicImageToRef(c);
        if (r) parts.push({ type: 'image_url', image_url: { url: refToDataUrl(r) } });
      }
    }
    for (const r of extraImages)
      parts.push({ type: 'image_url', image_url: { url: refToDataUrl(r) } });
    if (!parts.length) continue;
    const onlyText = parts.every((p) => (p as Obj).type === 'text');
    messages.push({
      role: 'user',
      content: onlyText ? parts.map((p) => str((p as Obj).text)).join('') : parts,
    });
  }

  const out: Record<string, Json> = {
    model: model || str(b.model),
    messages,
    stream: Boolean(b.stream),
  };
  if (typeof b.max_tokens === 'number') out.max_tokens = b.max_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length)
    out.stop = b.stop_sequences as Json;
  const tools = anthropicTools(b.tools);
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.schema,
      },
    }));
    const { choice, parallel } = anthropicChoice(b.tool_choice);
    if (choice) {
      out.tool_choice =
        choice.mode === 'tool'
          ? { type: 'function', function: { name: choice.name } }
          : choice.mode;
    }
    if (parallel === false) out.parallel_tool_calls = false;
  }
  return out;
}

/* --------------------------- Messages → Responses --------------------------- */

export function messagesToResponses(body: unknown, model?: string): Json {
  const b = asObj(body);
  const input: Json[] = [];
  for (const m of asArr(b.messages)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksOf(m.content);
    let parts: Json[] = [];
    const flush = () => {
      if (!parts.length) return;
      input.push(
        role === 'assistant'
          ? { type: 'message', role: 'assistant', content: parts }
          : { type: 'message', role: 'user', content: parts },
      );
      parts = [];
    };
    for (const c of blocks) {
      if (c.type === 'text') {
        parts.push({
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: str(c.text),
        });
      } else if (c.type === 'image' && role === 'user') {
        const r = anthropicImageToRef(c);
        if (r) parts.push({ type: 'input_image', image_url: refToDataUrl(r) });
      } else if (c.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call',
          call_id: str(c.id),
          name: str(c.name),
          arguments: JSON.stringify(c.input ?? {}),
        });
      } else if (c.type === 'tool_result') {
        flush();
        const r = toolResultParts(c);
        input.push({ type: 'function_call_output', call_id: str(c.tool_use_id), output: r.text });
        for (const img of r.images)
          parts.push({ type: 'input_image', image_url: refToDataUrl(img) });
      }
    }
    flush();
  }
  const out: Record<string, Json> = {
    model: model || str(b.model),
    input,
    stream: Boolean(b.stream),
    store: false,
  };
  const sys = systemText(b.system);
  if (sys) out.instructions = sys;
  if (typeof b.max_tokens === 'number') out.max_output_tokens = b.max_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  const tools = anthropicTools(b.tools);
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.schema,
    }));
    const { choice, parallel } = anthropicChoice(b.tool_choice);
    if (choice)
      out.tool_choice =
        choice.mode === 'tool' ? { type: 'function', name: choice.name } : choice.mode;
    if (parallel === false) out.parallel_tool_calls = false;
  }
  return out;
}

/* ---------------------------- Messages → Gemini ---------------------------- */

/** 不含 model：Gemini 的模型放在 URL 路径里 */
export function messagesToGemini(body: unknown, _model?: string): Json {
  const b = asObj(body);
  const contents: Array<{ role: string; parts: Json[] }> = [];
  const toolNames = new Map<string, string>();
  const push = (role: string, parts: Json[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of asArr(b.messages)) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Json[] = [];
    for (const c of blocksOf(m.content)) {
      if (c.type === 'text' && str(c.text)) parts.push({ text: str(c.text) });
      else if (c.type === 'image') {
        const r = anthropicImageToRef(c);
        if (r?.data !== undefined)
          parts.push({ inlineData: { mimeType: r.mediaType ?? 'image/png', data: r.data } });
        else if (r?.url)
          parts.push({ fileData: { fileUri: r.url, mimeType: r.mediaType ?? 'image/png' } });
      } else if (c.type === 'tool_use') {
        toolNames.set(str(c.id), str(c.name));
        parts.push({ functionCall: { name: str(c.name), args: (c.input as Json) ?? {} } });
      } else if (c.type === 'tool_result') {
        const r = toolResultParts(c);
        const id = str(c.tool_use_id);
        parts.push({
          functionResponse: {
            name: toolNames.get(id) ?? id,
            response: c.is_error === true ? { error: r.text } : { content: r.text },
          },
        });
        for (const img of r.images) {
          if (img.data !== undefined)
            parts.push({ inlineData: { mimeType: img.mediaType ?? 'image/png', data: img.data } });
        }
      }
    }
    push(role, parts);
  }
  const out: Record<string, Json> = { contents: contents as unknown as Json };
  const sys = systemText(b.system);
  if (sys) out.systemInstruction = { parts: [{ text: sys }] };
  const gen: Record<string, Json> = {};
  if (typeof b.max_tokens === 'number') gen.maxOutputTokens = b.max_tokens;
  if (typeof b.temperature === 'number') gen.temperature = b.temperature;
  if (typeof b.top_p === 'number') gen.topP = b.top_p;
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length)
    gen.stopSequences = b.stop_sequences as Json;
  if (Object.keys(gen).length) out.generationConfig = gen;
  const tools = anthropicTools(b.tools);
  if (tools.length) {
    out.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          // 完整 JSON Schema（Gemini 的 parameters 只接受 OpenAPI 子集）
          parametersJsonSchema: t.schema,
        })),
      },
    ];
    const { choice } = anthropicChoice(b.tool_choice);
    if (choice) {
      out.toolConfig = {
        functionCallingConfig:
          choice.mode === 'tool'
            ? { mode: 'ANY', allowedFunctionNames: [choice.name] }
            : {
                mode: choice.mode === 'required' ? 'ANY' : choice.mode === 'none' ? 'NONE' : 'AUTO',
              },
      };
    }
  }
  return out;
}

/* ------------------------- Anthropic 消息组装工具 ------------------------- */

/** 合并相邻同角色消息（Anthropic 要求 user/assistant 交替，tool_result 紧随 tool_use） */
function pushMessage(
  messages: Array<{ role: string; content: Json[] }>,
  role: string,
  blocks: Json[],
) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else messages.push({ role, content: [...blocks] });
}

/** user 消息里 tool_result 需排在最前 */
function orderToolResultsFirst(messages: Array<{ role: string; content: Json[] }>) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const results = m.content.filter((c) => asObj(c).type === 'tool_result');
    if (!results.length) continue;
    m.content = [...results, ...m.content.filter((c) => asObj(c).type !== 'tool_result')];
  }
}

const DEFAULT_MAX_TOKENS = 8192;

/* --------------------------- Responses → Messages --------------------------- */

function responsesContentToBlocks(content: unknown): Json[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: Json[] = [];
  for (const c of asArr(content)) {
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') {
      if (str(c.text)) out.push({ type: 'text', text: str(c.text) });
    } else if (c.type === 'input_image') {
      const url = str(c.image_url) || str(asObj(c.image_url).url);
      if (url) out.push(refToAnthropic(parseDataUrl(url)));
    } else if (c.type === 'refusal' && str(c.refusal)) {
      out.push({ type: 'text', text: str(c.refusal) });
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

/** 不设默认 max_tokens 的内部版本 */
function responsesToMessagesCore(body: unknown, model?: string): Record<string, Json> {
  const b = asObj(body);
  const sys: string[] = [];
  if (str(b.instructions)) sys.push(str(b.instructions));
  const messages: Array<{ role: string; content: Json[] }> = [];
  const items: Obj[] =
    typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : asArr(b.input);
  for (const it of items) {
    const type = str(it.type) || 'message';
    if (type === 'message') {
      const role = str(it.role) || 'user';
      const blocks = responsesContentToBlocks(it.content);
      if (role === 'system' || role === 'developer') {
        const t = blocks.map((x) => str(asObj(x).text)).join('');
        if (t) sys.push(t);
        continue;
      }
      pushMessage(messages, role === 'assistant' ? 'assistant' : 'user', blocks);
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      pushMessage(messages, 'assistant', [
        {
          type: 'tool_use',
          id: str(it.call_id) || str(it.id),
          name: str(it.name),
          input: type === 'custom_tool_call' ? { input: str(it.input) } : parseArgs(it.arguments),
        },
      ]);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      pushMessage(messages, 'user', [
        { type: 'tool_result', tool_use_id: str(it.call_id), content: outputToText(it.output) },
      ]);
    }
    // reasoning / web_search_call 等无对应项，丢弃
  }
  orderToolResultsFirst(messages);
  const out: Record<string, Json> = {
    model: model || str(b.model),
    messages: messages as unknown as Json,
    stream: Boolean(b.stream),
  };
  if (sys.length) out.system = sys.join('\n\n');
  if (typeof b.max_output_tokens === 'number') out.max_tokens = b.max_output_tokens;
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  const tools: Json[] = [];
  for (const t of asArr(b.tools)) {
    if (t.type === 'function' && str(t.name)) {
      tools.push({
        name: str(t.name),
        ...(str(t.description) ? { description: str(t.description) } : {}),
        input_schema: (t.parameters as Json) ?? EMPTY_SCHEMA,
      });
    } else if (t.type === 'custom' && str(t.name)) {
      // 自由文本工具 → 单字符串参数
      tools.push({
        name: str(t.name),
        ...(str(t.description) ? { description: str(t.description) } : {}),
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      });
    }
  }
  if (tools.length) {
    out.tools = tools;
    const tc = b.tool_choice;
    const tco = asObj(tc);
    let choice: Record<string, Json> | undefined;
    if (tc === 'auto') choice = { type: 'auto' };
    else if (tc === 'required') choice = { type: 'any' };
    else if (tc === 'none') choice = { type: 'none' };
    else if ((tco.type === 'function' || tco.type === 'custom') && str(tco.name)) {
      choice = { type: 'tool', name: str(tco.name) };
    }
    if (b.parallel_tool_calls === false) {
      choice = { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
    }
    if (choice) out.tool_choice = choice;
  }
  return out;
}

export function responsesToMessages(body: unknown, model?: string): Json {
  const out = responsesToMessagesCore(body, model);
  if (out.max_tokens === undefined) out.max_tokens = DEFAULT_MAX_TOKENS;
  return out;
}

/** OpenAI Responses → Chat Completions */
export function responsesToChatCompletions(body: unknown, model?: string): Json {
  return messagesToChatCompletions(responsesToMessagesCore(body, model), model);
}

/* ------------------------ Chat Completions → Messages ------------------------ */

function chatContentToBlocks(content: unknown): Json[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: Json[] = [];
  for (const c of asArr(content)) {
    if (c.type === 'text' && str(c.text)) out.push({ type: 'text', text: str(c.text) });
    else if (c.type === 'image_url') {
      const url = str(asObj(c.image_url).url) || str(c.image_url);
      if (url) out.push(refToAnthropic(parseDataUrl(url)));
    }
  }
  return out;
}

export function chatCompletionsToMessages(body: unknown, model?: string): Json {
  const b = asObj(body);
  const sys: string[] = [];
  const messages: Array<{ role: string; content: Json[] }> = [];
  for (const m of asArr(b.messages)) {
    const role = str(m.role) || 'user';
    if (role === 'system' || role === 'developer') {
      const t = chatContentToBlocks(m.content)
        .map((x) => str(asObj(x).text))
        .join('');
      if (t) sys.push(t);
    } else if (role === 'assistant') {
      const blocks = chatContentToBlocks(m.content);
      for (const tc of asArr(m.tool_calls)) {
        const fn = asObj(tc.function);
        blocks.push({
          type: 'tool_use',
          id: str(tc.id),
          name: str(fn.name),
          input: parseArgs(fn.arguments),
        });
      }
      pushMessage(messages, 'assistant', blocks);
    } else if (role === 'tool') {
      const text = chatContentToBlocks(m.content)
        .map((x) => str(asObj(x).text))
        .join('');
      pushMessage(messages, 'user', [
        { type: 'tool_result', tool_use_id: str(m.tool_call_id), content: text },
      ]);
    } else {
      pushMessage(messages, 'user', chatContentToBlocks(m.content));
    }
  }
  orderToolResultsFirst(messages);
  const maxTokens =
    typeof b.max_completion_tokens === 'number'
      ? b.max_completion_tokens
      : typeof b.max_tokens === 'number'
        ? b.max_tokens
        : DEFAULT_MAX_TOKENS;
  const out: Record<string, Json> = {
    model: model || str(b.model),
    messages: messages as unknown as Json,
    max_tokens: maxTokens,
    stream: Boolean(b.stream),
  };
  if (sys.length) out.system = sys.join('\n\n');
  if (typeof b.temperature === 'number') out.temperature = b.temperature;
  if (typeof b.top_p === 'number') out.top_p = b.top_p;
  if (typeof b.stop === 'string') out.stop_sequences = [b.stop];
  else if (Array.isArray(b.stop) && b.stop.length) out.stop_sequences = b.stop as Json;
  const tools: Json[] = asArr(b.tools)
    .filter((t) => t.type === 'function' && str(asObj(t.function).name))
    .map((t) => {
      const fn = asObj(t.function);
      return {
        name: str(fn.name),
        ...(str(fn.description) ? { description: str(fn.description) } : {}),
        input_schema: (fn.parameters as Json) ?? EMPTY_SCHEMA,
      };
    });
  if (tools.length) {
    out.tools = tools;
    const tc = b.tool_choice;
    const tco = asObj(tc);
    let choice: Record<string, Json> | undefined;
    if (tc === 'auto') choice = { type: 'auto' };
    else if (tc === 'required') choice = { type: 'any' };
    else if (tc === 'none') choice = { type: 'none' };
    else if (tco.type === 'function' && str(asObj(tco.function).name)) {
      choice = { type: 'tool', name: str(asObj(tco.function).name) };
    }
    if (b.parallel_tool_calls === false) {
      choice = { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
    }
    if (choice) out.tool_choice = choice;
  }
  return out;
}

/** Chat Completions → OpenAI Responses */
export function chatCompletionsToResponses(body: unknown, model?: string): Json {
  return messagesToResponses(chatCompletionsToMessages(body, model), model);
}

/** 将上游 Chat Completions 非流式响应转成 Anthropic Messages 形状 */
export function chatCompletionsResponseToMessages(upstream: unknown): Json {
  const u = asObj(upstream);
  const choices = Array.isArray(u.choices) ? (u.choices as Array<Record<string, unknown>>) : [];
  const msg = asObj(choices[0]?.message);
  const text = typeof msg.content === 'string' ? msg.content : '';
  return {
    id: String(u.id ?? 'msg_nomi'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: String(u.model ?? ''),
    stop_reason: 'end_turn',
  };
}

/** 将上游 Responses 非流式响应转成 Anthropic Messages */
export function responsesResponseToMessages(upstream: unknown): Json {
  const u = asObj(upstream);
  let text = '';
  const output = Array.isArray(u.output) ? (u.output as Array<Record<string, unknown>>) : [];
  for (const item of output) {
    const content = Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>)
      : [];
    for (const c of content) {
      if (c.type === 'output_text' || c.type === 'text') text += String(c.text ?? '');
    }
  }
  if (!text && typeof u.output_text === 'string') text = u.output_text;
  return {
    id: String(u.id ?? 'msg_nomi'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: String(u.model ?? ''),
    stop_reason: 'end_turn',
  };
}

/** Anthropic Messages 响应 → Chat Completions */
export function messagesResponseToChatCompletions(upstream: unknown): Json {
  const u = asObj(upstream);
  let text = '';
  if (Array.isArray(u.content)) {
    text = (u.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === 'text')
      .map((c) => String(c.text ?? ''))
      .join('');
  }
  return {
    id: String(u.id ?? 'chatcmpl_nomi'),
    object: 'chat.completion',
    model: String(u.model ?? ''),
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

/** Anthropic Messages 响应 → Responses */
export function messagesResponseToResponses(upstream: unknown): Json {
  const u = asObj(upstream);
  let text = '';
  if (Array.isArray(u.content)) {
    text = (u.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === 'text')
      .map((c) => String(c.text ?? ''))
      .join('');
  }
  return {
    id: String(u.id ?? 'resp_nomi'),
    object: 'response',
    model: String(u.model ?? ''),
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    output_text: text,
  };
}

export function chatCompletionsResponseToResponses(upstream: unknown): Json {
  return messagesResponseToResponses(chatCompletionsResponseToMessages(upstream));
}

export function responsesResponseToChatCompletions(upstream: unknown): Json {
  return messagesResponseToChatCompletions(responsesResponseToMessages(upstream));
}

/** Gemini generateContent 响应 → Anthropic Messages */
export function geminiResponseToMessages(upstream: unknown): Json {
  const u = asObj(upstream);
  const candidates = Array.isArray(u.candidates)
    ? (u.candidates as Array<Record<string, unknown>>)
    : [];
  const content = asObj(candidates[0]?.content);
  const parts = Array.isArray(content.parts)
    ? (content.parts as Array<Record<string, unknown>>)
    : [];
  const text = parts.map((p) => String(p.text ?? '')).join('');
  return {
    id: 'msg_nomi_gemini',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: '',
    stop_reason: 'end_turn',
  };
}
