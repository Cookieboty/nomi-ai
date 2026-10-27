/**
 * 去程脱敏（docs/design/secret-privacy.md §6）：按路径遍历入口请求体，只替换字符串叶子里命中的片段。
 *
 * - 协议字段、id、签名、加密推理、媒体不动；
 * - 工具调用参数照遮，里面的键名一律不豁免（参数是模型写的，`signature`、`user_id` 里装的是用户数据）；
 * - 工具定义与结构化输出只遮 `description`（其余被供应商当结构读，遮坏了就是 400）；
 * - 未命中时返回原对象（结构共享），命中时只复制命中路径上的节点。
 */
import { allowTagOf } from './placeholder';
import { mergeSpans, ruleSpans, type SecretSpan } from './rules';
import type { SecretStore } from './store';

export type PrivacyAction = 'mask' | 'warn' | 'block';

export interface MaskOptions {
  /** 占位符 HMAC 密钥（与 store 用的同一个） */
  key: string;
  strict?: boolean;
  /** 按类型的动作；没列出的是 mask */
  actions?: Record<string, 'warn' | 'block'>;
  /** 「从不脱敏」名单的标记（allowTagOf） */
  allow?: ReadonlySet<string>;
}

/** 一个值的命中记录：不带原文，只有类型、长度与开头几个字符 */
export interface RedactionHit {
  kind: string;
  placeholder: string;
  action: PrivacyAction;
  len: number;
  head: string;
  /** 去程遮了几处（warn 时是发现了几处） */
  masked: number;
  /** 回程还原了几处 */
  restored: number;
  /** 这个值的「从不脱敏」标记（allowTagOf）：界面上点「这不是密钥」时主进程存它，不存原文 */
  allowTag: string;
}

export interface MaskResult {
  body: unknown;
  hits: RedactionHit[];
  /** 这个请求里遮掉的：占位符 → 原文（回程只还原这些） */
  restore: Map<string, string>;
  /** 有设为拦截的值 */
  blocked: boolean;
}

/** 字符串值原样保留的字段（协议字段、签名、加密内容、媒体） */
const KEPT = new Set([
  'signature',
  'encrypted_content',
  'data',
  'thoughtSignature',
  'thought_signature',
  'model',
  'type',
  'role',
  'name',
  'namespace',
  'server_label',
  'server_name',
  'previous_response_id',
  'prompt_cache_key',
  'media_type',
  'mime_type',
  'mimeType',
  'url',
  'image_url',
  'file_id',
  'reasoning_effort',
  'effort',
  'stop_reason',
  'finish_reason',
  'status',
  'object',
  'event',
  'service_tier',
  'user',
  'safety_identifier',
]);

/** 值是工具定义 / 结构化输出 / 请求设置的字段：下面只遮 description */
const DEFS = new Set([
  'tools',
  'functions',
  'tool_choice',
  'toolConfig',
  'response_format',
  'input_schema',
  'parameters',
  'output_schema',
  'responseSchema',
  'response_schema',
  'responseJsonSchema',
  'generationConfig',
  'grammar',
]);

/** 值是对象时才算设置的字段（字符串时是正文：Messages 的 text 块、thinking 块） */
const DEFS_IF_OBJECT = new Set(['text', 'format', 'reasoning', 'thinking']);

/** 带工具调用参数的块类型 */
const TOOL_USE_TYPES = new Set([
  'tool_use',
  'server_tool_use',
  'mcp_tool_use',
  'custom_tool_call',
  'function_call',
]);

/** 键名指 id：供应商要拿它和另一处对上，后端要按它查数据 */
export function isIdKey(key: string): boolean {
  return (
    key === 'id' ||
    key === 'ids' ||
    key.endsWith('_id') ||
    key.endsWith('_ids') ||
    key.endsWith('Id') ||
    key.endsWith('Ids')
  );
}

type Mode = 'normal' | 'args' | 'defs';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 签名过的推理块：整块不动（改了正文签名就对不上） */
function sealed(o: Obj): boolean {
  return o.type === 'thinking' || o.type === 'redacted_thinking' || o.thought === true;
}

function modeOf(mode: Mode, key: string, parent: Obj, value: unknown): Mode {
  if (mode !== 'normal') return mode;
  if (key === 'arguments' || key === 'args') return 'args';
  if (key === 'input' && TOOL_USE_TYPES.has(parent.type as string)) return 'args';
  if (DEFS.has(key)) return 'defs';
  if (DEFS_IF_OBJECT.has(key) && value !== null && typeof value === 'object') return 'defs';
  return 'normal';
}

