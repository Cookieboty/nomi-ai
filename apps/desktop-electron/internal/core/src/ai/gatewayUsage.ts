import { GATEWAY_PROVIDER_ID } from '@nomi-ai/ai-runtime';

/** 网关调用的用量：`nomi-gateway` + `deepseek/deepseek-v4-pro` → `deepseek` + `deepseek-v4-pro` */
export function splitGatewayUsage(
  providerId: string,
  model: string,
): { provider: string; model: string } {
  const i = model.indexOf('/');
  if (providerId !== GATEWAY_PROVIDER_ID || i <= 0) return { provider: providerId, model };
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}
