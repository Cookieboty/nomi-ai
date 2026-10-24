/**
 * 各 CLI 会话文件 → 可见对话：解析搬进了内置插件（@nomi-ai/cli-plugins 的 <cli>/transcript，§5.7）；
 * 这里只转出，并按后端分派。
 */
import {
  parseClaudeTranscript,
  parseCodexTranscript,
  parseDshTranscript,
  parseGeminiTranscript,
  parseGrokTranscript,
  type BuiltinCliId,
} from '@nomi-ai/cli-plugins/main';

import './pluginI18n';
import type { HarnessTabMessage } from './types';

export {
  HISTORY_MAX_MESSAGES,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseDshTranscript,
  parseGeminiTranscript,
  parseGrokTranscript,
  titleFromMessages,
} from '@nomi-ai/cli-plugins/main';

export type HistoryBackend = BuiltinCliId;

const PARSERS: Record<HistoryBackend, (text: string, fallbackAt?: number) => HarnessTabMessage[]> =
  {
    claude: parseClaudeTranscript,
    codex: parseCodexTranscript,
    dsh: parseDshTranscript,
    gemini: parseGeminiTranscript,
    grok: parseGrokTranscript,
  };

export function parseTranscript(
  backend: HistoryBackend,
  text: string,
  fallbackAt = 0,
): HarnessTabMessage[] {
  return PARSERS[backend](text, fallbackAt);
}
