/** 一次成功调用的明细（用量与计费面板的数据源）；输入 token 为总数（含缓存部分） */
export interface UsageCallEvent {
  providerId: string;
  model: string;
  /** 请求开始时间（ms） */
  at: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** true = 上游没返回 usage，数值为估算 */
  estimated: boolean;
  reqId?: string;
}
