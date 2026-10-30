// 由 scripts/gen-ids.mjs 生成，不要手改（pnpm -F @nomi-ai/cli-catalog gen:ids）

/** 内置插件的 id（目录名） */
export const BUILTIN_CLI_IDS = ['claude', 'codex', 'dsh', 'gemini', 'grok'] as const;

export type BuiltinCliId = (typeof BUILTIN_CLI_IDS)[number];
