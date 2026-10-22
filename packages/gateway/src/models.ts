/**
 * GET /v1/models、/v1beta/models：只列已启用供应商的已启用模型，id 为 provider/model（§10.1）。
 */
import type { GatewayConfig } from './config';

function refs(
  cfg: GatewayConfig,
): Array<{ id: string; label: string; ctx?: number; maxOutput?: number }> {
  return cfg.providers
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models
        .filter((m) => m.enabled)
        .map((m) => ({
          id: `${p.id}/${m.id}`,
          label: `${p.name} / ${m.label ?? m.id}`,
          ctx: m.ctx,
          maxOutput: m.maxOutput,
        })),
    );
}

export function modelsBody(cfg: GatewayConfig, format: 'openai' | 'anthropic' | 'gemini'): unknown {
  const list = refs(cfg);
  if (format === 'anthropic')
    return {
      data: list.map((m) => ({
        type: 'model',
        id: m.id,
        display_name: m.label,
        created_at: '1970-01-01T00:00:00Z',
      })),
      has_more: false,
      first_id: list[0]?.id ?? null,
      last_id: list.at(-1)?.id ?? null,
    };
  if (format === 'gemini')
    return {
      models: list.map((m) => ({
        name: `models/${m.id}`,
        baseModelId: m.id,
        displayName: m.label,
        ...(m.ctx ? { inputTokenLimit: m.ctx } : {}),
        ...(m.maxOutput ? { outputTokenLimit: m.maxOutput } : {}),
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
      })),
    };
  return {
    object: 'list',
    data: list.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.id.split('/')[0],
    })),
  };
}
