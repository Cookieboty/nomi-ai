/**
 * Map `@nomi-ai/bundle-ig-base` ToolDefinition → Vercel AI SDK `tool()`.
 */
import type { ToolCallProvider, ToolDefinition } from '@nomi-ai/bundle-ig-base';
import { jsonSchema, tool, type Tool } from 'ai';
import type { ZodType } from 'zod';

function toFlexibleSchema(input: unknown) {
  // ToolDefinition.input is a zod schema, AI SDK Schema (jsonSchema()), or raw JSON Schema.
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if ('safeParse' in o || 'validate' in o || '~standard' in o) {
      return input as ZodType;
    }
    if ('type' in o || 'properties' in o || '$schema' in o) {
      return jsonSchema(input as never);
    }
  }
  return jsonSchema({
    type: 'object',
    additionalProperties: true,
  });
}

/**
 * @param provider 跑这轮工具循环的 provider：工具结果会发给它，随 ctx 交给工具做隐私判断
 */
export function toAiSdkTool(def: ToolDefinition, provider?: ToolCallProvider): Tool {
  return tool({
    description: def.description,
    inputSchema: toFlexibleSchema(def.input),
    execute: async (input, { abortSignal }) =>
      def.execute(input, { signal: abortSignal, ...(provider ? { provider } : {}) }),
  });
}

export function toAiSdkToolSet(
  defs: ToolDefinition[],
  provider?: ToolCallProvider,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const def of defs) {
    out[def.name] = toAiSdkTool(def, provider);
  }
  return out;
}
