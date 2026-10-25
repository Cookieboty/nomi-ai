/**
 * CLI 用量 → 质量账本 tokens.input（未命中缓存的输入）。
 * Codex 的 inputTokens 已含 cached；其它 CLI 的 input 已是未缓存（#122）。
 */
export function qualityLedgerInput(
  client: string,
  usage: { inputTokens?: number; cacheReadTokens?: number },
): number | undefined {
  if (usage.inputTokens === undefined) return undefined;
  // Codex app-server 把 cached 算进 input_tokens；质量账本要「未缓存 + cacheRead」分列
  // eslint-disable-next-line nomi/no-cli-literal -- Codex 用量字段口径特例（#122）；待 plugin.usage 统一后再去掉
  if (client === 'codex' && usage.cacheReadTokens !== undefined) {
    return Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  }
  return usage.inputTokens;
}
