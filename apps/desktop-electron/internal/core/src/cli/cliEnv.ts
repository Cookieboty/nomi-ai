/**
 * 启动 Claude Code / Codex / dsh 子进程时的环境变量。
 *
 * 隔离原则：Nomi 自己的供应商（ai-providers.json）从不写入 process.env；
 * 这里再把 Nomi 内部使用的变量剔除，避免它们泄漏给 CLI。
 * 用户自己 shell 里的 ANTHROPIC_* / OPENAI_* 等保持原样（与在终端运行 CLI 一致）。
 */

/** 属于 Nomi 内部、不应传给 CLI 的变量前缀 */
const INTERNAL_PREFIXES = ['NOMI_', 'COMPANION_', 'IG_', 'CD_'];
/** Nomi 内部使用的精确变量名 */
const INTERNAL_NAMES = new Set(['MCP_SERVERS', 'MCP_AUTO_CONNECT']);
/** 例外：测试用模拟 CLI 需要读取 */
const KEEP_PREFIXES = ['NOMI_MOCK_'];

export function isNomiInternalEnv(name: string): boolean {
  if (KEEP_PREFIXES.some((p) => name.startsWith(p))) return false;
  return INTERNAL_NAMES.has(name) || INTERNAL_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * @param base 通常是 process.env
 * @param extra 该后端自己的变量（例如 dsh 供应商启用时的 NOMI_DSH_API_KEY），最后覆盖
 */
export function buildCliEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || isNomiInternalEnv(k)) continue;
    out[k] = v;
  }
  return { ...out, NO_COLOR: '1', ...extra };
}
