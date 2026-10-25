import { t } from '@nomi-ai/ui';

/**
 * 主进程把上游流式错误压成 `[code] message`（ai-runtime/src/ai-sdk/streamError.ts，#78）：
 * 这里按 code 换成一句本地化的说明，原始 message 附在后面便于排查。不是这种格式返回 null。
 */
const LABELS: Record<string, () => string> = {
  upstream_channel_error: () =>
    t('ui.chat-settings.the-upstream-channel-request-failed-try-again-later'),
  upstream_error: () => t('ui.chat-settings.the-upstream-service-returned-an-error-try-again'),
  server_error: () => t('ui.chat-settings.the-upstream-service-returned-an-error-try-again-d7649e'),
  rate_limit_exceeded: () => t('ui.chat-settings.too-many-requests-the-upstream-is-rate-limiting'),
  insufficient_quota: () => t('ui.chat-settings.the-upstream-account-is-out-of-quota-check'),
  invalid_api_key: () => t('ui.chat-settings.the-api-key-is-invalid-check-it-in'),
  model_not_found: () => t('ui.chat-settings.the-upstream-doesn-t-have-this-model-pick'),
  context_length_exceeded: () =>
    t('ui.chat-settings.the-conversation-exceeds-the-model-s-context-length'),
};

export function upstreamErrorText(message: string): string | null {
  const m = /^\[([A-Za-z0-9_.-]+)\]\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return null;
  const [, code, detail] = m;
  const label = LABELS[code!]?.();
  if (label) return detail ? `${label}（${code}：${detail}）` : `${label}（${code}）`;
  return t('ui.chat-settings.upstream-error', code!, detail || code!);
}
