/**
 * count_tokens 的本地估算（docs/design/unified-gateway.md §10.3 第 3 步）：上游不能算时的兜底。
 * CJK 字符约 1.5 字/token，其余约 4 字符/token；结果向上取 5%，宁可稍早压缩。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    )
      cjk++;
  }
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + rest / 4));
}

/** 整个请求体的估算（序列化后计数，含工具定义与 system） */
export function estimateRequestTokens(body: unknown): number {
  return Math.ceil(estimateTokens(JSON.stringify(body ?? {})) * 1.05);
}
