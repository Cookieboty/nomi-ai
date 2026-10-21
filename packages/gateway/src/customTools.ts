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
