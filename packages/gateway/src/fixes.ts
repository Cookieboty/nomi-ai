/**
 * 网关侧的请求修正（docs/design/unified-gateway.md §12.7.3）。
 * 作用在「真正发给上游的请求体」上：同协议透传与跨协议转换都要过一遍。
 * 只做外科式改写（浅拷贝被改动的那一层），不经过 IR，不改调用方传进来的对象。
 */
import type { RuntimeModel } from './config';
import type { Wire } from './ir';
import type { Candidate } from './route/resolve';

type Obj = Record<string, unknown>;

export const IMAGE_OMITTED_TEXT = '[图片已省略：当前模型不支持图片输入]';

/** Anthropic 扩展思考的最小预算 */
const MIN_THINKING_BUDGET = 1024;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function baseHost(c: Candidate): string {
  try {
    return new URL(c.provider.urls[c.wire] ?? '').hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 上游是 Anthropic 官方接口 */
export function isAnthropicOfficial(c: Candidate): boolean {
  return baseHost(c) === 'api.anthropic.com';
}

/** 上游是 OpenAI 官方接口 */
export function isOpenAIOfficial(c: Candidate): boolean {
  return baseHost(c) === 'api.openai.com';
}

/** 候选对应的模型元数据（按对外模型名在供应商的模型列表里找） */
export function candidateModel(c: Candidate): RuntimeModel | undefined {
  const id = c.publicModel.slice(c.provider.id.length + 1);
  return c.provider.models.find((m) => m.id === id);
}

/* ------------------------------- 工具数量 ------------------------------- */

/** 请求体里的工具个数（Gemini 按 functionDeclarations 合计） */
export function toolCount(wire: Wire, body: unknown): number {
  const tools = isObj(body) ? body.tools : undefined;
  if (!Array.isArray(tools)) return 0;
  if (wire !== 'gemini') return tools.length;
  let n = 0;
  for (const t of tools) {
    const fns = isObj(t) ? t.functionDeclarations : undefined;
    n += Array.isArray(fns) ? fns.length : 1;
  }
  return n;
}

/** 工具数超过 quirks.maxTools 时返回给用户的错误信息；没超过返回 null */
export function toolLimitError(c: Candidate, body: unknown): string | null {
  const max = c.provider.quirks?.maxTools;
  if (!max || max <= 0) return null;
  const n = toolCount(c.wire, body);
  return n > max
    ? `当前供应商一次最多支持 ${max} 个工具，这次请求带了 ${n} 个，请减少 MCP 工具`
    : null;
}

/* ------------------------------- 输出上限 / 推理 ------------------------------- */

const MAX_FIELDS = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'] as const;

function clampOutput(o: Obj, wire: Wire, maxOutput: number, notes: string[]): void {
  for (const k of MAX_FIELDS) {
    const v = o[k];
    if (typeof v === 'number' && v > maxOutput) {
      o[k] = maxOutput;
      notes.push(`${k} ${v} → ${maxOutput}`);
    }
  }
  if (wire === 'gemini' && isObj(o.generationConfig)) {
    const v = o.generationConfig.maxOutputTokens;
    if (typeof v === 'number' && v > maxOutput) {
      o.generationConfig = { ...o.generationConfig, maxOutputTokens: maxOutput };
      notes.push(`maxOutputTokens ${v} → ${maxOutput}`);
    }
  }
}

/** thinking.budget_tokens 必须小于 max_tokens：压低预算，放不下最小预算时去掉 thinking */
function fitThinkingBudget(o: Obj, notes: string[]): void {
  const t = o.thinking;
  const max = o.max_tokens;
  if (!isObj(t) || typeof t.budget_tokens !== 'number' || typeof max !== 'number') return;
  if (t.budget_tokens < max) return;
  const budget = max - Math.min(4096, Math.floor(max / 4));
  if (budget < MIN_THINKING_BUDGET) {
    delete o.thinking;
    notes.push(`thinking 已去掉（max_tokens ${max} 放不下推理预算）`);
  } else {
    o.thinking = { ...t, budget_tokens: budget };
    notes.push(`thinking.budget_tokens ${t.budget_tokens} → ${budget}`);
  }
}

function dropReasoning(o: Obj, wire: Wire, notes: string[]): void {
  const drop = (k: string) => {
    if (k in o) {
      delete o[k];
      notes.push(`${k} 已去掉（模型不支持推理）`);
    }
  };
  if (wire === 'messages') drop('thinking');
  else if (wire === 'chat' || wire === 'responses') {
    drop('reasoning');
    drop('reasoning_effort');
  } else if (isObj(o.generationConfig) && 'thinkingConfig' in o.generationConfig) {
    const { thinkingConfig: _t, ...rest } = o.generationConfig;
    o.generationConfig = rest;
    notes.push('thinkingConfig 已去掉（模型不支持推理）');
  }
}

/* ------------------------------- 图片 ------------------------------- */

function isImageMime(m: unknown): boolean {
  return typeof m !== 'string' || m.startsWith('image/');
}

/** 把一个内容数组里的图片换成占位文本；没有改动时返回原数组 */
function stripImageParts(wire: Wire, parts: unknown[], count: { n: number }): unknown[] {
  let changed = false;
  const out = parts.map((p) => {
    if (!isObj(p)) return p;
    if (wire === 'messages') {
      if (p.type === 'image') {
        changed = true;
        count.n++;
        return { type: 'text', text: IMAGE_OMITTED_TEXT };
      }
      if (p.type === 'tool_result' && Array.isArray(p.content)) {
        const inner = stripImageParts(wire, p.content, count);
        if (inner !== p.content) {
          changed = true;
          return { ...p, content: inner };
        }
      }
      return p;
    }
    if (wire === 'chat') {
      if (p.type === 'image_url') {
        changed = true;
        count.n++;
        return { type: 'text', text: IMAGE_OMITTED_TEXT };
      }
      return p;
    }
    if (wire === 'responses') {
      if (p.type === 'input_image') {
        changed = true;
        count.n++;
        return { type: 'input_text', text: IMAGE_OMITTED_TEXT };
      }
      return p;
    }
    // gemini
    const data = isObj(p.inlineData) ? p.inlineData : isObj(p.fileData) ? p.fileData : null;
    if (data && isImageMime(data.mimeType)) {
      changed = true;
      count.n++;
      return { text: IMAGE_OMITTED_TEXT };
    }
    return p;
  });
  return changed ? out : parts;
}

function stripImages(o: Obj, wire: Wire, notes: string[]): void {
  const count = { n: 0 };
  const listKey = wire === 'gemini' ? 'contents' : wire === 'responses' ? 'input' : 'messages';
  const list = o[listKey];
  if (!Array.isArray(list)) return;
  let changed = false;
  const next = list.map((item) => {
    if (!isObj(item)) return item;
    // Responses 的 function_call_output.output 也可以是内容数组
    const key = wire === 'gemini' ? 'parts' : Array.isArray(item.content) ? 'content' : 'output';
    const parts = item[key];
    if (!Array.isArray(parts)) return item;
    const stripped = stripImageParts(wire, parts, count);
    if (stripped === parts) return item;
    changed = true;
    return { ...item, [key]: stripped };
  });
  if (changed) {
    o[listKey] = next;
    notes.push(`已省略 ${count.n} 张图片（模型不支持图片输入）`);
  }
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

function cleanTools(o: Obj, wire: Wire): void {
  if (!Array.isArray(o.tools)) return;
  const fix = (t: Obj, key: string): Obj =>
    key in t ? { ...t, [key]: cleanToolSchema(t[key]) } : t;
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

/**
 * 对发给上游的请求体做 §12.7.3 的修正，返回浅拷贝（不改传进来的对象）。
 * notes 收集做了哪些修正（记进用量 / 日志）。
 */
export function applyRequestFixes(c: Candidate, body: unknown, notes: string[] = []): unknown {
  if (!isObj(body)) return body;
  const o: Obj = { ...body };
  const wire = c.wire;
  const model = candidateModel(c);

  if (model?.maxOutput && model.maxOutput > 0) clampOutput(o, wire, model.maxOutput, notes);
  if (model?.reasoning === false) dropReasoning(o, wire, notes);
  if (wire === 'messages') fitThinkingBudget(o, notes);
  if (model?.vision === false) stripImages(o, wire, notes);
  if (!isAnthropicOfficial(c) && !isOpenAIOfficial(c)) cleanTools(o, wire);
  if (wire === 'messages' && !isAnthropicOfficial(c)) {
    mergeSystemMessages(o, notes);
    for (const k of ANTHROPIC_ONLY_FIELDS) {
      if (k in o) {
        delete o[k];
        notes.push(`${k} 已去掉（上游不是 Anthropic 官方）`);
      }
    }
  }
  return o;
}
