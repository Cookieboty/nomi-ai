import type {
  ClaudeApiFormat,
  CliProviderKind,
  CodexApiFormat,
} from '../../services/cliProviderClient';
import type { Protocol } from '../../services/providerClient';

type Fmt = ClaudeApiFormat | CodexApiFormat;

/** 由接口地址推测品牌图标（老档案没有 presetId 时使用）；认不出返回 undefined（显示首字母） */
export function inferBrand(baseUrl: string): string | undefined {
  let host = '';
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    host = baseUrl.toLowerCase();
  }
  const table: Array<[RegExp, string]> = [
    [/(^|\.)openai\.com$/, 'openai'],
    [/(^|\.)anthropic\.com$/, 'anthropic'],
    [/generativelanguage\.googleapis\.com$/, 'gemini'],
    [/(^|\.)deepseek\.com$/, 'deepseek'],
    [/moonshot\.(cn|ai)$/, 'kimi'],
    [/bigmodel\.cn$|z\.ai$/, 'zhipu'],
    [/dashscope|aliyuncs\.com$/, 'qwen'],
    [/volces\.com$|volcengine/, 'doubao'],
    [/minimax/, 'minimax'],
    [/(^|\.)x\.ai$/, 'xai'],
    [/openrouter\.ai$/, 'openrouter'],
    [/siliconflow/, 'siliconflow'],
    [/^(localhost|127\.0\.0\.1):11434$/, 'ollama'],
    [/^(localhost|127\.0\.0\.1):1234$/, 'lmstudio'],
  ];
  return table.find(([re]) => re.test(host))?.[1];
}

/**
 * Nomi 预设的协议 → CLI 档案的上游格式（仅作参考映射；新建档案默认用
 * CLI_DEFAULT_FORMAT，不要用本函数覆盖端点原生格式）。
 */
export function presetFormat(protocol: Protocol): Fmt {
  if (protocol === 'anthropic') return 'anthropic_messages';
  if (protocol === 'openai-responses') return 'openai_responses';
  return 'openai_chat_completions';
}

/** 该端点的原生上游格式 */
export function nativeFormat(kind: CliProviderKind, f: string): boolean {
  if (kind === 'dsh' || kind === 'grok') return true;
  return kind === 'claude' ? f === 'anthropic_messages' : f === 'openai_responses';
}
