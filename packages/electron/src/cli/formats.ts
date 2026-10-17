/**
 * Claude Code / Codex / dsh / Grok 上游协议（与 CLI 原生协议对照；非原生格式需本地路由转换）。
 */

export const CLAUDE_API_FORMATS = [
  'anthropic_messages',
  'openai_chat_completions',
  'openai_responses',
  'gemini_generate_content',
] as const;
export type ClaudeApiFormat = (typeof CLAUDE_API_FORMATS)[number];

export const CODEX_API_FORMATS = [
  'openai_responses',
  'openai_chat_completions',
  'anthropic_messages',
] as const;
export type CodexApiFormat = (typeof CODEX_API_FORMATS)[number];

export type CliApiFormat = ClaudeApiFormat | CodexApiFormat;

export const CLAUDE_FORMAT_LABELS: Record<ClaudeApiFormat, string> = {
  anthropic_messages: 'Anthropic Messages（原生）',
  openai_chat_completions: 'OpenAI Chat Completions（需开启路由）',
  openai_responses: 'OpenAI Responses API（需开启路由）',
  gemini_generate_content: 'Gemini Native generateContent（需开启路由）',
};

export const CODEX_FORMAT_LABELS: Record<CodexApiFormat, string> = {
  openai_responses: 'Responses（原生）',
  openai_chat_completions: 'Chat Completions（需开启路由）',
  anthropic_messages: 'Anthropic Messages（需开启路由）',
};

export function isClaudeApiFormat(v: unknown): v is ClaudeApiFormat {
  return typeof v === 'string' && (CLAUDE_API_FORMATS as readonly string[]).includes(v);
}

export function isCodexApiFormat(v: unknown): v is CodexApiFormat {
  return typeof v === 'string' && (CODEX_API_FORMATS as readonly string[]).includes(v);
}

/** Claude Code 原生发 Anthropic Messages；Codex 原生发 Responses */
export function claudeFormatNeedsRouting(f: ClaudeApiFormat): boolean {
  return f !== 'anthropic_messages';
}

export function codexFormatNeedsRouting(f: CodexApiFormat): boolean {
  return f !== 'openai_responses';
}

export type CliFormatKind = 'claude' | 'codex' | 'dsh' | 'grok';

export function formatNeedsRouting(kind: CliFormatKind, format: CliApiFormat): boolean {
  // dsh / Grok 配置层原生支持多种上游协议，均无需本地路由
  if (kind === 'dsh' || kind === 'grok') return false;
  return kind === 'claude'
    ? claudeFormatNeedsRouting(format as ClaudeApiFormat)
    : codexFormatNeedsRouting(format as CodexApiFormat);
}

export function defaultFormat(kind: CliFormatKind): CliApiFormat {
  if (kind === 'dsh' || kind === 'grok') return 'openai_responses';
  return kind === 'claude' ? 'anthropic_messages' : 'openai_responses';
}

/**
 * dsh 内置适配器原生支持三种上游协议，均无需本地路由。
 */
export const DSH_API_FORMATS = [
  'openai_responses',
  'openai_chat_completions',
  'anthropic_messages',
] as const;
export type DshApiFormat = (typeof DSH_API_FORMATS)[number];

export const DSH_FORMAT_LABELS: Record<DshApiFormat, string> = {
  openai_responses: 'OpenAI Responses（原生）',
  openai_chat_completions: 'OpenAI Chat Completions（原生）',
  anthropic_messages: 'Anthropic Messages（原生）',
};

export function isDshApiFormat(v: unknown): v is DshApiFormat {
  return typeof v === 'string' && (DSH_API_FORMATS as readonly string[]).includes(v);
}

/** Nomi 格式名 → dsh 配置中的 api 名 */
export function dshApiName(f: DshApiFormat): string {
  return f === 'openai_responses'
    ? 'openai-responses'
    : f === 'anthropic_messages'
      ? 'anthropic-messages'
      : 'openai-completions';
}

/**
 * Grok Build（`~/.grok/config.toml` 的 `api_backend`）原生支持三种上游协议，均无需本地路由。
 * 见 docs.x.ai/build/settings：chat_completions | responses | messages。
 */
export const GROK_API_FORMATS = [
  'openai_responses',
  'openai_chat_completions',
  'anthropic_messages',
] as const;
export type GrokApiFormat = (typeof GROK_API_FORMATS)[number];

export const GROK_FORMAT_LABELS: Record<GrokApiFormat, string> = {
  openai_responses: 'OpenAI Responses（原生）',
  openai_chat_completions: 'OpenAI Chat Completions（原生）',
  anthropic_messages: 'Anthropic Messages（原生）',
};

export function isGrokApiFormat(v: unknown): v is GrokApiFormat {
  return typeof v === 'string' && (GROK_API_FORMATS as readonly string[]).includes(v);
}

/** Nomi 格式名 → Grok config.toml 的 api_backend */
export function grokApiBackend(f: GrokApiFormat): 'responses' | 'chat_completions' | 'messages' {
  return f === 'openai_responses'
    ? 'responses'
    : f === 'anthropic_messages'
      ? 'messages'
      : 'chat_completions';
}
