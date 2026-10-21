/** Responses 请求里 type=custom（Codex 自由文本工具）的工具名：模型回调时要还原为 custom_tool_call */
export function customToolNames(body: unknown): Set<string> {
  const tools = (body as { tools?: unknown } | null)?.tools;
  const out = new Set<string>();
  if (!Array.isArray(tools)) return out;
  for (const t of tools as Array<{ type?: unknown; name?: unknown }>) {
    if (t && t.type === 'custom' && typeof t.name === 'string') out.add(t.name);
  }
  return out;
}

/* ------------------- custom tool 被拒（docs/design/unified-gateway.md §11.3） ------------------- */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** 自由文本工具转成函数后的参数 schema（与 IR 转换一致） */
const CUSTOM_AS_FUNCTION_SCHEMA = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
};

const REFUSED =
  /unsupported|not\s+supported|does\s+not\s+support|invalid|unknown|not\s+allowed|不支持/i;

/** 请求体里有 type=custom 的工具 */
export function hasCustomTools(body: unknown): boolean {
  return customToolNames(body).size > 0;
}

/**
 * Responses 上游拒绝 custom 工具的 400（「Unsupported custom tool」「Invalid value: 'custom'」
 * 「tool type custom is not supported」等）。sent 是发出的请求体：传了就要求它确实带 custom 工具。
 */
export function isCustomToolRefusal(status: number, text: string, sent?: unknown): boolean {
  if (status !== 400 && status !== 422) return false;
  if (sent !== undefined && !hasCustomTools(sent)) return false;
  if (!REFUSED.test(text)) return false;
  return (
    /custom[\s_-]*tools?/i.test(text) ||
    /custom_tool_call/i.test(text) ||
    /tool\s+type\s+['"`]?custom/i.test(text) ||
    (/['"`]custom['"`]/.test(text) && /type|tool|supported\s+values/i.test(text))
  );
}

/**
 * 转换模式：把 Responses 请求体里的 custom 工具改成参数为 {input:string} 的函数，
 * 历史里的 custom_tool_call / custom_tool_call_output 与 tool_choice 一并改写。
 * 回程用 customToolNames(原请求体) 交给 ResponsesEncoder / 聚合器还原为 custom_tool_call。
 * 返回浅拷贝；没有 custom 工具时原样返回。
 */
export function customToolsToFunctions(body: unknown): unknown {
  if (!isObj(body) || !hasCustomTools(body)) return body;
  const o: Obj = { ...body };
  o.tools = (body.tools as unknown[]).map((t) =>
    isObj(t) && t.type === 'custom'
      ? {
          type: 'function',
          name: t.name,
          ...(typeof t.description === 'string' ? { description: t.description } : {}),
          parameters: CUSTOM_AS_FUNCTION_SCHEMA,
        }
      : t,
  );
  if (isObj(o.tool_choice) && o.tool_choice.type === 'custom')
    o.tool_choice = { ...o.tool_choice, type: 'function' };
  if (Array.isArray(o.input)) {
    o.input = o.input.map((it) => {
      if (!isObj(it)) return it;
      if (it.type === 'custom_tool_call') {
        const { input, ...rest } = it;
        return {
          ...rest,
          type: 'function_call',
          arguments: JSON.stringify({ input: typeof input === 'string' ? input : '' }),
        };
      }
      if (it.type === 'custom_tool_call_output') return { ...it, type: 'function_call_output' };
      return it;
    });
  }
  return o;
}
