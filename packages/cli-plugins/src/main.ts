/**
 * 主进程入口：全部内置插件（清单 + 主进程实现工厂）。只能在主进程 import（依赖 node:*）。
 */
import type { CliPlugin } from '@nomi-ai/cli-sdk';

import { plugin as claude } from './claude/main';
import { plugin as codex } from './codex/main';
import { plugin as dsh } from './dsh/main';
import { plugin as gemini } from './gemini/main';
import type { BuiltinCliId } from './generated/ids';
import { plugin as grok } from './grok/main';

export const BUILTIN_PLUGINS: Readonly<Record<BuiltinCliId, CliPlugin>> = {
  claude,
  codex,
  dsh,
  gemini,
  grok,
};

// 与 CLI 无关的纯函数（档位降级 / 原生模式映射、终端命令转义），主进程也从这里取
export * from './shared/permissions';
export * from './shared/terminal';
export { BUILTIN_CLI_IDS, type BuiltinCliId } from './generated/ids';

// 各 CLI 的流式输出解析（§5.4）：主进程的 cli/streamParse.ts 只转出这些
export { acpMetaContext, inputText, outputText, parseUsage } from './shared/stream';
export { createClaudeParser, parseClaudeLine, type ClaudeStreamState } from './claude/stream';
export { parseCodexLine } from './codex/stream';
export { createDshParser, parseDshLine } from './dsh/stream';
export { createGrokParser, parseGrokLine } from './grok/stream';

// 各 CLI 的历史转录解析（§5.7）：主进程的 cli/historyTranscript.ts 只转出这些
export { HISTORY_MAX_MESSAGES, titleFromMessages } from './shared/transcript';
export { cleanTitle } from './shared/text';
export { foldGeminiChat, geminiText, type GeminiChat } from './gemini/chat';
export { parseClaudeTranscript } from './claude/transcript';
export { parseCodexTranscript } from './codex/transcript';
export { parseDshTranscript } from './dsh/transcript';
export { parseGeminiTranscript } from './gemini/transcript';
export { parseGrokTranscript } from './grok/transcript';

// 各 CLI 的模型目录解析（标签级覆盖用）：主进程的 cli/modelCatalog.ts 只转出这些
export { parseClaudeModels } from './claude/models';
export { parseCodexModels, readCodexConfigDefaults } from './codex/models';
export { parseGrokModels } from './grok/models';

export * as claude from './claude/main';
export * as codex from './codex/main';
export * as dsh from './dsh/main';
export * as gemini from './gemini/main';
export * as grok from './grok/main';
