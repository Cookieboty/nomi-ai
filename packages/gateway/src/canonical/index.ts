/**
 * 规范化层入口（docs/design/cli-plugin-architecture.md §6.4）：让每种协议的事件流满足规范表（spec/）。
 * 只做协议有效性（白名单、必填字段、序号、结束检测、字段归一），不做模型相关的结构修复
 * （那在 NormEvent 上做，models/rules/response）。
 */
export { ChatChunkNormalizer } from './chat';
export {
  completeResponsesBody,
  completeResponsesUsage,
  isResponsesKeepAlive,
  NOTE_RESPONSES_DROPPED,
  NOTE_RESPONSES_FILLED,
  ResponsesCanonicalizer,
} from './responses';
export { TerminalWatch, type CanonicalWire } from './terminal';
