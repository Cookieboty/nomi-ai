/**
 * schema 驱动的纯函数：默认值 / 约束求解 / 布局 / 夹取 / 跨模型迁移 / schema 合法性校验。
 * 思路借鉴 Autix 的 constraints + schema-form-logic，按 Nomi 的需求重写（不依赖 ajv，可进前端包）。
 */
import type {
  MediaModelSpec,
  MediaParams,
  ParamSchema,
  ParamValue,
  ParamsSchema,
  UiSurface,
} from './types';

export interface ResolvedField extends ParamSchema {
  key: string;
}

export interface ResolvedSchema {
  /** 命中条件后的有效约束（enum / minimum / maximum 已收紧） */
  props: Record<string, ParamSchema>;
  hidden: Set<string>;
}

function ruleMatches(guards: Record<string, { const: ParamValue }>, params: MediaParams): boolean {
  const entries = Object.entries(guards);
  return entries.length > 0 && entries.every(([k, g]) => params[k] === g.const);
}

/** 按当前取值求有效约束；后面的规则覆盖前面的 */
export function resolveConstraints(schema: ParamsSchema, params: MediaParams): ResolvedSchema {
  const props: Record<string, ParamSchema> = {};
  for (const [k, s] of Object.entries(schema.properties)) props[k] = { ...s };
  const hidden = new Set<string>();
  for (const rule of schema.allOf ?? []) {
    if (!ruleMatches(rule.if.properties, params)) continue;
    for (const [k, o] of Object.entries(rule.then.properties ?? {})) {
      const cur = props[k];
      if (!cur) continue;
      if (o.enum !== undefined) cur.enum = o.enum;
      if (o.minimum !== undefined) cur.minimum = o.minimum;
      if (o.maximum !== undefined) cur.maximum = o.maximum;
    }
    for (const h of rule.then['x-hidden'] ?? []) hidden.add(h);
  }
  return { props, hidden };
}

export function schemaDefaults(spec: MediaModelSpec): MediaParams {
  const p: MediaParams = {};
  for (const [k, s] of Object.entries(spec.paramsSchema.properties))
    if (s.default !== undefined) p[k] = s.default;
  return p;
}

export interface ClampNote {
  key: string;
  kind: 'enum-fallback' | 'max' | 'min' | 'type' | 'dropped';
  value: ParamValue | undefined;
}

function coerce(s: ParamSchema, v: ParamValue): ParamValue | undefined {
  switch (s.type) {
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
    case 'integer':
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) return undefined;
      return s.type === 'integer' ? Math.round(n) : n;
    }
    default:
      return typeof v === 'string' ? v : String(v);
  }
}

/**
 * 把参数夹回有效约束内（未知字段丢弃、类型纠正、enum 回落默认、数值夹到边界）。
 * 条件约束可能连锁（改 A → 收紧 B → B 变化又命中别的规则），最多迭代 3 轮到不动点。
 * 不修改入参，返回新对象与提示。
 */
