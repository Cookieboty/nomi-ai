/**
 * 工具 schema 清理器（§6.9.6，P7.1）：按模型规格的 tools.schema 选，而不是按「是不是官方接口」。
 * - gemini：Gemini 的 `parameters` 只接受 OpenAPI 子集；能表达时保持 `parameters`，表达不了
 *   （$ref、oneOf、allOf、const、additionalProperties…）就整份改用 `parametersJsonSchema`（完整 JSON Schema），
 *   两者不能同时出现（cc-switch 的双通道做法）；
 * - kimi / deepseek：内联本地 `$ref`（去掉 $defs / definitions），这两家对引用的支持不稳定；
 * - openai-strict：工具声明了 `strict: true` 时，补 `additionalProperties: false`（严格模式的硬要求）；
 * - full：不动。
 * 通用的 $schema / examples 清理仍在 generic 供应商适配器里（只对第三方上游）。
 */
import type { Wire } from '../../../ir';
import { mapToolSchemas } from '../../../providers/generic';
import type { EffectiveModel } from '../../types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Gemini parameters（OpenAPI 子集）接受的关键字 */
const GEMINI_KEYWORDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
]);

/** schema 能不能用 Gemini 的 parameters 表达（properties 下面是属性名，不检查） */
export function geminiExpressible(s: unknown): boolean {
  if (Array.isArray(s)) return s.every(geminiExpressible);
  if (!isObj(s)) return true;
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_KEYWORDS.has(k)) return false;
    if (k === 'properties' && isObj(v)) {
      if (!Object.values(v).every(geminiExpressible)) return false;
    } else if ((k === 'items' || k === 'anyOf') && !geminiExpressible(v)) return false;
    // type 是数组（["string","null"]）的 Gemini 不认
    if (k === 'type' && Array.isArray(v)) return false;
  }
  return true;
}

/** 内联本地 $ref（#/$defs/x、#/definitions/x）；循环引用时保留原 $ref */
export function inlineRefs(schema: unknown): unknown {
  if (!isObj(schema)) return schema;
  const defs: Obj = {
    ...(isObj(schema.definitions) ? schema.definitions : {}),
    ...(isObj(schema.$defs) ? schema.$defs : {}),
  };
  if (!Object.keys(defs).length) return schema;
  const walk = (v: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, seen));
    if (!isObj(v)) return v;
    const ref =
      typeof v.$ref === 'string' ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(v.$ref) : null;
    if (ref && defs[ref[1]!] !== undefined && !seen.has(ref[1]!)) {
      const { $ref: _r, ...rest } = v;
      const target = walk(defs[ref[1]!], new Set([...seen, ref[1]!]));
      return isObj(target) ? { ...target, ...rest } : target;
    }
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '$defs' || k === 'definitions') continue;
      out[k] = walk(x, seen);
    }
    return out;
  };
  return walk(schema, new Set());
}

function strictObjects(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strictObjects);
  if (!isObj(s)) return s;
  const out: Obj = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] =
      k === 'properties' && isObj(v)
        ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, strictObjects(x)]))
        : strictObjects(v);
  }
  if (out.type === 'object' && out.additionalProperties === undefined)
    out.additionalProperties = false;
  return out;
}

/** 按模型规格清理工具 schema（就地改 o.tools）；返回是否改过 */
export function cleanSchemas(wire: Wire, o: Obj, m: EffectiveModel, notes: string[]): boolean {
  const variant = m.tools?.schema;
  if (!variant || variant === 'full' || !Array.isArray(o.tools)) return false;
  const before = JSON.stringify(o.tools);
  if (variant === 'gemini' && wire === 'gemini') {
    o.tools = o.tools.map((t) => {
      if (!isObj(t) || !Array.isArray(t.functionDeclarations)) return t;
      return {
        ...t,
        functionDeclarations: t.functionDeclarations.map((d) => {
          if (!isObj(d) || d.parameters === undefined || geminiExpressible(d.parameters)) return d;
          const { parameters, ...rest } = d;
          return { ...rest, parametersJsonSchema: parameters };
        }),
      };
    });
  } else if (variant === 'kimi' || variant === 'deepseek') {
    mapToolSchemas(o, wire, inlineRefs);
  } else if (variant === 'openai-strict') {
    o.tools = o.tools.map((t) => {
      if (!isObj(t)) return t;
      const strict = t.strict === true || (isObj(t.function) && t.function.strict === true);
      if (!strict) return t;
      const one: Obj = { tools: [t] };
      mapToolSchemas(one, wire, strictObjects);
      return (one.tools as unknown[])[0];
    });
  }
  const changed = JSON.stringify(o.tools) !== before;
  if (changed) notes.push(`工具 schema 已按 ${variant} 规则改写`);
  return changed;
}
