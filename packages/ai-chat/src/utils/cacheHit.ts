/**
 * 前缀缓存命中率 = 缓存读 / 全部输入。只用于 Nomi 自己的用量：内核报的输入 token 已含缓存读写
 * （Anthropic 的 input + cache_creation + cache_read；OpenAI 兼容的 prompt_tokens 本来就含 cached_tokens）。
 * 编程助手各家口径不一（有的输入不含缓存读），不在这里算。
 */
export function cacheHitRate(input?: number, cacheRead?: number): number | undefined {
  if (!input || input <= 0 || cacheRead === undefined || cacheRead < 0) return undefined;
  return Math.min(1, cacheRead / input);
}

export const formatHitRate = (r: number): string => `${Math.round(r * 100)}%`;
