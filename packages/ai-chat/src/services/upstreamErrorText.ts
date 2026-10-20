import { t } from '@nomi-ai/ui';

/**
 * 主进程把上游流式错误压成 `[code] message`（ai-runtime/src/ai-sdk/streamError.ts，#78）：
 * 这里按 code 换成一句本地化的说明，原始 message 附在后面便于排查。不是这种格式返回 null。
 */
const LABELS: Record<string, () => string> = {
  upstream_channel_error: () => t('上游通道请求失败，可以稍后重试或换一个模型 / 供应商'),
  upstream_error: () => t('上游服务出错，可以稍后重试或换一个模型 / 供应商'),
  server_error: () => t('上游服务出错，可以稍后重试'),
  rate_limit_exceeded: () => t('请求太频繁，被上游限流了，请稍后再试'),
  insufficient_quota: () => t('上游账户额度不足，请检查余额或换一个供应商'),
  invalid_api_key: () => t('API Key 无效，请到供应商设置里检查'),
  model_not_found: () => t('上游找不到这个模型，请换一个模型'),
  context_length_exceeded: () => t('对话太长，超出了模型的上下文长度，请新开会话或精简内容'),
};

export function upstreamErrorText(message: string): string | null {
  const m = /^\[([A-Za-z0-9_.-]+)\]\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const [, code, detail] = m;
  const label = LABELS[code!]?.();
  if (label) return detail ? `${label}（${code}：${detail}）` : `${label}（${code}）`;
  return t('上游返回错误（{0}）：{1}', code!, detail || code!);
}
