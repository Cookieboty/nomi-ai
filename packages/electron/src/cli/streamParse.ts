/**
 * 各 CLI 流式输出的解析搬进了内置插件（@nomi-ai/cli-plugins 的 <cli>/stream，§5.4）；
 * 这里只转出，保留原来的 import 路径。
 */
import './pluginI18n';

export {
  acpMetaContext,
  createClaudeParser,
  createDshParser,
  createGrokParser,
  inputText,
  outputText,
  parseClaudeLine,
  parseCodexLine,
  parseDshLine,
  parseGrokLine,
  parseUsage,
  type ClaudeStreamState,
} from '@nomi-ai/cli-plugins/main';
