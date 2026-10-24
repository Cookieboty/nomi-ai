/**
 * generic 供应商适配器（§6.3）：所有第三方上游都可能有的通用问题，原 fixes.ts 的供应商部分。
 * - 工具 schema 清理（$schema、examples）：官方接口（规格 native）不做；
 * - Messages 上游不是 Anthropic 官方：对话里的 system 消息并进顶层 system、服务端工具去掉、
 *   Anthropic 专有字段（output_config、context_management）去掉；
 * - Chat 上游的工具名映射（^[a-zA-Z0-9_-]{1,64}$，回程还原）；
 * - quirks.extraBody：按上游协议合并进请求体的额外字段。
 * 只做外科式改写，作用在调用方给的浅拷贝上。
 */
import type { Wire } from '../ir';
import type { Candidate } from '../route/resolve';
import { mapChatToolNames } from '../toolNames';

import type { ProviderContext, ProviderSpec } from './types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------- 服务端工具 ------------------------------- */

/** Anthropic 服务端工具（在 Anthropic 那边执行）：web_search_*、web_fetch_*、code_execution_* */
const SERVER_TOOL_RE = /^(web_search|web_fetch|code_execution)_/;

export const SERVER_TOOL_UNSUPPORTED = '当前模型不支持联网搜索';

function isServerTool(t: unknown): t is Obj {
  return isObj(t) && typeof t.type === 'string' && SERVER_TOOL_RE.test(t.type);
}

/** Messages 请求是「单独发起的服务端工具请求」：工具只有服务端工具，或 tool_choice 强制用其中一个 */
export function isDedicatedServerToolRequest(o: Obj): boolean {
  const tools = Array.isArray(o.tools) ? o.tools : [];
  const server = tools.filter(isServerTool);
  if (!server.length) return false;
  if (server.length === tools.length) return true;
  const tc = o.tool_choice;
  return isObj(tc) && tc.type === 'tool' && server.some((t) => t.name === tc.name);
}

/**
 * 服务端工具的预检（§12.7.3）：上游不是 Anthropic 官方、而请求是单独发起的服务端工具请求时，
 * 返回给用户的错误（不发请求，避免静默返回一个没有搜索结果的回答）；否则 null。
 */
export function serverToolErrorFor(
  c: Candidate,
  native: ProviderSpec['native'],
  ingress: Wire,
  body: unknown,
): string | null {
  if (ingress !== 'messages' || native === 'anthropic' || !isObj(body)) return null;
  return isDedicatedServerToolRequest(body)
    ? `${SERVER_TOOL_UNSUPPORTED}（${c.provider.name}）`
    : null;
}

/** 与普通工具混在一起的服务端工具：从上游副本里去掉 */
function dropServerTools(o: Obj, notes: string[]): void {
  if (!Array.isArray(o.tools) || isDedicatedServerToolRequest(o)) return;
  const kept = o.tools.filter((t) => !isServerTool(t));
  if (kept.length === o.tools.length) return;
  const names = o.tools
    .filter(isServerTool)
    .map((t) => String(t.name ?? t.type))
    .join('、');
  o.tools = kept;
  notes.push(`服务端工具 ${names} 已去掉（上游不是 Anthropic 官方）`);
}

/* ------------------------------- 工具 schema ------------------------------- */

/** 值是「名字 → schema」映射的关键字 */
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
/** 值是 schema 或 schema 数组的关键字 */
const SCHEMA_KEYS = new Set([
  'items',
  'prefixItems',
  'additionalItems',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'anyOf',
  'oneOf',
  'allOf',
]);
/** 第三方上游常拒绝的关键字 */
const STRIP_KEYWORDS = new Set(['$schema', 'examples']);

