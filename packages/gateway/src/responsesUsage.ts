/**
 * 兼容入口：Responses 流的补全已移到规范化层（canonical/responses.ts，§6.4），
 * 事件全集在规范表（spec/responses.ts）。
 */
export {
  completeResponsesBody,
  completeResponsesUsage,
  isResponsesKeepAlive,
  ResponsesCanonicalizer,
  ResponsesCanonicalizer as ResponsesUsagePatcher,
} from './canonical/responses';
export { RESPONSES_EVENTS } from './spec/responses';
