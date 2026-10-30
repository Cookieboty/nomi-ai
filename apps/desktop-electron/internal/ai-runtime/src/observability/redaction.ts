/**
 * 敏感字段脱敏中间件
 *
 * 对齐 P9 计划 §P9-1：日志/事件里所有 `apiKey / authorization / token / email / password /
 * cookie / api_key / access_token / refresh_token / bearer` 相关字段（大小写不敏感）
 * 都会被替换为 `***`，避免用户密钥落盘。
 *
 * 设计要点：
 * - **仅结构性遍历**：不做字符串扫描（避免误伤合法内容）；仅按 key 名判定；
 * - **循环引用防御**：内部维护 WeakSet，命中过的对象跳过；
 * - **数组/对象递归**，其他基本类型直接返回；
 * - **不修改原对象**：始终返回新对象/新数组，与调用方共享的引用不被污染；
 * - **深度上限**：默认 8 层，超过截断为字面量 `'[Truncated]'`。
 */

const DEFAULT_SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'bearer',
  'cookie',
  'set-cookie',
  'email',
] as const;

export interface RedactOptions {
  /** 额外敏感字段（大小写不敏感） */
  extraKeys?: readonly string[];
  /** 替换文本，默认 `***` */
  placeholder?: string;
  /** 最大递归深度，默认 8 */
  maxDepth?: number;
}

const REDACTED = '***';
const TRUNCATED = '[Truncated]';
const CIRCULAR = '[Circular]';

/**
 * 返回一个复用配置的 redact 函数。热路径调用只需付出一次配置成本。
 */
export function createRedactor(opts: RedactOptions = {}): (input: unknown) => unknown {
  const placeholder = opts.placeholder ?? REDACTED;
  const maxDepth = opts.maxDepth ?? 8;
  const keySet = new Set<string>();
  for (const k of DEFAULT_SENSITIVE_KEYS) keySet.add(k.toLowerCase());
  for (const k of opts.extraKeys ?? []) keySet.add(String(k).toLowerCase());

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= maxDepth) return TRUNCATED;
    if (seen.has(value as object)) return CIRCULAR;
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1, seen));
    }

    if (value instanceof Date || value instanceof RegExp) return value;
    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      try {
        return walk((value as { toJSON: () => unknown }).toJSON(), depth + 1, seen);
      } catch {
        // toJSON 抛错时保持原样；避免污染日志
      }
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const source = (value as Record<string, unknown>)[key];
      if (keySet.has(key.toLowerCase())) {
        out[key] = source === undefined || source === null ? source : placeholder;
      } else {
        out[key] = walk(source, depth + 1, seen);
      }
    }
    return out;
  };

  return (input) => walk(input, 0, new WeakSet());
}

/** 便捷函数：使用默认配置 redact 一次。 */
export function redact(input: unknown, opts: RedactOptions = {}): unknown {
  return createRedactor(opts)(input);
}

/** 便捷常量：默认覆盖的敏感字段（大小写不敏感）。 */
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = DEFAULT_SENSITIVE_KEYS;