/** 去掉 schema 里第三方常拒绝的关键字（$schema、examples），只认 schema 结构，不碰属性名和取值 */
export function cleanToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanToolSchema);
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    if (STRIP_KEYWORDS.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, cleanToolSchema(s)]));
    } else if (SCHEMA_KEYS.has(k)) {
      out[k] = cleanToolSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 按协议找到每个工具的 schema 字段，用 clean 改写 */
export function mapToolSchemas(o: Obj, wire: Wire, clean: (s: unknown) => unknown): void {
  if (!Array.isArray(o.tools)) return;
  const fix = (t: Obj, key: string): Obj => (key in t ? { ...t, [key]: clean(t[key]) } : t);
  o.tools = o.tools.map((t) => {
    if (!isObj(t)) return t;
    switch (wire) {
      case 'messages':
        return fix(t, 'input_schema');
      case 'responses':
        return fix(t, 'parameters');
      case 'chat':
        return isObj(t.function) ? { ...t, function: fix(t.function, 'parameters') } : t;
      case 'gemini':
        return Array.isArray(t.functionDeclarations)
          ? {
              ...t,
              functionDeclarations: t.functionDeclarations.map((d) =>
                isObj(d) ? fix(fix(d, 'parameters'), 'parametersJsonSchema') : d,
              ),
            }
          : t;
    }
  });
}

/* ------------------------------- Messages 专有 ------------------------------- */

function textOf(content: unknown): Obj[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.filter((b): b is Obj => isObj(b) && b.type === 'text');
  return [];
}

/** messages 里的 role:"system" 合并进顶层 system（按出现顺序追加） */
function mergeSystemMessages(o: Obj, notes: string[]): void {
  const msgs = o.messages;
  if (!Array.isArray(msgs) || !msgs.some((m) => isObj(m) && m.role === 'system')) return;
  const sys = msgs.filter((m): m is Obj => isObj(m) && m.role === 'system');
  o.messages = msgs.filter((m) => !(isObj(m) && m.role === 'system'));
  const allStrings =
    (o.system === undefined || typeof o.system === 'string') &&
    sys.every((m) => typeof m.content === 'string');
  if (allStrings) {
    o.system = [o.system, ...sys.map((m) => m.content)].filter((s) => s).join('\n\n');
  } else {
    o.system = [...textOf(o.system), ...sys.flatMap((m) => textOf(m.content))];
  }
  notes.push(`${sys.length} 条对话中的 system 消息已合并进顶层 system`);
}

const ANTHROPIC_ONLY_FIELDS = ['output_config', 'context_management'];

/** 第三方 Messages 上游不认识的 anthropic-beta 项 */
export function filterAnthropicBeta(beta: string): string {
  return beta
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^context-1m-/i.test(s) && !/^context-management-/i.test(s))
    .join(',');
}

/* ------------------------------- 入口 ------------------------------- */

/** generic 的请求改写（所有规格都先过这一遍；规格自己的钩子在它之后） */
export function genericRequest(wire: Wire, o: Obj, ctx: ProviderContext): void {
  const { native, quirks, notes } = ctx;
  if (!native) mapToolSchemas(o, wire, cleanToolSchema);
  if (wire === 'messages' && native !== 'anthropic') {
    mergeSystemMessages(o, notes);
    dropServerTools(o, notes);
    for (const k of ANTHROPIC_ONLY_FIELDS) {
      if (k in o) {
        delete o[k];
        notes.push(`${k} 已去掉（上游不是 Anthropic 官方）`);
      }
    }
  }
  // Chat 上游的工具名必须匹配 ^[a-zA-Z0-9_-]{1,64}$，回程在 respond 里还原（toolNames.ts）
  if (wire === 'chat' && quirks.fixes?.toolNames !== false) mapChatToolNames(o, notes);
  // 厂商要求的额外字段（quirks.extraBody），调用方随后再去掉 dropParams
  const extra = quirks.extraBody?.[wire];
  if (extra) Object.assign(o, extra);
}

export const generic: ProviderSpec = { id: 'generic', match: {} };
