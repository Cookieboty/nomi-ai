/**
 * 日志脱敏：结构性遍历，按 key 名（大小写不敏感）把敏感字段替换为 ***。
 * 不做字符串扫描；带循环引用防御与深度上限；不修改原对象。
 * 内置实现以避免 LoggerService 依赖 ai-runtime barrel（jest 环境无法加载其 ESM 依赖）。
 */

const SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'api-key',
  'x-api-key',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'password',
  'passwd',
  'secret',
  'appsecret',
  'app-secret',
  'credential',
  'token',
  'bearer',
  'cookie',
  'set-cookie',
  'email',
] as const;

const REDACTED = '***';
const TRUNCATED = '[Truncated]';
const CIRCULAR = '[Circular]';
const MAX_DEPTH = 8;

const keySet = new Set<string>(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value as object)) return CIRCULAR;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen));
  }

  if (value instanceof Date || value instanceof RegExp) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const source = (value as Record<string, unknown>)[key];
    if (keySet.has(key.toLowerCase())) {
      out[key] = source === undefined || source === null ? source : REDACTED;
    } else {
      out[key] = walk(source, depth + 1, seen);
    }
  }
  return out;
}

export function redact(input: unknown): unknown {
  return walk(input, 0, new WeakSet());
}
