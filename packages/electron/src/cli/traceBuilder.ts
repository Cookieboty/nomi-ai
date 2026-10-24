/** 轨迹整理搬到 @nomi-ai/cli-sdk（插件的历史转录解析也用）；这里只转出 */
export {
  buildTrace,
  compactOldTraces,
  isTraceEvent,
  KEEP_FULL_TRACE_MESSAGES,
  MAX_TAB_FILE_BYTES,
  MAX_TRACE_BYTES,
  MAX_TRACE_EVENTS,
  mergeUsage,
  stampEvent,
} from '@nomi-ai/cli-sdk';
