/**
 * Token 粗估：上游没有返回 usage 时的兜底（界面上会标「估算」）。
 * 规则：CJK 字符约 1.5 字/token，其余约 4 字符/token；只求量级正确，不求精确。
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