/** 字符串里的 JSON 转义还原成原文（工具参数是 JSON 字符串，值在里面是转义过的） */
function unescapeJson(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** 一个请求的脱敏过程 */
class Masking {
  readonly hits = new Map<string, RedactionHit>();
  readonly restore = new Map<string, string>();
  blocked = false;

  constructor(
    private readonly store: SecretStore,
    private readonly opts: MaskOptions,
  ) {}

  walk(v: unknown, key: string, mode: Mode): unknown {
    if (typeof v === 'string') return this.leaf(v, key, mode);
    if (Array.isArray(v)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        const y = this.walk(x, key, mode);
        if (y !== x) (out ??= v.slice())[i] = y;
      }
      return out ?? v;
    }
    if (!isObj(v)) return v;
    if (mode === 'normal' && sealed(v)) return v;
    let out: Obj | null = null;
    // Messages 的纯文本文档（document.source = { type: 'text', data }）：data 是正文，不是媒体
    const textSource = mode === 'normal' && v.type === 'text' && typeof v.data === 'string';
    for (const k of Object.keys(v)) {
      const x = v[k];
      const y =
        textSource && k === 'data' && (x as string).length >= 8
          ? this.text(x as string)
          : this.walk(x, k, modeOf(mode, k, v, x));
      if (y !== x) (out ??= { ...v })[k] = y;
    }
    return out ?? v;
  }

  private leaf(s: string, key: string, mode: Mode): string {
    if (s.length < 8 || s.startsWith('data:')) return s;
    if (mode === 'defs' && key !== 'description') return s;
    if (mode === 'normal' && (KEPT.has(key) || isIdKey(key))) return s;
    if (mode === 'args' && key === 'arguments') return this.encodedArgs(s);
    return this.text(s);
  }

  /**
   * 协议把工具参数编成 JSON 字符串（Chat tool_calls / Responses function_call）：值里的引号、反斜线
   * 已经转义，登记的原文不再是连续子串。能解析就在参数树上按原值识别，再编码回去（#151）；
   * 解析不了（流式残片、非 JSON 的自定义输入）按转义文本扫描。
   */
  private encodedArgs(s: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      return this.text(s, true);
    }
    if (parsed === null || typeof parsed !== 'object') return this.text(s, true);
    const out = this.walk(parsed, '', 'args');
    return out === parsed ? s : JSON.stringify(out);
  }

  /** @param escaped 文本是 JSON 字符串的内容（工具参数），值按反转义后的原文登记 */
  text(s: string, escaped = false): string {
    const rules = ruleSpans(s, { strict: this.opts.strict });
    const known = this.store.find(s);
    if (!rules.length && !known.length) return s;
    const spans = mergeSpans([...known, ...rules]);
    let out = '';
    let at = 0;
    for (const sp of spans) {
      const raw = s.slice(sp.start, sp.end);
      const value = escaped ? unescapeJson(raw) : raw;
      if (this.opts.allow?.size && this.opts.allow.has(allowTagOf(this.opts.key, value))) continue;
      const action: PrivacyAction = this.opts.actions?.[sp.kind] ?? 'mask';
      const p = this.store.assign(sp.kind, value);
      this.note(sp, value, p, action);
      if (action === 'warn') continue;
      if (action === 'block') this.blocked = true;
      this.restore.set(p, value);
      out += s.slice(at, sp.start) + p;
      at = sp.end;
    }
    return at === 0 ? s : out + s.slice(at);
  }

  private note(sp: SecretSpan, value: string, p: string, action: PrivacyAction): void {
    const had = this.hits.get(p);
    if (had) {
      had.masked++;
      return;
    }
    this.hits.set(p, {
      kind: sp.kind,
      placeholder: p,
      action,
      len: value.length,
      head: value.slice(0, Math.min(4, Math.floor(value.length / 4))),
      masked: 1,
      restored: 0,
      allowTag: allowTagOf(this.opts.key, value),
    });
  }
}

/** 脱敏一个入口请求体（与入口协议无关：四种协议共用一套路径规则） */
export function maskBody(body: unknown, store: SecretStore, opts: MaskOptions): MaskResult {
  const m = new Masking(store, opts);
  const out = m.walk(body, '', 'normal');
  return { body: out, hits: [...m.hits.values()], restore: m.restore, blocked: m.blocked };
}

/** 脱敏一段文本（预览、测试用） */
export function maskText(
  s: string,
  store: SecretStore,
  opts: MaskOptions,
): Omit<MaskResult, 'body'> & { text: string } {
  const m = new Masking(store, opts);
  const text = m.text(s);
  return { text, hits: [...m.hits.values()], restore: m.restore, blocked: m.blocked };
}