export function clampParams(
  spec: MediaModelSpec,
  input: MediaParams,
): { params: MediaParams; notes: ClampNote[] } {
  const base = spec.paramsSchema.properties;
  const p: MediaParams = {};
  const notes: ClampNote[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    const s = base[k];
    if (!s) {
      notes.push({ key: k, kind: 'dropped', value: v });
      continue;
    }
    const c = coerce(s, v);
    if (c === undefined) {
      notes.push({ key: k, kind: 'type', value: s.default });
      if (s.default !== undefined) p[k] = s.default;
    } else p[k] = c;
  }
  for (let round = 0; round < 3; round++) {
    let changed = false;
    const { props } = resolveConstraints(spec.paramsSchema, p);
    for (const [k, s] of Object.entries(props)) {
      const v = p[k];
      if (v === undefined) continue;
      if (s.enum && !s.enum.includes(v)) {
        const fb = s.default !== undefined && s.enum.includes(s.default) ? s.default : s.enum[0];
        p[k] = fb;
        notes.push({ key: k, kind: 'enum-fallback', value: fb });
        changed = true;
      } else if (typeof v === 'number') {
        if (s.maximum !== undefined && v > s.maximum) {
          p[k] = s.maximum;
          notes.push({ key: k, kind: 'max', value: s.maximum });
          changed = true;
        } else if (s.minimum !== undefined && v < s.minimum) {
          p[k] = s.minimum;
          notes.push({ key: k, kind: 'min', value: s.minimum });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { params: p, notes };
}

/** 某个字段被用户改动：先写入再夹取（界面交互用） */
export function clampOnChange(
  spec: MediaModelSpec,
  params: MediaParams,
  key: string,
  value: ParamValue | undefined,
): { params: MediaParams; notes: ClampNote[] } {
  return clampParams(spec, { ...params, [key]: value });
}

/** schema 默认 ← 我的默认 ← 覆盖值，最后夹取 */
export function initialParams(
  spec: MediaModelSpec,
  userDefaults?: MediaParams,
  override?: MediaParams,
): MediaParams {
  return clampParams(spec, { ...schemaDefaults(spec), ...userDefaults, ...override }).params;
}

/**
 * 换模型（或同模型 schema 升级）时迁移参数：目标 schema 中同名字段保留，其余取目标默认，再夹取。
 * 返回保留下来的字段与被丢弃的字段，界面可提示。
 */
export function migrateParams(
  to: MediaModelSpec,
  old: MediaParams,
  userDefaults?: MediaParams,
): { params: MediaParams; kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const carry: MediaParams = {};
  for (const [k, v] of Object.entries(old)) {
    if (v === undefined) continue;
    if (k in to.paramsSchema.properties) {
      carry[k] = v;
      kept.push(k);
    } else dropped.push(k);
  }
  return { params: initialParams(to, userDefaults, carry), kept, dropped };
}

export interface LayoutResult {
  basic: ResolvedField[];
  advanced: ResolvedField[];
  hidden: string[];
}

/** 表单布局：按 order 排序、分基础 / 高级、去掉条件隐藏的；surface 给定时只取该界面的字段 */
export function layoutProperties(
  spec: MediaModelSpec,
  params: MediaParams,
  surface?: UiSurface,
): LayoutResult {
  const { props, hidden } = resolveConstraints(spec.paramsSchema, params);
  const fields = Object.entries(props)
    .filter(([k]) => !hidden.has(k))
    .filter(([, s]) => !surface || (s['x-ui'].surface ?? ['studio']).includes(surface))
    .map(([key, s]) => ({ ...s, key }))
    .sort((a, b) => a['x-ui'].order - b['x-ui'].order);
  return {
    basic: fields.filter((f) => !f['x-ui'].advanced),
    advanced: fields.filter((f) => f['x-ui'].advanced),
    hidden: [...hidden],
  };
}

/** spec 合法性：随版本打包的 schema 在测试里逐个校验，防止写错约束 */
export function validateSpec(spec: MediaModelSpec): string[] {
  const errs: string[] = [];
  const props = spec.paramsSchema.properties;
  if (!spec.id) errs.push('missing id');
  if (!Number.isInteger(spec.schemaVersion) || spec.schemaVersion < 1)
    errs.push('schemaVersion must be a positive integer');
  for (const [k, s] of Object.entries(props)) {
    if (!s['x-ui']) errs.push(`${k}: missing x-ui`);
    if (s.enum && !s.enum.length) errs.push(`${k}: empty enum`);
    if (s.default !== undefined && s.enum && !s.enum.includes(s.default))
      errs.push(`${k}: default not in enum`);
    if (s.minimum !== undefined && s.maximum !== undefined && s.minimum > s.maximum)
      errs.push(`${k}: minimum > maximum`);
    if (typeof s.default === 'number') {
      if (s.minimum !== undefined && s.default < s.minimum) errs.push(`${k}: default < minimum`);
      if (s.maximum !== undefined && s.default > s.maximum) errs.push(`${k}: default > maximum`);
    }
    if ((s['x-ui']?.control === 'chips' || s['x-ui']?.control === 'select') && !s.enum)
      errs.push(`${k}: ${s['x-ui'].control} needs enum`);
  }
  (spec.paramsSchema.allOf ?? []).forEach((r, i) => {
    const guards = Object.entries(r.if?.properties ?? {});
    if (!guards.length) errs.push(`allOf[${i}]: empty if`);
    for (const [k, g] of guards) {
      if (!props[k]) errs.push(`allOf[${i}]: unknown guard ${k}`);
      if (!g || !('const' in g)) errs.push(`allOf[${i}]: guard ${k} must be const`);
    }
    for (const [k, o] of Object.entries(r.then?.properties ?? {})) {
      const base = props[k];
      if (!base) {
        errs.push(`allOf[${i}]: unknown then ${k}`);
        continue;
      }
      if (o.enum && base.enum && o.enum.some((v) => !base.enum!.includes(v)))
        errs.push(`allOf[${i}]: ${k} enum must narrow`);
      if (o.maximum !== undefined && base.maximum !== undefined && o.maximum > base.maximum)
        errs.push(`allOf[${i}]: ${k} maximum must narrow`);
      if (o.minimum !== undefined && base.minimum !== undefined && o.minimum < base.minimum)
        errs.push(`allOf[${i}]: ${k} minimum must narrow`);
    }
    for (const h of r.then?.['x-hidden'] ?? [])
      if (!props[h]) errs.push(`allOf[${i}]: unknown hidden ${h}`);
  });
  return errs;
}

/**
 * 对话工具参数：所有 spec 中 surface 含 chat 的字段并集（全部可选）。
 * 同名字段跨模型取值不同，因此只给描述，执行时按所选 spec 归一化 + 夹取。
 */
export function chatToolFields(
  specs: MediaModelSpec[],
): Record<string, { type: ParamSchema['type']; options: ParamValue[]; labels: string[] }> {
  const out: Record<
    string,
    { type: ParamSchema['type']; options: ParamValue[]; labels: string[] }
  > = {};
  for (const spec of specs)
    for (const [k, s] of Object.entries(spec.paramsSchema.properties)) {
      if (!(s['x-ui'].surface ?? []).includes('chat')) continue;
      const f = (out[k] ??= { type: s.type, options: [], labels: [] });
      if (!f.labels.includes(s['x-ui'].label)) f.labels.push(s['x-ui'].label);
      for (const v of s.enum ?? []) if (!f.options.includes(v)) f.options.push(v);
    }
  return out;
}
