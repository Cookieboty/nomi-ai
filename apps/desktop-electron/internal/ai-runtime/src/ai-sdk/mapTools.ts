/**
 * Map `@nomi-ai/bundle-ig-base` ToolDefinition → Vercel AI SDK `tool()`.
 */
import type { ToolCallProvider, ToolDefinition, ToolTurn } from '@nomi-ai/bundle-ig-base';
import { getToolCallerTabId } from '@nomi-ai/bundle-ig-base';
import { asSchema, jsonSchema, tool, type FlexibleSchema, type Tool } from 'ai';

/** 发给模型的 schema 去掉 `$schema`（每个工具省十几个 token，模型用不上） */
function stripMeta<T>(s: T): T {
  if (s && typeof s === 'object' && '$schema' in s) {
    const { $schema: _drop, ...rest } = s as Record<string, unknown>;
    return rest as T;
  }
  return s;
}

function toFlexibleSchema(input: unknown) {
  // ToolDefinition.input is a zod schema, AI SDK Schema (jsonSchema()), or raw JSON Schema.
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if ('safeParse' in o || 'validate' in o || '~standard' in o) {
      const s = asSchema(input as FlexibleSchema<unknown>);
      return jsonSchema(
        async () => stripMeta(await s.jsonSchema),
        s.validate ? { validate: (v) => s.validate!(v) } : {},
      );
    }
    if ('type' in o || 'properties' in o || '$schema' in o) {
      return jsonSchema(stripMeta(input) as never);
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
  /** 发起本轮的 Nomi 会话 id（后台委派完成落盘，#116） */
  conversationId?: string;
  /** Nomi 对话选的工作区（视图带来，工具侧再校验）；没有时不提供 requiresWorkspace 的工具 */
  cwd?: string;
  /** 本轮用户最后说的话（命令自动审核用） */
  userText?: string;
  /** 整段对话文本（小写）：给 ToolDefinition.relevant 判断这一轮用不用得上 */
  convoText?: string;
};

function isMapToolsOpts(v: unknown): v is MapToolsOpts {
  return (
    !!v &&
    typeof v === 'object' &&
    ('provider' in v ||
      'reqId' in v ||
      'callerTabId' in v ||
      'conversationId' in v ||
      'cwd' in v ||
      'userText' in v ||
      'convoText' in v) &&
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
  const { provider, reqId, callerTabId, conversationId, cwd, userText } =
    normalizeOpts(providerOrOpts);
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
        ...(conversationId ? { conversationId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(userText ? { userText } : {}),
      });
    },
  });
}

/** available() 抛错按不可用处理（不让一个工具的判断拖垮整轮对话） */
function safeAvailable(def: ToolDefinition): boolean {
  try {
    return def.available!() !== false;
  } catch {
    return false;
  }
}

/** relevant() 抛错按用得上处理（宁可多带一个工具，也不让模型缺工具） */
function safeRelevant(def: ToolDefinition, turn: ToolTurn): boolean {
  try {
    return def.relevant!(turn) !== false;
  } catch {
    return true;
  }
}

export function toAiSdkToolSet(
  defs: ToolDefinition[],
  providerOrOpts?: MapToolsOpts | ToolCallProvider,
): Record<string, Tool> {
  const normalized = normalizeOpts(providerOrOpts);
  const out: Record<string, Tool> = {};
  // 不知道这一轮说了什么（非对话调用）时不按需裁剪
  const gate = normalized.convoText !== undefined || normalized.userText !== undefined;
  const turn: ToolTurn = {
    userText: normalized.userText ?? '',
    convoText: normalized.convoText ?? (normalized.userText ?? '').toLowerCase(),
    ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
  };
  for (const def of defs) {
    if (def.requiresWorkspace && !normalized.cwd) continue;
    if (def.available && !safeAvailable(def)) continue;
    if (gate && def.relevant && !safeRelevant(def, turn)) continue;
    out[def.name] = toAiSdkTool(def, normalized);
  }
  return out;
}
