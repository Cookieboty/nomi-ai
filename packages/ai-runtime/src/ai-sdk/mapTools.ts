/**
 * Map `@nomi-ai/bundle-ig-base` ToolDefinition → Vercel AI SDK `tool()`.
 */
import type { ToolCallProvider, ToolDefinition } from '@nomi-ai/bundle-ig-base';
import { getToolCallerTabId } from '@nomi-ai/bundle-ig-base';
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

export type MapToolsOpts = {
  provider?: ToolCallProvider;
  /** 本轮请求 id：写入 ToolExecContext，供委派钉住按 turn 消费 */
  reqId?: string;
  /** 发起工具调用的编程助手标签（MCP/host 传入；缺省时读 ALS） */
  callerTabId?: string;
};

function isMapToolsOpts(v: unknown): v is MapToolsOpts {
  return (
    !!v &&
    typeof v === 'object' &&
    ('provider' in v || 'reqId' in v || 'callerTabId' in v) &&
    !('id' in v)
  );
}

function normalizeOpts(opts?: MapToolsOpts | ToolCallProvider): MapToolsOpts {
  if (!opts) return {};
  if (isMapToolsOpts(opts)) return opts;
  return { provider: opts as ToolCallProvider };
}

/**
 * @param providerOrOpts 跑这轮工具循环的 provider，或 `{ provider, reqId }`
 */
export function toAiSdkTool(
  def: ToolDefinition,
  providerOrOpts?: MapToolsOpts | ToolCallProvider,
): Tool {
  const { provider, reqId, callerTabId } = normalizeOpts(providerOrOpts);
  return tool({
    description: def.description,
    inputSchema: toFlexibleSchema(def.input),
    execute: async (input, { abortSignal, toolCallId }) => {
      const caller = callerTabId ?? getToolCallerTabId();
      return def.execute(input, {
        signal: abortSignal,
        ...(toolCallId ? { toolCallId } : {}),
        ...(provider ? { provider } : {}),
        ...(reqId ? { reqId } : {}),
        ...(caller ? { callerTabId: caller } : {}),
      });
    },
  });
}

export function toAiSdkToolSet(
  defs: ToolDefinition[],
  providerOrOpts?: MapToolsOpts | ToolCallProvider,
): Record<string, Tool> {
  const normalized = normalizeOpts(providerOrOpts);
  const out: Record<string, Tool> = {};
  for (const def of defs) {
    out[def.name] = toAiSdkTool(def, normalized);
  }
  return out;
}
