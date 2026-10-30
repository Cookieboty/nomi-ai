import type { DeepPartial } from '../../seams/userProfile';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 递归合并；数组直接覆盖（用户偏好里数组一般是「集合」语义，覆盖即完全替换）。
 */
export function deepMerge<T extends object>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const b = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(b[k])) {
      b[k] = deepMerge(b[k] as Record<string, unknown>, v as DeepPartial<Record<string, unknown>>);
    } else {
      b[k] = v;
    }
  }
  return base;
}
